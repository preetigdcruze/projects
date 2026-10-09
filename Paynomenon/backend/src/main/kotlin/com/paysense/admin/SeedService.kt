package com.paysense.admin

import com.paysense.common.CorrelationId
import com.paysense.common.OverridableClock
import com.paysense.common.PaySenseProperties
import com.paysense.common.UnprocessableException
import com.paysense.events.DomainEventType
import com.paysense.events.OutboxPublisher
import com.paysense.events.OutboxWriter
import com.paysense.idempotency.IdempotencyKeys
import com.paysense.idempotency.IdempotentExecutor
import com.paysense.idempotency.IdempotentResult
import com.paysense.incidents.CreateIncidentCommand
import com.paysense.incidents.IncidentService
import com.paysense.payments.CreatePaymentRequest
import com.paysense.payments.EventSource
import com.paysense.payments.OperationResultKind
import com.paysense.payments.Payment
import com.paysense.payments.PaymentCreationService
import com.paysense.payments.PaymentOperation
import com.paysense.payments.PaymentOperationService
import com.paysense.payments.PaymentResponse
import com.paysense.payments.PaymentStatus
import com.paysense.payments.StuckPaymentRecovery
import com.paysense.payments.UncertainPaymentResolver
import com.paysense.processors.SimOutcome
import com.paysense.processors.SimulationControl
import com.paysense.processors.SimulationSettings
import com.paysense.reconciliation.ReconciliationService
import com.paysense.reconciliation.ReportScenario
import org.slf4j.LoggerFactory
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import java.math.BigDecimal
import java.math.RoundingMode
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.SplittableRandom
import java.util.UUID

data class SeedSummary(
    val seed: Long,
    val anchor: Instant,
    val payments: Long,
    val scenarios: Map<String, String>,
    val reconciliationRuns: List<UUID>,
    val incidentId: UUID?,
)

private const val ACTOR = "seed"
private const val P1 = "MOCK_PROCESSOR"
private const val P2 = "MOCK_PROCESSOR_EU"

/**
 * Generates reproducible, entirely synthetic data by running the real domain services with a pinned clock and a
 * seeded simulator, so every record (events, ledger, outbox, settlement) is exactly what production code would write.
 * Same seed + same anchor => same data. All rows are flagged synthetic.
 */
