package com.paysense.payments

import com.paysense.events.DomainEventType
import com.paysense.events.OutboxWriter
import com.paysense.ledger.LedgerOperation
import com.paysense.ledger.LedgerService
import com.paysense.observability.PaySenseMetrics
import org.springframework.stereotype.Service
import java.time.Clock

/** What a processor interaction (or a later lookup/callback) established about an operation. */
sealed interface OperationOutcome {
    data class Approved(
        val responseCode: String,
    ) : OperationOutcome

    data class Declined(
        val code: String,
        val message: String,
    ) : OperationOutcome

    data class Invalid(
        val code: String,
        val message: String,
    ) : OperationOutcome

    /** Provably never executed by the processor; safe to try again. */
    data class NotExecuted(
        val code: String,
        val message: String,
    ) : OperationOutcome

    /** May or may not have executed. */
    data class Uncertain(
        val reason: String,
    ) : OperationOutcome
}

/**
 * Applies an operation outcome to a payment: state transition, audit event, ledger posting and outbox event.
 * Callers must hold the payment row lock and be inside a transaction, so everything here commits atomically.
 */
@Service
class PaymentOutcomeApplier(
    private val payments: PaymentRepository,
    private val events: PaymentEventRepository,
    private val outbox: OutboxWriter,
    private val ledger: LedgerService,
    private val metrics: PaySenseMetrics,
    private val clock: Clock,
) {
    fun apply(
        payment: Payment,
        operation: PaymentOperation,
        outcome: OperationOutcome,
        source: String,
        actor: String,
        correlationId: String,
        extra: Map<String, Any?> = emptyMap(),
    ) {
        val from = payment.status
        if (from == PaymentStatus.UNCERTAIN && outcome is OperationOutcome.Uncertain) return // still unknown

        val now = clock.instant()
        val target =
            when (outcome) {
                is OperationOutcome.Approved -> operation.succeedsTo
                is OperationOutcome.Declined, is OperationOutcome.Invalid -> operation.declinedTo
                is OperationOutcome.NotExecuted -> operation.revertsTo
                is OperationOutcome.Uncertain -> PaymentStatus.UNCERTAIN
            }
        if (from == PaymentStatus.UNCERTAIN) {
            check(target in PaymentStateMachine.resolutionTargets(operation)) { "invalid resolution target $target for $operation" }
        }
        payment.transitionTo(target, now)

        when (outcome) {
            is OperationOutcome.Approved -> {
                payment.pendingOperation = null
                payment.failureCode = null
                payment.failureCategory = null
                when (operation) {
                    PaymentOperation.AUTHORIZE -> payment.authorizedAt = now
                    PaymentOperation.CAPTURE -> payment.capturedAt = now
                    PaymentOperation.REFUND -> payment.refundedAt = now
                }
            }
            is OperationOutcome.Declined -> recordFailure(payment, outcome.code, "DECLINED", target, now)
            is OperationOutcome.Invalid -> recordFailure(payment, outcome.code, "INVALID_REQUEST", target, now)
            is OperationOutcome.NotExecuted -> {
                payment.pendingOperation = null
                payment.failureCode = outcome.code
                payment.failureCategory = "UNAVAILABLE"
            }
            is OperationOutcome.Uncertain -> payment.pendingOperation = operation
        }
        payments.saveAndFlush(payment)

        val eventType =
            when {
                from == PaymentStatus.UNCERTAIN -> PaymentEventType.OUTCOME_RESOLVED
                outcome is OperationOutcome.Approved -> PaymentEventType.OPERATION_SUCCEEDED
                outcome is OperationOutcome.Declined || outcome is OperationOutcome.Invalid -> PaymentEventType.OPERATION_DECLINED
                outcome is OperationOutcome.NotExecuted -> PaymentEventType.OPERATION_NOT_EXECUTED
                else -> PaymentEventType.OUTCOME_UNCERTAIN
            }
        val meta = linkedMapOf<String, Any?>("operation" to operation.name, "outcome" to outcome.javaClass.simpleName)
        when (outcome) {
            is OperationOutcome.Approved -> meta["responseCode"] = outcome.responseCode
            is OperationOutcome.Declined -> {
                meta["responseCode"] = outcome.code
                meta["message"] = outcome.message
            }
            is OperationOutcome.Invalid -> {
                meta["responseCode"] = outcome.code
                meta["message"] = outcome.message
            }
            is OperationOutcome.NotExecuted -> {
                meta["responseCode"] = outcome.code
                meta["message"] = outcome.message
            }
            is OperationOutcome.Uncertain -> meta["reason"] = outcome.reason
        }
        meta.putAll(extra)
        events.append(payment.id, eventType, from, target, source, actor, correlationId, meta, now)

        if (outcome is OperationOutcome.Approved) {
            when (operation) {
                PaymentOperation.CAPTURE -> ledger.post(payment.id, LedgerOperation.CAPTURE, payment.money(), correlationId)
                PaymentOperation.REFUND -> ledger.post(payment.id, LedgerOperation.REFUND, payment.money(), correlationId)
                PaymentOperation.AUTHORIZE -> Unit // an authorization is a hold, not a financial movement
            }
        }
        publish(payment, operation, outcome, correlationId)
        metrics.paymentOutcome(operation.name, outcome.javaClass.simpleName.uppercase(), payment.processor)
    }

    private fun recordFailure(
        payment: Payment,
        code: String,
        category: String,
        target: PaymentStatus,
        now: java.time.Instant,
    ) {
        payment.pendingOperation = null
        payment.failureCode = code
        payment.failureCategory = category
        if (target == PaymentStatus.FAILED) payment.failedAt = now
    }

    private fun publish(
        payment: Payment,
        operation: PaymentOperation,
        outcome: OperationOutcome,
        correlationId: String,
    ) {
        val type =
            when {
                outcome is OperationOutcome.Approved && operation == PaymentOperation.AUTHORIZE -> DomainEventType.PaymentAuthorized
                outcome is OperationOutcome.Approved && operation == PaymentOperation.CAPTURE -> DomainEventType.PaymentCaptured
                outcome is OperationOutcome.Approved -> DomainEventType.PaymentRefunded
                payment.status == PaymentStatus.FAILED -> DomainEventType.PaymentFailed
                outcome is OperationOutcome.Uncertain -> DomainEventType.ProcessorTimeout
                else -> return
            }
        outbox.append(type, "payment", payment.id, PaymentEvents.payload(payment, operation), correlationId)
    }
}

object PaymentEvents {
    fun payload(
        p: Payment,
        operation: PaymentOperation? = null,
    ): Map<String, Any?> =
        linkedMapOf(
            "paymentId" to p.id.toString(),
            "merchantId" to p.merchantId,
            "amount" to p.amount.toPlainString(),
            "currency" to p.currency.trim(),
            "processor" to p.processor,
            "status" to p.status.name,
            "operation" to operation?.name,
            "failureCode" to p.failureCode,
        )
}
