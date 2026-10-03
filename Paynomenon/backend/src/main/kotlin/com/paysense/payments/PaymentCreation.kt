package com.paysense.payments

import com.paysense.common.CorrelationId
import com.paysense.common.Money
import com.paysense.common.PaySenseProperties
import com.paysense.events.DomainEventType
import com.paysense.events.OutboxWriter
import com.paysense.processors.ProcessorRegistry
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Clock

data class PreparedPayment(
    val money: Money,
    val merchantId: String,
    val processor: String,
    val description: String?,
)

@Service
class PaymentCreationService(
    private val payments: PaymentRepository,
    private val events: PaymentEventRepository,
    private val outbox: OutboxWriter,
    private val processors: ProcessorRegistry,
    private val props: PaySenseProperties,
    private val clock: Clock,
) {
    /** Semantic validation beyond bean validation: currency set, minor-unit precision, limits, known processor. */
    fun prepare(req: CreatePaymentRequest): PreparedPayment {
        val money = Money.of(req.amount, req.currency, props.payments.supportedCurrencies.toSet(), props.payments.maxAmount)
        processors.require(req.processor?.trim())
        return PreparedPayment(money, req.merchantId!!.trim(), req.processor!!.trim(), req.description?.trim()?.takeIf { it.isNotEmpty() })
    }

    /** Writes the payment, its first audit event and the PaymentCreated outbox row in the caller's transaction. */
    @Transactional
    fun create(
        prepared: PreparedPayment,
        actor: String,
        source: String = EventSource.API,
        synthetic: Boolean = false,
    ): Payment {
        val now = clock.instant()
        val correlationId = CorrelationId.currentOrNew()
        val payment =
            Payment(
                merchantId = prepared.merchantId,
                amount = prepared.money.toStorage(),
                currency = prepared.money.currency,
                processor = prepared.processor,
                description = prepared.description,
                status = PaymentStatus.CREATED,
                correlationId = correlationId,
                createdBy = actor,
                synthetic = synthetic,
                createdAt = now,
                updatedAt = now,
            )
        payments.saveAndFlush(payment)
        events.append(
            payment.id,
            PaymentEventType.PAYMENT_CREATED,
            null,
            PaymentStatus.CREATED,
            source,
            actor,
            correlationId,
            mapOf("amount" to payment.amount.toPlainString(), "currency" to payment.currency, "processor" to payment.processor),
            now,
        )
        outbox.append(DomainEventType.PaymentCreated, "payment", payment.id, PaymentEvents.payload(payment), correlationId)
        return payment
    }
}
