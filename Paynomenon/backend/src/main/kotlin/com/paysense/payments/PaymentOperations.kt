package com.paysense.payments

import com.paysense.common.ConflictException
import com.paysense.common.NotFoundException
import com.paysense.common.UnprocessableException
import com.paysense.observability.OperationalLogService
import com.paysense.processors.ProcessorRequest
import com.paysense.processors.ProcessorResponse
import com.paysense.processors.ProcessorStatus
import com.paysense.processors.ProcessorTimeoutException
import com.paysense.processors.ProcessorUnavailableException
import com.paysense.processors.ResilientProcessorClient
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import java.time.Clock
import java.util.UUID

enum class OperationResultKind { COMPLETED, UNCERTAIN, NOT_EXECUTED }

data class OperationResult(
    val payment: Payment,
    val attempts: List<PaymentAttemptRecord>,
    val kind: OperationResultKind,
    val message: String?,
)

/**
 * Orchestrates authorize / capture / refund as three short phases so that no database transaction or row lock is
 * held while the (slow, fallible) processor is called:
 *   1. begin     - lock row, validate transition, mark in-flight, create the attempt [tx]
 *   2. call      - resilient processor call                                                    [no tx]
 *   3. complete  - lock row, record the attempt, apply the outcome atomically with ledger+outbox [tx]
 * A crash between 1 and 3 leaves the payment in-flight; [StuckPaymentRecovery] turns it into UNCERTAIN so it is
 * reconciled against the processor instead of being retried blindly.
 */
