package com.paysense.payments

import com.fasterxml.jackson.databind.ObjectMapper
import com.paysense.common.ApiException
import com.paysense.common.CorrelationId
import com.paysense.common.PaySenseProperties
import com.paysense.common.ValidationException
import com.paysense.observability.OperationalLogService
import com.paysense.processors.ProcessorCallback
import com.paysense.processors.ProcessorCallbackSink
import com.paysense.processors.ProcessorStatus
import io.swagger.v3.oas.annotations.tags.Tag
import org.springframework.http.HttpStatus
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import java.security.MessageDigest
import java.sql.Timestamp
import java.time.Clock
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

data class CallbackResult(
    val duplicate: Boolean,
    val applied: Boolean,
)

/**
 * Handles asynchronous processor notifications. Duplicate deliveries (processors retry webhooks) are detected by the
 * unique (processor, callback_id) row and acknowledged without any further effect.
 */
@Service
class PaymentCallbackService(
    private val jdbc: JdbcClient,
    private val payments: PaymentRepository,
    private val events: PaymentEventRepository,
    private val applier: PaymentOutcomeApplier,
    private val opLog: OperationalLogService,
    private val clock: Clock,
    txManager: PlatformTransactionManager,
) : ProcessorCallbackSink {
    private val tx = TransactionTemplate(txManager)

    override fun deliver(callback: ProcessorCallback) {
        handle(callback)
    }

    fun handle(cb: ProcessorCallback): CallbackResult {
        val result =
            tx.execute {
                val now = clock.instant()
                val payment = payments.lockById(cb.paymentReference)
                val inserted =
                    jdbc
                        .sql(
                            """
                INSERT INTO processor_callbacks (id, processor, callback_id, payment_id, event_type, applied, received_at)
                VALUES (:id, :p, :cid, :pid, :type, false, :now) ON CONFLICT (processor, callback_id) DO NOTHING
                """,
                        ).param("id", UUID.randomUUID())
                        .param("p", cb.processor)
                        .param("cid", cb.callbackId)
                        .param("pid", payment?.id)
                        .param("type", "${cb.operation}_${cb.result}")
                        .param("now", Timestamp.from(now))
                        .update()
                if (inserted == 0) return@execute CallbackResult(duplicate = true, applied = false)
                if (payment == null) return@execute CallbackResult(duplicate = false, applied = false)

                val correlation = CorrelationId.currentOrNew()
                events.append(
                    payment.id,
                    PaymentEventType.CALLBACK_RECEIVED,
                    payment.status,
                    payment.status,
                    EventSource.PROCESSOR_CALLBACK,
                    cb.processor,
                    correlation,
                    mapOf(
                        "callbackId" to cb.callbackId,
                        "operation" to cb.operation.name,
                        "result" to cb.result.name,
                        "responseCode" to cb.responseCode,
                    ),
                    now,
                )
                val applicable = payment.status == PaymentStatus.UNCERTAIN && payment.pendingOperation == cb.operation
                if (applicable) {
                    val outcome =
                        when (cb.result) {
                            ProcessorStatus.APPROVED -> OperationOutcome.Approved(cb.responseCode)
                            ProcessorStatus.DECLINED -> OperationOutcome.Declined(cb.responseCode, "declined per processor callback")
                            ProcessorStatus.INVALID_REQUEST -> OperationOutcome.Invalid(cb.responseCode, "invalid per processor callback")
                        }
                    applier.apply(
                        payment,
                        cb.operation,
                        outcome,
                        EventSource.PROCESSOR_CALLBACK,
                        cb.processor,
                        correlation,
                        mapOf("callbackId" to cb.callbackId),
                    )
                    jdbc
                        .sql(
                            "UPDATE processor_callbacks SET applied = true WHERE processor = :p AND callback_id = :cid",
                        ).param("p", cb.processor)
                        .param("cid", cb.callbackId)
                        .update()
                }
                CallbackResult(duplicate = false, applied = applicable)
            }!!
        if (result.duplicate) {
            opLog.record(
                "INFO",
                "callbacks",
                "Duplicate callback ${cb.callbackId} from ${cb.processor} ignored",
                paymentId = cb.paymentReference,
            )
        }
        return result
    }
}

data class CallbackRequest(
    val processor: String?,
    val callbackId: String?,
    val paymentId: UUID?,
    val operation: PaymentOperation?,
    val result: ProcessorStatus?,
    val responseCode: String?,
)

@RestController
@RequestMapping("/api/v1/processors/callbacks")
@Tag(name = "Processor callbacks")
class ProcessorCallbackController(
    private val service: PaymentCallbackService,
    private val props: PaySenseProperties,
    private val mapper: ObjectMapper,
) {
    /** Authenticated by HMAC-SHA256 of the raw body (header X-Signature, hex), as real processors do for webhooks. */
    @PostMapping
    fun receive(
        @RequestHeader("X-Signature", required = false) signature: String?,
        @RequestBody raw: String,
    ): CallbackResult {
        val expected = hmac(raw)
        if (signature == null || !MessageDigest.isEqual(expected.toByteArray(), signature.lowercase().toByteArray())) {
            throw ApiException(HttpStatus.UNAUTHORIZED, "INVALID_SIGNATURE", "Callback signature is missing or invalid")
        }
        val req =
            try {
                mapper.readValue(raw, CallbackRequest::class.java)
            } catch (e: Exception) {
                throw ValidationException("Malformed callback body")
            }
        if (req.processor.isNullOrBlank() || req.callbackId.isNullOrBlank() || req.paymentId == null || req.operation == null ||
            req.result == null
        ) {
            throw ValidationException("processor, callbackId, paymentId, operation and result are required")
        }
        return service.handle(
            ProcessorCallback(
                req.processor,
                req.callbackId.take(100),
                req.paymentId,
                req.operation,
                req.result,
                req.responseCode ?: req.result.name,
            ),
        )
    }

    fun hmac(body: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(props.security.callbackSecret.toByteArray(), "HmacSHA256"))
        return mac.doFinal(body.toByteArray()).joinToString("") { "%02x".format(it) }
    }
}
