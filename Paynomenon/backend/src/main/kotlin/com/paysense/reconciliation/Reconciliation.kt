package com.paysense.reconciliation

import com.fasterxml.jackson.databind.ObjectMapper
import com.paysense.common.ConflictException
import com.paysense.common.CorrelationId
import com.paysense.common.NotFoundException
import com.paysense.common.PageResponse
import com.paysense.common.Paging
import com.paysense.common.PaySenseProperties
import com.paysense.common.TimeRange
import com.paysense.common.ValidationException
import com.paysense.events.DomainEventType
import com.paysense.events.OutboxWriter
import com.paysense.processors.MockProcessorLedger
import com.paysense.processors.ProcessorRegistry
import org.slf4j.LoggerFactory
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import java.math.BigDecimal
import java.sql.ResultSet
import java.sql.Timestamp
import java.time.Clock
import java.time.Instant
import java.util.Random
import java.util.UUID

enum class ReportScenario { CLEAN, WITH_DISCREPANCIES }

data class RunView(
    val id: UUID,
    val processor: String,
    val windowFrom: Instant,
    val windowTo: Instant,
    val scenario: String,
    val reportId: UUID,
    val status: String,
    val internalCount: Int,
    val reportCount: Int,
    val matchedCount: Int,
    val discrepancyCount: Int,
    val startedBy: String,
    val error: String?,
    val startedAt: Instant,
    val completedAt: Instant?,
)

data class DiscrepancyView(
    val id: UUID,
    val runId: UUID,
    val type: String,
    val paymentReference: String,
    val operation: String,
    val internalAmount: BigDecimal?,
    val internalCurrency: String?,
    val reportAmount: BigDecimal?,
    val reportCurrency: String?,
    val internalStatus: String?,
    val details: Map<String, Any?>,
    val status: String,
    val explanation: String?,
    val acknowledgedBy: String?,
    val acknowledgedAt: Instant?,
    val createdAt: Instant,
)

/** Builds a synthetic settlement report from what the simulated processor actually executed. */
@Service
class SettlementReportGenerator(
    private val processorLedger: MockProcessorLedger,
    private val props: PaySenseProperties,
) {
    data class Generated(
        val lines: List<ReportLine>,
        val injected: List<String>,
    )

    fun generate(
        processor: String,
        range: TimeRange,
        scenario: ReportScenario,
        unexpectedStateReference: String?,
    ): Generated {
        val executed = processorLedger.approvedBetween(processor, range.from, range.to)
        var lines =
            executed
                .mapIndexed { i, t ->
                    ReportLine(
                        i + 1,
                        "stl-" +
                            t.requestId
                                .hashCode()
                                .toUInt()
                                .toString(16) + "-" + i,
                        t.paymentReference,
                        t.operation,
                        t.amount,
                        t.currency,
                    )
                }.toMutableList()
        val injected = mutableListOf<String>()
        if (scenario == ReportScenario.WITH_DISCREPANCIES) {
            val rng = Random(props.simulation.seed xor processor.hashCode().toLong() xor range.from.epochSecond)
            val indexes = (0 until lines.size).shuffled(rng).toMutableList()

            fun pick(): Int? = if (indexes.isEmpty()) null else indexes.removeAt(0)
            val drop = pick()
            val amount = pick()
            val currency = pick()
            val duplicate = pick()
            amount?.let {
                lines[it] = lines[it].copy(amount = lines[it].amount.add(BigDecimal("1.00")))
                injected +=
                    "AMOUNT_MISMATCH:${lines[it].reference}"
            }
            currency?.let {
                lines[it] = lines[it].copy(currency = if (lines[it].currency == "EUR") "USD" else "EUR")
                injected += "CURRENCY_MISMATCH:${lines[it].reference}"
            }
            duplicate?.let {
                lines.add(lines[it])
                injected += "DUPLICATE_SETTLEMENT:${lines[it].reference}"
            }
            val dropped = drop?.let { lines[it].also { l -> injected += "MISSING_FROM_REPORT:${l.reference}" } }
            if (dropped !=
                null
            ) {
                lines =
                    lines
                        .filter {
                            it !== dropped && !(it.reference == dropped.reference && it.operation == dropped.operation)
                        }.toMutableList()
            }
            val phantom = UUID(rng.nextLong(), rng.nextLong()).toString()
            lines.add(ReportLine(0, "stl-phantom-${phantom.take(8)}", phantom, "CAPTURE", BigDecimal("12.50"), "EUR"))
            injected += "MISSING_INTERNALLY:$phantom"
            unexpectedStateReference?.let {
                lines.add(ReportLine(0, "stl-unexpected-${it.take(8)}", it, "CAPTURE", BigDecimal("20.00"), "EUR"))
                injected += "UNEXPECTED_STATE:$it"
            }
        }
        return Generated(lines.mapIndexed { i, l -> l.copy(lineNumber = i + 1) }, injected)
    }
}

