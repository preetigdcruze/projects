package com.paysense.processors

import org.slf4j.LoggerFactory
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import java.math.BigDecimal
import java.sql.Timestamp
import java.time.Clock
import java.time.Instant
import java.util.UUID

data class MockProcessorTransaction(
    val processor: String,
    val requestId: String,
    val operation: String,
    val paymentReference: String,
    val amount: BigDecimal,
    val currency: String,
    val status: String,
    val responseCode: String,
    val executedAt: Instant,
)

/** The "processor side" state of the simulation: what the processor believes it executed. */
@Repository
class MockProcessorLedger(
    private val jdbc: JdbcClient,
) {
    fun find(
        processor: String,
        requestId: String,
    ): MockProcessorTransaction? =
        jdbc
            .sql("SELECT * FROM mock_processor_transactions WHERE processor = :p AND request_id = :r")
            .param("p", processor)
            .param("r", requestId)
            .query { rs, _ -> map(rs) }
            .optional()
            .orElse(null)

    /** Returns the stored row if the request id was already executed (processor-level idempotency). */
    fun record(tx: MockProcessorTransaction): MockProcessorTransaction {
        val inserted =
            jdbc
                .sql(
                    """
            INSERT INTO mock_processor_transactions (id, processor, request_id, operation, payment_reference, amount, currency, status, response_code, executed_at)
            VALUES (:id, :p, :r, :op, :ref, :amt, :cur, :st, :code, :at)
            ON CONFLICT (processor, request_id) DO NOTHING
            """,
                ).param("id", UUID.randomUUID())
                .param("p", tx.processor)
                .param("r", tx.requestId)
                .param("op", tx.operation)
                .param("ref", tx.paymentReference)
                .param("amt", tx.amount)
                .param("cur", tx.currency)
                .param("st", tx.status)
                .param("code", tx.responseCode)
                .param("at", Timestamp.from(tx.executedAt))
                .update()
        return if (inserted == 1) tx else find(tx.processor, tx.requestId)!!
    }

    fun approvedBetween(
        processor: String,
        from: Instant,
        to: Instant,
    ): List<MockProcessorTransaction> =
        jdbc
            .sql(
                """
            SELECT * FROM mock_processor_transactions
             WHERE processor = :p AND status = 'APPROVED' AND operation IN ('CAPTURE', 'REFUND')
               AND executed_at >= :from AND executed_at < :to
             ORDER BY executed_at, request_id
            """,
            ).param("p", processor)
            .param("from", Timestamp.from(from))
            .param("to", Timestamp.from(to))
            .query { rs, _ -> map(rs) }
            .list()

    private fun map(rs: java.sql.ResultSet) =
        MockProcessorTransaction(
            rs.getString("processor"),
            rs.getString("request_id"),
            rs.getString("operation"),
            rs.getString("payment_reference"),
            rs.getBigDecimal("amount"),
            rs.getString("currency").trim(),
            rs.getString("status"),
            rs.getString("response_code"),
            rs.getTimestamp("executed_at").toInstant(),
        )
}

/**
 * A simulated processor with configurable failure behavior. It is idempotent on the request id, remembers what it
 * executed (so lookups can resolve ambiguous timeouts) and never touches real money or card data.
 */
class MockPaymentProcessor(
    override val name: String,
    private val control: SimulationControl,
    private val ledger: MockProcessorLedger,
    private val callbacks: ProcessorCallbackSink,
    private val clock: Clock,
) : PaymentProcessor {
    private val log = LoggerFactory.getLogger(javaClass)

    override fun execute(request: ProcessorRequest): ProcessorResponse {
        ledger.find(name, request.requestId)?.let { return replay(it) }

        val (outcome, settings) = control.nextOutcome(name, request.description)
        val extra = if (outcome == SimOutcome.DELAYED) settings.delayMs else 0
        val latency = control.latency(name, settings, extra)
        log.debug("{} {} simulated outcome {}", name, request.requestId, outcome)

        when (outcome) {
            SimOutcome.UNAVAILABLE -> {
                pause(latency.coerceAtMost(200))
                throw ProcessorUnavailableException("$name returned 503 Service Unavailable (simulated)")
            }
            SimOutcome.TIMEOUT_NOT_EXECUTED -> {
                // the client cannot tell this apart from TIMEOUT_EXECUTED: it simply never gets an answer
                pause(settings.delayMs.coerceAtLeast(latency))
                throw ProcessorTimeoutExceptionInternal(request.requestId)
            }
            SimOutcome.INVALID_REQUEST ->
                return ProcessorResponse(
                    ProcessorStatus.INVALID_REQUEST,
                    "INVALID_REQUEST",
                    "Processor rejected the request as malformed",
                    null,
                    latency,
                )
            SimOutcome.INSUFFICIENT_FUNDS -> {
                ledger.record(txOf(request, "DECLINED", "INSUFFICIENT_FUNDS"))
                pause(latency)
                return ProcessorResponse(
                    ProcessorStatus.DECLINED,
                    "INSUFFICIENT_FUNDS",
                    "Declined: insufficient funds (synthetic)",
                    null,
                    latency,
                )
            }
            else -> Unit
        }

        // From here the processor *executes* the operation: record it before any delay, so a client that gives up
        // waiting still leaves an executed transaction behind (the ambiguous-timeout case).
        val stored = ledger.record(txOf(request, "APPROVED", "APPROVED"))
        if (outcome == SimOutcome.TIMEOUT_EXECUTED) {
            pause(settings.delayMs.coerceAtLeast(latency))
            throw ProcessorTimeoutExceptionInternal(request.requestId)
        }
        pause(latency)
        if (outcome == SimOutcome.DUPLICATE_CALLBACK) {
            val cb =
                ProcessorCallback(
                    name,
                    "cb-${request.requestId}",
                    request.paymentReference,
                    request.operation,
                    ProcessorStatus.APPROVED,
                    "APPROVED",
                )
            callbacks.deliver(cb)
            callbacks.deliver(cb)
        }
        return ProcessorResponse(
            ProcessorStatus.APPROVED,
            "APPROVED",
            "Approved (synthetic)",
            "ptx-${stored.requestId.hashCode().toUInt().toString(16)}",
            latency,
        )
    }

    override fun lookup(requestId: String): LookupResult {
        val tx = ledger.find(name, requestId) ?: return LookupResult(LookupStatus.NOT_FOUND, null)
        return LookupResult(if (tx.status == "APPROVED") LookupStatus.APPROVED else LookupStatus.DECLINED, tx.responseCode)
    }

    private fun replay(tx: MockProcessorTransaction) =
        ProcessorResponse(
            if (tx.status == "APPROVED") ProcessorStatus.APPROVED else ProcessorStatus.DECLINED,
            tx.responseCode,
            "Replay of previously executed request (synthetic)",
            null,
            5,
        )

    private fun txOf(
        r: ProcessorRequest,
        status: String,
        code: String,
    ) = MockProcessorTransaction(
        name,
        r.requestId,
        r.operation.name,
        r.paymentReference.toString(),
        r.amount.toStorage(),
        r.amount.currency,
        status,
        code,
        clock.instant(),
    )

    private fun pause(ms: Int) {
        if (control.realDelay && ms > 0) {
            try {
                Thread.sleep(ms.toLong())
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                throw e
            }
        }
    }
}

/** Raised by the mock when it executed the request but its answer is "lost"; the client treats it as a timeout. */
class ProcessorTimeoutExceptionInternal(
    requestId: String,
) : RuntimeException("response lost for $requestId (simulated)")
