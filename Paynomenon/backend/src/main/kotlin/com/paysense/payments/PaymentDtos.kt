package com.paysense.payments

import io.swagger.v3.oas.annotations.media.Schema
import jakarta.validation.constraints.DecimalMin
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.NotNull
import jakarta.validation.constraints.Size
import java.math.BigDecimal
import java.time.Instant
import java.util.UUID

@Schema(description = "Request to create a payment. Amounts use decimal numbers; at most the currency's minor-unit precision is accepted.")
data class CreatePaymentRequest(
    @field:NotNull @field:DecimalMin("0.0001", message = "amount must be greater than zero") @Schema(example = "49.99")
    val amount: BigDecimal?,
    @field:NotBlank @field:Size(min = 3, max = 3) @Schema(example = "EUR")
    val currency: String?,
    @field:NotBlank @field:Size(max = 64) @Schema(example = "merchant-demo")
    val merchantId: String?,
    @field:NotBlank @field:Size(max = 32) @Schema(example = "MOCK_PROCESSOR")
    val processor: String?,
    @field:Size(max = 255) @Schema(example = "Demo purchase")
    val description: String? = null,
)

data class RefundRequest(
    @Schema(description = "Only full refunds are supported. If provided, it must equal the original amount.")
    val amount: BigDecimal? = null,
    @field:Size(max = 255) val reason: String? = null,
)

data class AttemptResponse(
    val id: UUID,
    val operation: String,
    val attemptNumber: Int,
    val processor: String,
    val processorRequestId: String,
    val status: String,
    val responseCode: String?,
    val failureCategory: String?,
    val responseTimeMs: Int?,
    val sanitizedResponse: Map<String, Any?>?,
    val correlationId: String,
    val startedAt: Instant,
    val completedAt: Instant?,
)

data class PaymentResponse(
    val id: UUID,
    val merchantId: String,
    val amount: BigDecimal,
    val currency: String,
    val processor: String,
    val description: String?,
    val status: PaymentStatus,
    val pendingOperation: PaymentOperation?,
    val failureCode: String?,
    val failureCategory: String?,
    val correlationId: String,
    val synthetic: Boolean,
    val createdAt: Instant,
    val updatedAt: Instant,
    val authorizedAt: Instant?,
    val capturedAt: Instant?,
    val refundedAt: Instant?,
    val failedAt: Instant?,
    val attempts: List<AttemptResponse>? = null,
) {
    companion object {
        fun from(
            p: Payment,
            attempts: List<PaymentAttemptRecord>? = null,
        ) = PaymentResponse(
            p.id,
            p.merchantId,
            p.amount.stripTrailingZeros().let {
                if (it.scale() <
                    2
                ) {
                    it.setScale(2)
                } else {
                    it
                }
            },
            p.currency.trim(),
            p.processor,
            p.description,
            p.status,
            p.pendingOperation,
            p.failureCode,
            p.failureCategory,
            p.correlationId,
            p.synthetic,
            p.createdAt,
            p.updatedAt,
            p.authorizedAt,
            p.capturedAt,
            p.refundedAt,
            p.failedAt,
            attempts?.map {
                AttemptResponse(
                    it.id,
                    it.operation,
                    it.attemptNumber,
                    it.processor,
                    it.processorRequestId,
                    it.status,
                    it.responseCode,
                    it.failureCategory,
                    it.responseTimeMs,
                    it.sanitizedResponse,
                    it.correlationId,
                    it.startedAt,
                    it.completedAt,
                )
            },
        )
    }
}

data class PaymentEventResponse(
    val id: UUID,
    val sequence: Int,
    val eventType: String,
    val fromStatus: String?,
    val toStatus: String?,
    val source: String,
    val actor: String,
    val correlationId: String,
    val metadata: Map<String, Any?>,
    val occurredAt: Instant,
)