@Service
class ReconciliationService(
    private val jdbc: JdbcClient,
    private val mapper: ObjectMapper,
    private val generator: SettlementReportGenerator,
    private val processors: ProcessorRegistry,
    private val outbox: OutboxWriter,
    private val props: PaySenseProperties,
    private val clock: Clock,
    txManager: PlatformTransactionManager,
) {
    private val log = LoggerFactory.getLogger(javaClass)
    private val tx = TransactionTemplate(txManager)

    fun start(
        processor: String?,
        from: Instant?,
        to: Instant?,
        scenario: ReportScenario,
        actor: String,
    ): RunView {
        val name = processors.require(processor).name
        if (scenario == ReportScenario.WITH_DISCREPANCIES && !props.simulation.enabled) {
            throw ValidationException(
                "scenario WITH_DISCREPANCIES injects synthetic defects and is only available when simulation is enabled",
            )
        }
        val range = TimeRange.resolve(from, to, clock.instant(), props.analytics.defaultWindow, props.analytics.maxWindow)
        val runId = UUID.randomUUID()
        val reportId = UUID.randomUUID()
        val correlation = CorrelationId.currentOrNew()
        tx.executeWithoutResult {
            jdbc
                .sql(
                    """
                INSERT INTO reconciliation_runs (id, processor, window_from, window_to, scenario, report_id, status, started_by, correlation_id, started_at)
                VALUES (:id, :p, :from, :to, :sc, :rid, 'RUNNING', :by, :corr, :now)
                """,
                ).param("id", runId)
                .param("p", name)
                .param("from", Timestamp.from(range.from))
                .param("to", Timestamp.from(range.to))
                .param(
                    "sc",
                    scenario.name,
                ).param(
                    "rid",
                    reportId,
                ).param("by", actor)
                .param("corr", correlation)
                .param("now", Timestamp.from(clock.instant()))
                .update()
        }
        try {
            tx.executeWithoutResult { execute(runId, reportId, name, range, scenario, correlation) }
        } catch (e: Exception) {
            log.error("Reconciliation run {} failed", runId, e)
            tx.executeWithoutResult {
                jdbc
                    .sql("UPDATE reconciliation_runs SET status = 'FAILED', error = :err, completed_at = :now WHERE id = :id")
                    .param(
                        "err",
                        "${e.javaClass.simpleName}: ${e.message}".take(500),
                    ).param("now", Timestamp.from(clock.instant()))
                    .param("id", runId)
                    .update()
            }
        }
        return getRun(runId)
    }

    private fun execute(
        runId: UUID,
        reportId: UUID,
        processor: String,
        range: TimeRange,
        scenario: ReportScenario,
        correlation: String,
    ) {
        val unexpected =
            jdbc
                .sql(
                    "SELECT id::text FROM payments WHERE processor = :p AND status IN ('FAILED', 'CANCELLED', 'AUTHORIZED') AND created_at >= :from AND created_at < :to ORDER BY created_at LIMIT 1",
                ).param(
                    "p",
                    processor,
                ).param("from", Timestamp.from(range.from))
                .param("to", Timestamp.from(range.to))
                .query(String::class.java)
                .optional()
                .orElse(null)

        val report = generator.generate(processor, range, scenario, unexpected)
        report.lines.forEach { l ->
            jdbc
                .sql(
                    """
                INSERT INTO processor_settlement_records (id, report_id, line_number, processor, processor_txn_id, payment_reference, operation, amount, currency, settled_at)
                VALUES (:id, :rid, :n, :p, :txn, :ref, :op, :amt, :cur, :at)
                """,
                ).param(
                    "id",
                    UUID.randomUUID(),
                ).param("rid", reportId)
                .param("n", l.lineNumber)
                .param("p", processor)
                .param("txn", l.processorTxnId)
                .param(
                    "ref",
                    l.reference,
                ).param("op", l.operation)
                .param("amt", l.amount)
                .param("cur", l.currency)
                .param("at", Timestamp.from(range.to))
                .update()
        }

        val internal = loadInternal(processor, range, report.lines.map { it.reference }.distinct())
        val refs = report.lines.map { it.reference }.distinct()
        val known =
            if (refs.isEmpty()) {
                emptyMap()
            } else {
                jdbc
                    .sql("SELECT id::text AS id, status FROM payments WHERE id::text IN (:ids)")
                    .param("ids", refs)
                    .query { rs, _ -> rs.getString("id") to rs.getString("status") }
                    .list()
                    .toMap()
            }
        val result = ReconciliationMatcher.match(internal, report.lines, known)

        val now = Timestamp.from(clock.instant())
        var stored = 0
        for (f in result.findings) {
            val id = UUID.randomUUID()
            val details = LinkedHashMap(f.details)
            f.report?.let { details["reportLine"] = mapOf("lineNumber" to it.lineNumber, "processorTxnId" to it.processorTxnId) }
            val inserted =
                jdbc
                    .sql(
                        """
                INSERT INTO reconciliation_discrepancies (id, run_id, type, payment_reference, operation, internal_amount, internal_currency, report_amount, report_currency, internal_status, details, status, created_at)
                VALUES (:id, :run, :type, :ref, :op, :ia, :ic, :ra, :rc, :ist, CAST(:det AS jsonb), 'OPEN', :now)
                ON CONFLICT (run_id, type, payment_reference, operation) DO NOTHING
                """,
                    ).param("id", id)
                    .param("run", runId)
                    .param("type", f.type.name)
                    .param("ref", f.reference)
                    .param("op", f.operation)
                    .param(
                        "ia",
                        f.internal?.amount,
                    ).param("ic", f.internal?.currency)
                    .param("ra", f.report?.amount)
                    .param("rc", f.report?.currency)
                    .param(
                        "ist",
                        f.internal?.paymentStatus ?: known[f.reference],
                    ).param("det", mapper.writeValueAsString(details))
                    .param("now", now)
                    .update()
            if (inserted == 1) {
                stored++
                outbox.append(
                    DomainEventType.ReconciliationDiscrepancyDetected,
                    "discrepancy",
                    id,
                    mapOf(
                        "discrepancyId" to id.toString(),
                        "runId" to runId.toString(),
                        "type" to f.type.name,
                        "paymentReference" to f.reference,
                        "processor" to processor,
                    ),
                    correlation,
                )
            }
        }
        jdbc
            .sql(
                "UPDATE reconciliation_runs SET status = 'COMPLETED', internal_count = :ic, report_count = :rc, matched_count = :mc, discrepancy_count = :dc, completed_at = :now WHERE id = :id",
            ).param(
                "ic",
                internal.size,
            ).param("rc", report.lines.size)
            .param("mc", result.matched)
            .param("dc", stored)
            .param("now", now)
            .param("id", runId)
            .update()
    }

    /** Ledger postings in the window for this processor, plus any posting the report refers to (avoids false gaps at window edges). */
    private fun loadInternal(
        processor: String,
        range: TimeRange,
        referenced: List<String>,
    ): List<InternalLine> {
        val sql = """
            SELECT p.id::text AS ref, t.operation, t.amount, t.currency, p.status
              FROM ledger_transactions t JOIN payments p ON p.id = t.payment_id
             WHERE p.processor = :p AND (
                   (t.created_at >= :from AND t.created_at < :to)
                   ${if (referenced.isEmpty()) "" else "OR p.id::text IN (:refs)"})
        """
        var q =
            jdbc
                .sql(sql)
                .param("p", processor)
                .param("from", Timestamp.from(range.from))
                .param("to", Timestamp.from(range.to))
        if (referenced.isNotEmpty()) q = q.param("refs", referenced)
        return q
            .query {
                    rs,
                    _,
                ->
                InternalLine(
                    rs.getString("ref"),
                    rs.getString("operation"),
                    rs.getBigDecimal("amount"),
                    rs.getString("currency").trim(),
                    rs.getString("status"),
                )
            }.list()
    }

    fun getRun(id: UUID): RunView =
        jdbc
            .sql("SELECT * FROM reconciliation_runs WHERE id = :id")
            .param("id", id)
            .query {
                    rs,
                    _,
                ->
                runOf(rs)
            }.optional()
            .orElseThrow { NotFoundException("Reconciliation run", id) }

    fun listRuns(
        page: Int,
        size: Int,
    ): PageResponse<RunView> {
        Paging.validate(page, size)
        val total = jdbc.sql("SELECT COUNT(*) FROM reconciliation_runs").query(Long::class.java).single()
        val items =
            jdbc
                .sql("SELECT * FROM reconciliation_runs ORDER BY started_at DESC, id LIMIT :l OFFSET :o")
                .param("l", size)
                .param(
                    "o",
                    page * size,
                ).query { rs, _ -> runOf(rs) }
                .list()
        return PageResponse.of(items, page, size, total)
    }

    fun discrepancies(
        runId: UUID?,
        type: String?,
        status: String?,
        reference: String?,
        page: Int,
        size: Int,
    ): PageResponse<DiscrepancyView> {
        Paging.validate(page, size)
        if (runId != null) getRun(runId)
        type?.let { runCatching { DiscrepancyType.valueOf(it) }.getOrElse { throw ValidationException("unknown discrepancy type '$it'") } }
        status?.let { if (it !in setOf("OPEN", "ACKNOWLEDGED")) throw ValidationException("status must be OPEN or ACKNOWLEDGED") }
        val where = "WHERE (CAST(:run AS uuid) IS NULL OR run_id = CAST(:run AS uuid)) AND (CAST(:type AS text) IS NULL OR type = :type) AND (CAST(:status AS text) IS NULL OR status = :status) AND (CAST(:ref AS text) IS NULL OR payment_reference = :ref)"
        val total =
            jdbc
                .sql("SELECT COUNT(*) FROM reconciliation_discrepancies $where")
                .param("run", runId)
                .param("type", type)
                .param("status", status)
                .param("ref", reference)
                .query(Long::class.java)
                .single()
        val items =
            jdbc
                .sql("SELECT * FROM reconciliation_discrepancies $where ORDER BY created_at DESC, id LIMIT :l OFFSET :o")
                .param(
                    "run",
                    runId,
                ).param("type", type)
                .param("status", status)
                .param("ref", reference)
                .param("l", size)
                .param("o", page * size)
                .query { rs, _ -> discrepancyOf(rs) }
                .list()
        return PageResponse.of(items, page, size, total)
    }

    fun getDiscrepancy(id: UUID): DiscrepancyView =
        jdbc
            .sql("SELECT * FROM reconciliation_discrepancies WHERE id = :id")
            .param("id", id)
            .query {
                    rs,
                    _,
                ->
                discrepancyOf(rs)
            }.optional()
            .orElseThrow { NotFoundException("Discrepancy", id) }

    /** Records a human explanation. Financial records are deliberately left untouched. */
    fun acknowledge(
        id: UUID,
        explanation: String,
        actor: String,
    ): DiscrepancyView {
        val updated =
            jdbc
                .sql(
                    "UPDATE reconciliation_discrepancies SET status = 'ACKNOWLEDGED', explanation = :ex, acknowledged_by = :by, acknowledged_at = :at WHERE id = :id AND status = 'OPEN'",
                ).param("ex", explanation)
                .param("by", actor)
                .param("at", Timestamp.from(clock.instant()))
                .param("id", id)
                .update()
        if (updated == 0) {
            getDiscrepancy(id) // 404 if missing
            throw ConflictException("ALREADY_ACKNOWLEDGED", "This discrepancy was already acknowledged")
        }
        return getDiscrepancy(id)
    }

    private fun runOf(rs: ResultSet) =
        RunView(
            rs.getObject("id", UUID::class.java),
            rs.getString("processor"),
            rs.getTimestamp("window_from").toInstant(),
            rs.getTimestamp("window_to").toInstant(),
            rs.getString("scenario"),
            rs.getObject("report_id", UUID::class.java),
            rs.getString("status"),
            rs.getInt("internal_count"),
            rs.getInt("report_count"),
            rs.getInt("matched_count"),
            rs.getInt("discrepancy_count"),
            rs.getString("started_by"),
            rs.getString("error"),
            rs.getTimestamp("started_at").toInstant(),
            rs.getTimestamp("completed_at")?.toInstant(),
        )

    @Suppress("UNCHECKED_CAST")
    private fun discrepancyOf(rs: ResultSet) =
        DiscrepancyView(
            rs.getObject("id", UUID::class.java),
            rs.getObject("run_id", UUID::class.java),
            rs.getString("type"),
            rs.getString("payment_reference"),
            rs.getString("operation"),
            rs.getBigDecimal("internal_amount"),
            rs.getString("internal_currency")?.trim(),
            rs.getBigDecimal("report_amount"),
            rs.getString("report_currency")?.trim(),
            rs.getString("internal_status"),
            mapper.readValue(rs.getString("details"), Map::class.java) as Map<String, Any?>,
            rs.getString("status"),
            rs.getString("explanation"),
            rs.getString("acknowledged_by"),
            rs.getTimestamp("acknowledged_at")?.toInstant(),
            rs.getTimestamp("created_at").toInstant(),
        )
}
