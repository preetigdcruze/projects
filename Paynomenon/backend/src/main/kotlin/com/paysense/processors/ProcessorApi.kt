package com.paysense.processors

import com.paysense.common.Money
import com.paysense.payments.PaymentOperation
import java.util.UUID

data class ProcessorRequest(
    val processor: String,
    /** Processor-level idempotency key. Re-sending the same id must never execute the operation twice. */
    val requestId: String,
    val operation: PaymentOperation,
    val paymentReference: UUID,
    val amount: Money,
    val description: String?,
    val correlationId: String,
)

enum class ProcessorStatus { APPROVED, DECLINED, INVALID_REQUEST }

data class ProcessorResponse(
    val status: ProcessorStatus,
    val responseCode: String,
    /** Synthetic, sanitized text only. Treated as untrusted data by everything downstream. */
    val message: String,
    val processorTransactionId: String?,
    val latencyMs: Int,
)

enum class LookupStatus { APPROVED, DECLINED, NOT_FOUND }

data class LookupResult(
    val status: LookupStatus,
    val responseCode: String?,
)

/** The request may or may not have been executed by the processor. Callers must reconcile, not retry. */
class ProcessorTimeoutException(
    val requestId: String,
    val afterMs: Long,
) : RuntimeException("Processor did not answer request $requestId within ${afterMs}ms")

/** The processor was provably not reached or refused before executing. Safe to retry with the same request id. */
open class ProcessorUnavailableException(
    message: String,
    val code: String = "PROCESSOR_UNAVAILABLE",
) : RuntimeException(message)

interface PaymentProcessor {
    val name: String

    fun execute(request: ProcessorRequest): ProcessorResponse

    /** Read-only status query by processor request id; used to resolve uncertain outcomes. */
    fun lookup(requestId: String): LookupResult
}

/** Receives asynchronous notifications from a processor (webhooks). Implemented by the payments module. */
fun interface ProcessorCallbackSink {
    fun deliver(callback: ProcessorCallback)
}

data class ProcessorCallback(
    val processor: String,
    val callbackId: String,
    val paymentReference: UUID,
    val operation: PaymentOperation,
    val result: ProcessorStatus,
    val responseCode: String,
)