@Service
class PaymentOperationService(
    private val payments: PaymentRepository,
    private val events: PaymentEventRepository,
    private val attempts: PaymentAttemptRepository,
    private val applier: PaymentOutcomeApplier,
    private val processorClient: ResilientProcessorClient,
    private val opLog: OperationalLogService,
    private val clock: Clock,
    txManager: PlatformTransactionManager,
) {
    private val tx = TransactionTemplate(txManager)

    fun authorize(
        id: UUID,
        actor: String,
        correlationId: String,
    ) = run(id, PaymentOperation.AUTHORIZE, actor, correlationId)

    fun capture(
        id: UUID,
        actor: String,
        correlationId: String,
    ) = run(id, PaymentOperation.CAPTURE, actor, correlationId)

    /** Refunds are full refunds only; the original payment amount is never modified. */
    fun refund(
        id: UUID,
        requested: java.math.BigDecimal?,
        actor: String,
        correlationId: String,
    ): OperationResult {
        if (requested != null) {
            val payment = payments.findById(id).orElseThrow { NotFoundException("Payment", id) }
            if (requested.compareTo(payment.amount) != 0) {
                throw UnprocessableException(
                    "PARTIAL_REFUND_NOT_SUPPORTED",
                    "Only full refunds are supported; the refund amount must equal the captured amount ${payment.amount.toPlainString()}",
                )
            }
        }
        return run(id, PaymentOperation.REFUND, actor, correlationId)
    }

    /**
     * Executes only phase 1 (payment marked in flight, attempt recorded) and stops, exactly as if the worker had died
     * before calling the processor. Used by recovery tests and the synthetic-data seeder to create a stuck payment.
     */
    fun beginOnly(
        id: UUID,
        op: PaymentOperation,
        actor: String,
        correlationId: String,
    ): PaymentAttemptRecord = tx.execute { begin(id, op, actor, correlationId) }!!.attempt

    /** Voids a payment that has not been captured: CREATED (never authorized) or AUTHORIZED (releases the hold). */
    fun cancel(
        id: UUID,
        actor: String,
        correlationId: String,
    ): Payment =
        tx.execute {
            val payment = payments.lockById(id) ?: throw NotFoundException("Payment", id)
            if (payment.status !in setOf(PaymentStatus.CREATED, PaymentStatus.AUTHORIZED)) {
                throw ConflictException("INVALID_STATE_TRANSITION", "Cannot cancel a payment in state ${payment.status}")
            }
            val now = clock.instant()
            val from = payment.status
            payment.transitionTo(PaymentStatus.CANCELLED, now)
            payments.saveAndFlush(payment)
            events.append(
                id,
                PaymentEventType.CANCELLED,
                from,
                PaymentStatus.CANCELLED,
                EventSource.API,
                actor,
                correlationId,
                mapOf("previousStatus" to from.name),
                now,
            )
            payment
        }!!

    private fun run(
        id: UUID,
        op: PaymentOperation,
        actor: String,
        correlationId: String,
    ): OperationResult {
        val begun = tx.execute { begin(id, op, actor, correlationId) }!!

        val request =
            ProcessorRequest(
                begun.payment.processor,
                begun.attempt.processorRequestId,
                op,
                id,
                begun.payment.money(),
                begun.payment.description,
                correlationId,
            )
        val (outcome, attemptUpdate) = callProcessor(request)

        return tx.execute { complete(id, op, begun.attempt, outcome, attemptUpdate, actor, correlationId) }!!
    }

    private data class Begun(
        val payment: Payment,
        val attempt: PaymentAttemptRecord,
    )

    private fun begin(
        id: UUID,
        op: PaymentOperation,
        actor: String,
        correlationId: String,
    ): Begun {
        val payment = payments.lockById(id) ?: throw NotFoundException("Payment", id)
        when {
            payment.status.isInFlight ->
                throw ConflictException("OPERATION_IN_PROGRESS", "Payment is ${payment.status}: another operation is in flight")
            payment.status == PaymentStatus.UNCERTAIN ->
                throw ConflictException(
                    "PAYMENT_OUTCOME_UNCERTAIN",
                    "The outcome of the previous ${payment.pendingOperation} is unknown and is being reconciled; no new operation is allowed until it is resolved",
                )
            payment.status != op.startsFrom ->
                throw ConflictException(
                    "INVALID_STATE_TRANSITION",
                    "Cannot ${op.name.lowercase()} a payment in state ${payment.status}; expected ${op.startsFrom}",
                )
        }
        val now = clock.instant()
        val from = payment.status
        payment.transitionTo(op.inFlight, now)
        payment.pendingOperation = op
        payments.saveAndFlush(payment)
        val attempt = attempts.start(payment, op, correlationId, now)
        events.append(
            id,
            PaymentEventType.OPERATION_STARTED,
            from,
            op.inFlight,
            EventSource.API,
            actor,
            correlationId,
            mapOf("operation" to op.name, "attemptNumber" to attempt.attemptNumber, "processorRequestId" to attempt.processorRequestId),
            now,
        )
        return Begun(payment, attempt)
    }

    private data class AttemptUpdate(
        val status: AttemptStatus,
        val code: String?,
        val category: String?,
        val millis: Int?,
        val sanitized: Map<String, Any?>,
    )

    private fun callProcessor(request: ProcessorRequest): Pair<OperationOutcome, AttemptUpdate> {
        val started = System.nanoTime()

        fun elapsed() = ((System.nanoTime() - started) / 1_000_000).toInt()
        return try {
            val r: ProcessorResponse = processorClient.execute(request)
            val sanitized =
                mapOf(
                    "status" to r.status.name,
                    "responseCode" to r.responseCode,
                    "message" to r.message,
                    "processorTransactionId" to r.processorTransactionId,
                )
            when (r.status) {
                ProcessorStatus.APPROVED ->
                    OperationOutcome.Approved(r.responseCode) to
                        AttemptUpdate(AttemptStatus.APPROVED, r.responseCode, null, r.latencyMs, sanitized)
                ProcessorStatus.DECLINED ->
                    OperationOutcome.Declined(r.responseCode, r.message) to
                        AttemptUpdate(AttemptStatus.DECLINED, r.responseCode, "DECLINED", r.latencyMs, sanitized)
                ProcessorStatus.INVALID_REQUEST ->
                    OperationOutcome.Invalid(r.responseCode, r.message) to
                        AttemptUpdate(AttemptStatus.INVALID, r.responseCode, "INVALID_REQUEST", r.latencyMs, sanitized)
            }
        } catch (e: ProcessorTimeoutException) {
            opLog.record(
                "ERROR",
                "processor-client",
                "Timeout calling ${request.processor} for ${request.operation}: outcome unknown",
                request.correlationId,
                request.paymentReference,
                mapOf("processor" to request.processor, "requestId" to request.requestId, "afterMs" to e.afterMs),
            )
            OperationOutcome.Uncertain("processor timeout after ${e.afterMs}ms") to
                AttemptUpdate(AttemptStatus.TIMEOUT, "TIMEOUT", "TIMEOUT", e.afterMs.toInt(), mapOf("error" to "timeout"))
        } catch (e: ProcessorUnavailableException) {
            opLog.record(
                "ERROR",
                "processor-client",
                "${request.processor} unavailable for ${request.operation}: ${e.message}",
                request.correlationId,
                request.paymentReference,
                mapOf("processor" to request.processor, "requestId" to request.requestId, "code" to e.code),
            )
            OperationOutcome.NotExecuted(e.code, e.message ?: "processor unavailable") to
                AttemptUpdate(AttemptStatus.UNAVAILABLE, e.code, "UNAVAILABLE", elapsed(), mapOf("error" to e.code))
        } catch (e: RuntimeException) {
            // Unknown failure after the request may have been sent: the safe assumption is "outcome unknown".
            opLog.record(
                "ERROR",
                "processor-client",
                "Unexpected ${e.javaClass.simpleName} calling ${request.processor}",
                request.correlationId,
                request.paymentReference,
                mapOf("processor" to request.processor, "requestId" to request.requestId),
            )
            OperationOutcome.Uncertain("unexpected client error ${e.javaClass.simpleName}") to
                AttemptUpdate(AttemptStatus.ERROR, "CLIENT_ERROR", "INTERNAL", elapsed(), mapOf("error" to e.javaClass.simpleName))
        }
    }

    private fun complete(
        id: UUID,
        op: PaymentOperation,
        attempt: PaymentAttemptRecord,
        outcome: OperationOutcome,
        update: AttemptUpdate,
        actor: String,
        correlationId: String,
    ): OperationResult {
        val payment = payments.lockById(id) ?: throw NotFoundException("Payment", id)
        attempts.complete(attempt.id, update.status, update.code, update.category, update.millis, update.sanitized, clock.instant())
        val applicable = payment.status == op.inFlight || (payment.status == PaymentStatus.UNCERTAIN && payment.pendingOperation == op)
        if (applicable) {
            applier.apply(payment, op, outcome, EventSource.API, actor, correlationId, mapOf("attemptNumber" to attempt.attemptNumber))
        } else {
            opLog.record(
                "WARN",
                "payments",
                "Result of ${op.name} arrived but payment is ${payment.status}; not applied",
                correlationId,
                id,
            )
        }
        val kind =
            when {
                payment.status == PaymentStatus.UNCERTAIN -> OperationResultKind.UNCERTAIN
                outcome is OperationOutcome.NotExecuted -> OperationResultKind.NOT_EXECUTED
                else -> OperationResultKind.COMPLETED
            }
        return OperationResult(payment, attempts.forPayment(id), kind, (outcome as? OperationOutcome.NotExecuted)?.message)
    }
}