@Service
class SeedService(
    private val creation: PaymentCreationService,
    private val operations: PaymentOperationService,
    private val recovery: StuckPaymentRecovery,
    private val resolver: UncertainPaymentResolver,
    private val publisher: OutboxPublisher,
    private val outbox: OutboxWriter,
    private val idempotent: IdempotentExecutor,
    private val reconciliation: ReconciliationService,
    private val incidents: IncidentService,
    private val control: SimulationControl,
    private val processorClient: com.paysense.processors.ResilientProcessorClient,
    private val clock: OverridableClock,
    private val jdbc: JdbcClient,
    private val props: PaySenseProperties,
    txManager: PlatformTransactionManager,
) {
    private val log = LoggerFactory.getLogger(javaClass)
    private val tx = TransactionTemplate(txManager)
    private var counter = 0

    fun reset() {
        requireDevelopment()
        jdbc
            .sql(
                """
            TRUNCATE payments, payment_attempts, payment_events, idempotency_records, ledger_transactions, ledger_entries, outbox_events,
                     processed_events, dead_letter_events, mock_processor_transactions, processor_callbacks, reconciliation_runs,
                     processor_settlement_records, reconciliation_discrepancies, incidents, incident_links, anomaly_events,
                     ai_investigations, operational_logs RESTART IDENTITY CASCADE
            """,
            ).update()
        control.reset()
    }

    @Synchronized
    fun seed(
        seed: Long,
        anchorInput: Instant?,
        replace: Boolean,
    ): SeedSummary {
        requireDevelopment()
        val existing = jdbc.sql("SELECT COUNT(*) FROM payments WHERE synthetic").query(Long::class.java).single()
        if (existing > 0 &&
            !replace
        ) {
            throw UnprocessableException(
                "SEED_DATA_EXISTS",
                "Synthetic data already exists ($existing payments). Pass replace=true to wipe and regenerate.",
            )
        }
        if (replace) reset()
        counter = 0
        val anchor = (anchorInput ?: Instant.now()).truncatedTo(ChronoUnit.SECONDS)
        val rng = SplittableRandom(seed)
        val originalDelay = control.realDelay
        control.realDelay = false // simulated latency is recorded, not slept
        control.reset(seed)
        val scenarios = linkedMapOf<String, String>()
        try {
            baseline(rng, anchor)
            scenarios.putAll(scenarios(anchor))
            publishAll()
            val runs = reconcile(anchor)
            publishAll()
            val incident = correlatedIncident(anchor)
            scenarios["12-correlated-incident"] = incident?.toString() ?: "none"
            val total = jdbc.sql("SELECT COUNT(*) FROM payments WHERE synthetic").query(Long::class.java).single()
            log.info("Seeded {} synthetic payments (seed={}, anchor={})", total, seed, anchor)
            return SeedSummary(seed, anchor, total, scenarios, runs, incident)
        } finally {
            control.reset()
            control.realDelay = originalDelay
        }
    }

    private fun requireDevelopment() {
        if (props.isProduction ||
            !props.simulation.enabled
        ) {
            throw UnprocessableException(
                "SEEDING_DISABLED",
                "Synthetic data and reset are disabled when simulation is off or in production",
            )
        }
    }

    // ---- building blocks -------------------------------------------------------------------------------------

    private fun nextCorrelation() = "seed-%06d-%s".format(++counter, "c0ffee")

    private fun newPayment(
        at: Instant,
        amount: String,
        currency: String,
        merchant: String,
        processor: String,
        description: String,
        key: String? = null,
    ): Payment =
        clock.at(at) {
            CorrelationId.with(nextCorrelation()) {
                val prepared = creation.prepare(CreatePaymentRequest(BigDecimal(amount), currency, merchant, processor, description))
                tx.execute { creation.create(prepared, ACTOR, EventSource.SEED, synthetic = true) }!!
            }
        }

    private fun op(
        at: Instant,
        id: UUID,
        operation: PaymentOperation,
    ) = clock.at(at) {
        CorrelationId.with(nextCorrelation()) {
            when (operation) {
                PaymentOperation.AUTHORIZE -> operations.authorize(id, ACTOR, CorrelationId.currentOrNew())
                PaymentOperation.CAPTURE -> operations.capture(id, ACTOR, CorrelationId.currentOrNew())
                PaymentOperation.REFUND -> operations.refund(id, null, ACTOR, CorrelationId.currentOrNew())
            }
        }
    }

    /** Full lifecycle, stopping early on any non-success. Returns the final payment. */
    private fun lifecycle(
        at: Instant,
        anchor: Instant,
        amount: String,
        currency: String,
        merchant: String,
        processor: String,
        description: String,
        capture: Boolean,
        refund: Boolean,
    ): Payment {
        val p = newPayment(at, amount, currency, merchant, processor, description)

        fun later(d: Duration) = minOf(at.plus(d), anchor)
        var r = op(later(Duration.ofSeconds(2)), p.id, PaymentOperation.AUTHORIZE)
        if (capture && r.payment.status == PaymentStatus.AUTHORIZED) r = op(later(Duration.ofMinutes(5)), p.id, PaymentOperation.CAPTURE)
        if (refund && r.payment.status == PaymentStatus.CAPTURED) r = op(later(Duration.ofMinutes(40)), p.id, PaymentOperation.REFUND)
        return r.payment
    }

    // ---- baseline traffic ------------------------------------------------------------------------------------

    private fun baseline(
        rng: SplittableRandom,
        anchor: Instant,
    ) {
        val merchants = listOf("merchant-demo", "merchant-books", "merchant-travel", "merchant-games")
        val currencies = listOf("EUR", "EUR", "EUR", "EUR", "USD", "USD", "GBP", "JPY")
        control.update(P1, SimulationSettings(insufficientFundsRate = 0.04))
        control.update(P2, SimulationSettings(insufficientFundsRate = 0.04))
        for (h in 24 downTo 1) {
            val hourStart = anchor.minus(Duration.ofHours(h.toLong()))
            when (h) {
                1 -> { // last hour: latency degradation on the primary processor
                    control.update(P1, SimulationSettings(insufficientFundsRate = 0.04, baseLatencyMs = 700, jitterMs = 300))
                    control.update(
                        P2,
                        SimulationSettings(
                            timeoutRate = 0.10,
                            unavailableRate = 0.50,
                            invalidRequestRate = 0.04,
                            insufficientFundsRate = 0.12,
                            timeoutExecutedRatio = 0.5,
                        ),
                    )
                }
                2 ->
                    control.update(
                        P2,
                        SimulationSettings(
                            timeoutRate = 0.10,
                            unavailableRate = 0.50,
                            invalidRequestRate = 0.04,
                            insufficientFundsRate = 0.12,
                            timeoutExecutedRatio = 0.5,
                        ),
                    )
            }
            val perProcessor = 10
            for (processor in listOf(P1, P2)) {
                for (i in 0 until perProcessor) {
                    val at = hourStart.plusSeconds((i * 3600L / perProcessor) + rng.nextInt(120))
                    val currency = currencies[rng.nextInt(currencies.size)]
                    val amount =
                        if (currency ==
                            "JPY"
                        ) {
                            (500 + rng.nextInt(20000)).toString()
                        } else {
                            BigDecimal(5 + rng.nextDouble() * 295).setScale(2, RoundingMode.HALF_UP).toPlainString()
                        }
                    lifecycle(
                        at,
                        anchor,
                        amount,
                        currency,
                        merchants[rng.nextInt(merchants.size)],
                        processor,
                        "Baseline order",
                        capture =
                        rng.nextInt(100) < 85,
                        refund = rng.nextInt(100) < 6,
                    )
                }
            }
        }
        control.reset(null)
        processorClient.resetCircuits() // the unstable window may have tripped breakers; the outage itself is already in the data
        publishAll() // let uncertain payments from the unstable window be resolved before the named scenarios
    }

    // ---- named scenarios -------------------------------------------------------------------------------------

    private fun scenarios(anchor: Instant): Map<String, String> {
        val out = linkedMapOf<String, String>()
        val base = anchor.minus(Duration.ofMinutes(55))

        out["01-successful-payment"] =
            lifecycle(
                base,
                anchor,
                "49.99",
                "EUR",
                "merchant-demo",
                P1,
                "Scenario 1: successful payment",
                capture = true,
                refund = false,
            ).id.toString()

        out["02-insufficient-funds"] =
            lifecycle(
                base.plusSeconds(60),
                anchor,
                "250.00",
                "EUR",
                "merchant-demo",
                P1,
                "Scenario 2: rejected [sim:insufficient_funds]",
                capture = true,
                refund = false,
            ).id.toString()

        val timeout =
            newPayment(base.plusSeconds(120), "89.90", "EUR", "merchant-travel", P1, "Scenario 3: processor timeout [sim:timeout]")
        op(base.plusSeconds(122), timeout.id, PaymentOperation.AUTHORIZE)
        publishAll() // ProcessorTimeout event -> resolver consumer
        clock.at(base.plusSeconds(180)) { resolver.resolve(timeout.id, EventSource.SEED, "seed-resolver", "seed-timeout-resolve") }
        out["03-timeout-then-reconciled"] = timeout.id.toString()

        val key = "seed-duplicate-request-$counter"
        val request = CreatePaymentRequest(BigDecimal("19.00"), "EUR", "merchant-books", P1, "Scenario 4: duplicate client request")
        var duplicateId: UUID? = null
        repeat(2) {
            clock.at(base.plusSeconds(240)) {
                val prepared = creation.prepare(request)
                val fp =
                    IdempotencyKeys.fingerprint(
                        "POST /payments",
                        prepared.money.toStorage().toPlainString(),
                        prepared.money.currency,
                        prepared.merchantId,
                        prepared.processor,
                        prepared.description,
                    )
                idempotent
                    .atomic(ACTOR, key, "POST /payments", fp) {
                        val p = creation.create(prepared, ACTOR, EventSource.SEED, synthetic = true)
                        IdempotentResult(201, PaymentResponse.from(p), p.id)
                    }.also { r -> (r.body as? PaymentResponse)?.let { duplicateId = it.id } }
            }
        }
        out["04-duplicate-request-same-key"] = "$key -> ${duplicateId ?: "replayed"}"

        processorClient.resetCircuits() // the scripted outage must be the cause of the failure, not breaker state left over from earlier scenarios
        val outage = newPayment(base.plusSeconds(300), "35.00", "EUR", "merchant-games", P1, "Scenario 5: temporary outage")
        control.forceNext(P1, SimOutcome.UNAVAILABLE, props.processors.retry.maxAttempts)
        op(base.plusSeconds(302), outage.id, PaymentOperation.AUTHORIZE) // fails, payment returns to CREATED
        op(base.plusSeconds(420), outage.id, PaymentOperation.AUTHORIZE) // processor recovered
        op(base.plusSeconds(430), outage.id, PaymentOperation.CAPTURE)
        processorClient.resetCircuits()
        out["05-outage-with-recovery"] = outage.id.toString()

        val crash =
            newPayment(
                anchor.minus(Duration.ofMinutes(30)),
                "60.00",
                "EUR",
                "merchant-demo",
                P1,
                "Scenario 6: worker crashed mid-processing",
            )
        clock.at(
            anchor.minus(Duration.ofMinutes(30)),
        ) { operations.beginOnly(crash.id, PaymentOperation.AUTHORIZE, ACTOR, "seed-crash-0001") }
        clock.at(anchor.minus(Duration.ofMinutes(20))) { recovery.sweep() }
        publishAll()
        clock.at(
            anchor.minus(Duration.ofMinutes(19)),
        ) { resolver.resolve(crash.id, EventSource.SEED, "seed-resolver", "seed-crash-resolve") }
        out["06-worker-crash-recovery"] = crash.id.toString()

        // Scenario 11: an event nobody can process (malformed payload) lands in the dead-letter table
        tx.executeWithoutResult {
            outbox.append(
                DomainEventType.ReconciliationDiscrepancyDetected,
                "discrepancy",
                UUID.nameUUIDFromBytes("seed-dead-letter".toByteArray()),
                mapOf("type" to "AMOUNT_MISMATCH"),
                "seed-deadletter-0001",
            )
        }
        publishAll()
        out["11-dead-letter-event"] =
            jdbc.sql("SELECT COALESCE(MAX(id::text), 'none') FROM dead_letter_events").query(String::class.java).single()

        out["09-elevated-failure-rate"] = "processor $P2 during the last 2 hours"
        out["10-latency-anomaly"] = "processor $P1 during the last hour"
        return out
    }

    private fun reconcile(anchor: Instant): List<UUID> {
        val from = anchor.minus(Duration.ofHours(24))
        val to = anchor.plusSeconds(60)
        val clean = reconciliation.start(P2, from, to, ReportScenario.CLEAN, ACTOR)
        val dirty = reconciliation.start(P1, from, to, ReportScenario.WITH_DISCREPANCIES, ACTOR) // scenarios 7 + 8 (+ other defect types)
        return listOf(clean.id, dirty.id)
    }

    private fun correlatedIncident(anchor: Instant): UUID? {
        val ids =
            jdbc
                .sql(
                    "SELECT id FROM payments WHERE synthetic AND processor = :p AND created_at >= :from AND status IN ('FAILED','UNCERTAIN','CREATED') ORDER BY created_at LIMIT 30",
                ).param("p", P2)
                .param("from", java.sql.Timestamp.from(anchor.minus(Duration.ofHours(2))))
                .query(UUID::class.java)
                .list()
        if (ids.isEmpty()) return null
        return incidents.create(
            CreateIncidentCommand(
                "Elevated failures and timeouts on $P2",
                "HIGH",
                "Several correlated failures (declines, unavailability, timeouts) on $P2 over the last two hours.",
                listOf(P2),
                anchor.minus(Duration.ofHours(2)),
                ids,
                emptyList(),
                emptyList(),
                "SEED",
            ),
            ACTOR,
        )
    }

    private fun publishAll() {
        repeat(200) { if (publisher.publishBatch() == 0) return }
    }
}
