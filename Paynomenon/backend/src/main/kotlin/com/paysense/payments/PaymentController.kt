package com.paysense.payments

import com.paysense.common.CorrelationId
import com.paysense.common.PageResponse
import com.paysense.common.ServiceUnavailableException
import com.paysense.idempotency.IdempotencyKeys
import com.paysense.idempotency.IdempotentExecutor
import com.paysense.idempotency.IdempotentResult
import com.paysense.security.CurrentUser
import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.Parameter
import io.swagger.v3.oas.annotations.tags.Tag
import jakarta.validation.Valid
import org.springframework.format.annotation.DateTimeFormat
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import java.time.Instant
import java.util.UUID

@RestController
@RequestMapping("/api/v1/payments")
@Tag(name = "Payments")
class PaymentController(
    private val creation: PaymentCreationService,
    private val operations: PaymentOperationService,
    private val queries: PaymentQueryService,
    private val idempotent: IdempotentExecutor,
) {
    @PostMapping
    @Operation(
        summary = "Create a payment",
        description = "Supports the Idempotency-Key header. Replays return the original response with Idempotent-Replayed: true.",
    )
    fun create(
        @RequestHeader("Idempotency-Key", required = false) key: String?,
        @Valid @RequestBody req: CreatePaymentRequest,
    ): ResponseEntity<Any> {
        val prepared = creation.prepare(req)
        val validKey = IdempotencyKeys.validate(key)
        val actor = CurrentUser.name()
        val fp =
            IdempotencyKeys.fingerprint(
                "POST /payments",
                prepared.money.toStorage().toPlainString(),
                prepared.money.currency,
                prepared.merchantId,
                prepared.processor,
                prepared.description,
            )
        return idempotent.atomic(actor, validKey, "POST /payments", fp) {
            val payment = creation.create(prepared, actor)
            IdempotentResult(201, PaymentResponse.from(payment), payment.id)
        }
    }

    @GetMapping
    fun list(
        @RequestParam(defaultValue = "0") page: Int,
        @RequestParam(defaultValue = "20") size: Int,
        @RequestParam(required = false) sort: String?,
        @RequestParam(required = false) status: PaymentStatus?,
        @RequestParam(required = false) processor: String?,
        @RequestParam(required = false) currency: String?,
        @RequestParam(required = false) merchantId: String?,
        @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) from: Instant?,
        @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) to: Instant?,
        @Parameter(
            description = "Free text: payment id, correlation id, merchant or description fragment",
        ) @RequestParam(required = false) q: String?,
    ): PageResponse<PaymentResponse> = queries.list(PaymentFilter(status, processor, currency, merchantId, from, to, q), page, size, sort)

    @GetMapping("/{id}")
    fun get(
        @PathVariable id: UUID,
    ): PaymentResponse = queries.get(id)

    @GetMapping("/{id}/events")
    fun events(
        @PathVariable id: UUID,
        @RequestParam(defaultValue = "0") page: Int,
        @RequestParam(defaultValue = "50") size: Int,
    ): PageResponse<PaymentEventResponse> = queries.events(id, page, size)

    @PostMapping("/{id}/authorize")
    fun authorize(
        @PathVariable id: UUID,
        @RequestHeader("Idempotency-Key", required = false) key: String?,
    ): ResponseEntity<Any> = operate(id, "authorize", key) { operations.authorize(id, CurrentUser.name(), CorrelationId.currentOrNew()) }

    @PostMapping("/{id}/capture")
    fun capture(
        @PathVariable id: UUID,
        @RequestHeader("Idempotency-Key", required = false) key: String?,
    ): ResponseEntity<Any> = operate(id, "capture", key) { operations.capture(id, CurrentUser.name(), CorrelationId.currentOrNew()) }

    @PostMapping("/{id}/cancel")
    @Operation(summary = "Cancel a payment that has not been captured")
    fun cancel(
        @PathVariable id: UUID,
    ): PaymentResponse = PaymentResponse.from(operations.cancel(id, CurrentUser.name(), CorrelationId.currentOrNew()))

    @PostMapping("/{id}/refund")
    @Operation(
        summary = "Refund a captured payment",
        description = "Full refunds only. The original payment amount is never modified; a reversing ledger transaction is posted.",
    )
    fun refund(
        @PathVariable id: UUID,
        @RequestHeader("Idempotency-Key", required = false) key: String?,
        @Valid @RequestBody(required = false) body: RefundRequest?,
    ): ResponseEntity<Any> =
        operate(id, "refund", key, body?.amount?.stripTrailingZeros()?.toPlainString()) {
            operations.refund(id, body?.amount, CurrentUser.name(), CorrelationId.currentOrNew())
        }

    /**
     * 200: operation completed (the payment may legitimately be FAILED after a decline).
     * 202: outcome uncertain (processor timeout); the payment is UNCERTAIN and will be reconciled.
     * 503: the processor was provably not reached; nothing changed, safe to retry (not stored for idempotent replay).
     */
    private fun operate(
        id: UUID,
        name: String,
        key: String?,
        extra: String? = null,
        call: () -> OperationResult,
    ): ResponseEntity<Any> {
        val validKey = IdempotencyKeys.validate(key)
        val actor = CurrentUser.name()
        val operation = "POST /payments/$id/$name"
        return idempotent.twoPhase(actor, validKey, operation, IdempotencyKeys.fingerprint(operation, extra)) {
            val result = call()
            when (result.kind) {
                OperationResultKind.NOT_EXECUTED ->
                    throw ServiceUnavailableException(
                        "PROCESSOR_UNAVAILABLE",
                        result.message ?: "The processor is unavailable; the payment was not changed. Retry later.",
                    )
                OperationResultKind.UNCERTAIN ->
                    IdempotentResult(202, PaymentResponse.from(result.payment, result.attempts), id)
                OperationResultKind.COMPLETED ->
                    IdempotentResult(200, PaymentResponse.from(result.payment, result.attempts), id)
            }
        }
    }
}
