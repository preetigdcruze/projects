package com.paysense.payments

import com.paysense.common.CorrelationId
import com.paysense.common.NotFoundException
import com.paysense.common.PaySenseProperties
import com.paysense.events.EventEnvelope
import com.paysense.events.EventHandler
import com.paysense.observability.OperationalLogService
import com.paysense.processors.LookupStatus
import com.paysense.processors.ResilientProcessorClient
import org.slf4j.LoggerFactory
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Component
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import java.sql.Timestamp
import java.time.Clock
import java.util.UUID

enum class Resolution { RESOLVED_APPROVED, RESOLVED_DECLINED, RESOLVED_NOT_EXECUTED, NOT_UNCERTAIN }

/**
 * Resolves UNCERTAIN payments by asking the processor what actually happened (a read-only lookup by the original
 * processor request id). It never re-sends the operation, so a timed-out charge that did execute is not charged twice.
 */
@Service
class UncertainPaymentResolver(
    private val payments: PaymentRepository,
    private val attempts: PaymentAttemptRepository,
    private val applier: PaymentOutcomeApplier,
    private val client: ResilientProcessorClient,
    private val opLog: OperationalLogService,
    txManager: PlatformTransactionManager,
) {
    private val tx = TransactionTemplate(txManager)

    fun resolve(
        paymentId: UUID,
        source: String,
        actor: String,
        correlationId: String,
    ): Resolution {
        data class Pending(
            val op: PaymentOperation,
            val processor: String,
            val requestId: String,
        )
        val pending =
            tx.execute {
                val p = payments.findById(paymentId).orElseThrow { NotFoundException("Payment", paymentId) }
                val op = p.pendingOperation
                if (p.status != PaymentStatus.UNCERTAIN || op == null) {
                    null
                } else {
                    val last =
                        attempts.forPayment(paymentId, 200).filter { it.operation == op.name }.maxByOrNull { it.attemptNumber }
                            ?: error("uncertain payment $paymentId has no $op attempt")
                    Pending(op, p.processor, last.processorRequestId)
                }
            } ?: return Resolution.NOT_UNCERTAIN

        val lookup = client.lookup(pending.processor, pending.requestId) // network call outside any transaction; failures propagate for retry

        return tx.execute {
            val p = payments.lockById(paymentId) ?: throw NotFoundException("Payment", paymentId)
            if (p.status != PaymentStatus.UNCERTAIN || p.pendingOperation != pending.op) return@execute Resolution.NOT_UNCERTAIN
            val (outcome, resolution) =
                when (lookup.status) {
                    LookupStatus.APPROVED -> OperationOutcome.Approved(lookup.responseCode ?: "APPROVED") to Resolution.RESOLVED_APPROVED
                    LookupStatus.DECLINED ->
                        OperationOutcome.Declined(lookup.responseCode ?: "DECLINED", "declined per processor lookup") to
                            Resolution.RESOLVED_DECLINED
                    LookupStatus.NOT_FOUND ->
                        OperationOutcome.NotExecuted(
                            "NOT_EXECUTED_AT_PROCESSOR",
                            "processor has no record of request ${pending.requestId}",
                        ) to
                            Resolution.RESOLVED_NOT_EXECUTED
                }
            applier.apply(
                p,
                pending.op,
                outcome,
                source,
                actor,
                correlationId,
                mapOf(
                    "resolvedBy" to "processor-lookup",
                    "processorRequestId" to pending.requestId,
                ),
            )
            opLog.record(
                "INFO",
                "reconciliation",
                "Resolved uncertain ${pending.op} for payment as ${resolution.name} via processor lookup",
                correlationId,
                paymentId,
                mapOf("processorRequestId" to pending.requestId),
            )
            resolution
        }!!
    }
}

/** Consumer of ProcessorTimeout events: asynchronously reconciles the uncertain payment with the processor. */
@Component
class UncertainPaymentHandler(
    private val resolver: UncertainPaymentResolver,
) : EventHandler {
    override val name = "uncertain-payment-resolver"

    // The processor lookup is a network call, so it must not run inside the dedupe transaction. The resolution
    // itself is idempotent (it only acts on UNCERTAIN payments), which makes at-least-once delivery safe.
    override val atomicWithDedupe = false

    override fun supports(eventType: String) = eventType == "ProcessorTimeout"

    override fun handle(event: EventEnvelope) {
        val paymentId = UUID.fromString(event.aggregateId.toString())
        resolver.resolve(paymentId, EventSource.CONSUMER, name, event.correlationId)
    }
}

/**
 * Safety net for crashed workers: a payment that has been in flight longer than the configured timeout cannot have a
 * live worker behind it. Mark it UNCERTAIN (never FAILED, never retried) so that it is reconciled against the processor.
 */
@Service
class StuckPaymentRecovery(
    private val jdbc: JdbcClient,
    private val payments: PaymentRepository,
    private val applier: PaymentOutcomeApplier,
    private val props: PaySenseProperties,
    private val opLog: OperationalLogService,
    private val clock: Clock,
    txManager: PlatformTransactionManager,
) {
    private val log = LoggerFactory.getLogger(javaClass)
    private val tx = TransactionTemplate(txManager)

    fun sweep(): Int {
        val cutoff = clock.instant().minus(props.payments.inFlightTimeout)
        val ids =
            jdbc
                .sql(
                    "SELECT id FROM payments WHERE status IN ('PROCESSING', 'CAPTURING', 'REFUNDING') AND updated_at < :cutoff ORDER BY updated_at LIMIT 100",
                ).param("cutoff", Timestamp.from(cutoff))
                .query(UUID::class.java)
                .list()
        var swept = 0
        for (id in ids) {
            val done =
                tx.execute {
                    val p = payments.lockById(id) ?: return@execute false
                    if (!p.status.isInFlight || p.updatedAt.isAfter(cutoff)) return@execute false
                    val op = p.pendingOperation ?: return@execute false
                    val correlation = CorrelationId.currentOrNew()
                    applier.apply(
                        p,
                        op,
                        OperationOutcome.Uncertain(
                            "in flight longer than ${props.payments.inFlightTimeout}: worker crashed or response lost",
                        ),
                        EventSource.RECOVERY,
                        "stuck-payment-recovery",
                        correlation,
                    )
                    true
                } ?: false
            if (done) {
                swept++
                opLog.record("WARN", "recovery", "Payment $id was stuck in flight and is now UNCERTAIN", paymentId = id)
            }
        }
        if (swept > 0) log.warn("Recovered {} stuck payments", swept)
        return swept
    }
}
