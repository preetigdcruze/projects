package com.paysense.incidents

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.paysense.ai.AiGateway
import com.paysense.common.ConflictException
import com.paysense.common.NotFoundException
import com.paysense.common.PageResponse
import com.paysense.common.Paging
import com.paysense.common.ValidationException
import com.paysense.events.DomainEventType
import com.paysense.events.EventEnvelope
import com.paysense.events.EventHandler
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Component
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.math.BigDecimal
import java.sql.ResultSet
import java.sql.Timestamp
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.UUID

data class IncidentView(
    val id: UUID,
    val title: String,
    val status: String,
    val severity: String,
    val source: String,
    val components: List<String>,
    val description: String?,
    val startedAt: Instant,
    val resolvedAt: Instant?,
    val aiReport: Map<String, Any?>?,
    val aiReportAt: Instant?,
    val createdBy: String,
    val createdAt: Instant,
    val updatedAt: Instant,
    val counts: Map<String, Long>,
)

data class LinkedPayment(
    val id: UUID,
    val status: String,
    val amount: BigDecimal,
    val currency: String,
    val processor: String,
    val failureCode: String?,
    val createdAt: Instant,
)

data class LinkedAnomaly(
    val id: UUID,
    val metric: String,
    val dimension: String,
    val severity: String,
    val observed: BigDecimal,
    val baseline: BigDecimal,
    val windowStart: Instant,
    val windowEnd: Instant,
    val detectedAt: Instant,
)

data class LinkedDiscrepancy(
    val id: UUID,
    val type: String,
    val paymentReference: String,
    val status: String,
    val createdAt: Instant,
)

data class TimelineEntry(
    val at: Instant,
    val kind: String,
    val refId: String?,
    val title: String,
    val detail: String?,
    val paymentId: UUID?,
)

data class IncidentDetail(
    val incident: IncidentView,
    val payments: List<LinkedPayment>,
    val anomalies: List<LinkedAnomaly>,
    val discrepancies: List<LinkedDiscrepancy>,
    val deadLetterIds: List<UUID>,
    val timeline: List<TimelineEntry>,
)

data class CreateIncidentCommand(
    val title: String,
    val severity: String,
    val description: String?,
    val components: List<String>,
    val startedAt: Instant?,
    val paymentIds: List<UUID>,
    val anomalyIds: List<UUID>,
    val discrepancyIds: List<UUID>,
    val source: String = "MANUAL",
)

@Service
class IncidentService(
    private val jdbc: JdbcClient,
    private val mapper: ObjectMapper,
    private val ai: AiGateway,
    private val clock: Clock,
) {
    @Transactional
    fun create(
        cmd: CreateIncidentCommand,
        actor: String,
    ): UUID {
        if (cmd.severity !in setOf("LOW", "MEDIUM", "HIGH")) throw ValidationException("severity must be LOW, MEDIUM or HIGH")
        if (cmd.paymentIds.size + cmd.anomalyIds.size + cmd.discrepancyIds.size >
            500
        ) {
            throw ValidationException("too many linked items (max 500)")
        }
        val id = UUID.randomUUID()
        val now = Timestamp.from(clock.instant())
        jdbc
            .sql(
                """
            INSERT INTO incidents (id, title, status, severity, source, components, description, started_at, created_by, created_at, updated_at)
            VALUES (:id, :title, 'OPEN', :sev, :src, CAST(:comp AS jsonb), :desc, :started, :by, :now, :now)
            """,
            ).param("id", id)
            .param("title", cmd.title.take(200))
            .param("sev", cmd.severity)
            .param("src", cmd.source)
            .param("comp", mapper.writeValueAsString(cmd.components.distinct()))
            .param("desc", cmd.description?.take(2000))
            .param("started", Timestamp.from(cmd.startedAt ?: clock.instant()))
            .param("by", actor)
            .param("now", now)
            .update()
        cmd.paymentIds.distinct().forEach { link(id, "PAYMENT", it) }
        cmd.anomalyIds.distinct().forEach { link(id, "ANOMALY", it) }
        cmd.discrepancyIds.distinct().forEach { link(id, "DISCREPANCY", it) }
        return id
    }

    fun link(
        incidentId: UUID,
        type: String,
        refId: UUID,
    ) {
        jdbc
            .sql("INSERT INTO incident_links (incident_id, link_type, ref_id, linked_at) VALUES (:i, :t, :r, :now) ON CONFLICT DO NOTHING")
            .param("i", incidentId)
            .param("t", type)
            .param("r", refId)
            .param("now", Timestamp.from(clock.instant()))
            .update()
        jdbc
            .sql(
                "UPDATE incidents SET updated_at = :now WHERE id = :i",
            ).param("now", Timestamp.from(clock.instant()))
            .param("i", incidentId)
            .update()
    }

    fun resolve(id: UUID): IncidentView {
        val n =
            jdbc
                .sql("UPDATE incidents SET status = 'RESOLVED', resolved_at = :now, updated_at = :now WHERE id = :id AND status = 'OPEN'")
                .param("now", Timestamp.from(clock.instant()))
                .param("id", id)
                .update()
        if (n == 0) {
            get(id)
            throw ConflictException("ALREADY_RESOLVED", "Incident is already resolved")
        }
        return get(id)
    }

    fun list(
        status: String?,
        page: Int,
        size: Int,
    ): PageResponse<IncidentView> {
        Paging.validate(page, size)
        if (status != null && status !in setOf("OPEN", "RESOLVED")) throw ValidationException("status must be OPEN or RESOLVED")
        val total =
            jdbc
                .sql(
                    "SELECT COUNT(*) FROM incidents WHERE (CAST(:s AS text) IS NULL OR status = :s)",
                ).param("s", status)
                .query(Long::class.java)
                .single()
        val items =
            jdbc
                .sql(
                    "SELECT * FROM incidents WHERE (CAST(:s AS text) IS NULL OR status = :s) ORDER BY (status = 'OPEN') DESC, started_at DESC, id LIMIT :l OFFSET :o",
                ).param("s", status)
                .param("l", size)
                .param("o", page * size)
                .query { rs, _ -> view(rs) }
                .list()
        return PageResponse.of(items, page, size, total)
    }

    fun get(id: UUID): IncidentView =
        jdbc
            .sql("SELECT * FROM incidents WHERE id = :id")
            .param("id", id)
            .query {
                    rs,
                    _,
                ->
                view(rs)
            }.optional()
            .orElseThrow { NotFoundException("Incident", id) }

    fun detail(id: UUID): IncidentDetail {
        val incident = get(id)
        val payments =
            jdbc
                .sql(
                    """
            SELECT p.id, p.status, p.amount, p.currency, p.processor, p.failure_code, p.created_at FROM incident_links l JOIN payments p ON p.id = l.ref_id
             WHERE l.incident_id = :id AND l.link_type = 'PAYMENT' ORDER BY p.created_at LIMIT 100
            """,
                ).param("id", id)
                .query { rs, _ ->
                    LinkedPayment(
                        rs.getObject("id", UUID::class.java),
                        rs.getString("status"),
                        rs.getBigDecimal("amount"),
                        rs.getString("currency").trim(),
                        rs.getString("processor"),
                        rs.getString("failure_code"),
                        rs.getTimestamp("created_at").toInstant(),
                    )
                }.list()
        val anomalies =
            jdbc
                .sql(
                    """
            SELECT a.* FROM incident_links l JOIN anomaly_events a ON a.id = l.ref_id WHERE l.incident_id = :id AND l.link_type = 'ANOMALY' ORDER BY a.window_start LIMIT 100
            """,
                ).param("id", id)
                .query { rs, _ ->
                    LinkedAnomaly(
                        rs.getObject("id", UUID::class.java),
                        rs.getString("metric"),
                        rs.getString("dimension"),
                        rs.getString("severity"),
                        rs.getBigDecimal("observed"),
                        rs.getBigDecimal("baseline"),
                        rs.getTimestamp("window_start").toInstant(),
                        rs.getTimestamp("window_end").toInstant(),
                        rs.getTimestamp("detected_at").toInstant(),
                    )
                }.list()
        val discrepancies =
            jdbc
                .sql(
                    """
            SELECT d.id, d.type, d.payment_reference, d.status, d.created_at FROM incident_links l JOIN reconciliation_discrepancies d ON d.id = l.ref_id
             WHERE l.incident_id = :id AND l.link_type = 'DISCREPANCY' ORDER BY d.created_at LIMIT 100
            """,
                ).param("id", id)
                .query { rs, _ ->
                    LinkedDiscrepancy(
                        rs.getObject("id", UUID::class.java),
                        rs.getString("type"),
                        rs.getString("payment_reference"),
                        rs.getString("status"),
                        rs.getTimestamp("created_at").toInstant(),
                    )
                }.list()
        val deadLetters =
            jdbc
                .sql(
                    "SELECT ref_id FROM incident_links WHERE incident_id = :id AND link_type = 'DEAD_LETTER' LIMIT 100",
                ).param("id", id)
                .query(UUID::class.java)
                .list()

        val timeline = mutableListOf<TimelineEntry>()
        timeline +=
            TimelineEntry(
                incident.startedAt,
                "INCIDENT",
                incident.id.toString(),
                "Incident opened: ${incident.title}",
                incident.description,
                null,
            )
        incident.resolvedAt?.let { timeline += TimelineEntry(it, "INCIDENT", incident.id.toString(), "Incident resolved", null, null) }
        anomalies.forEach {
            timeline +=
                TimelineEntry(
                    it.detectedAt,
                    "ANOMALY",
                    it.id.toString(),
                    "${it.severity} anomaly: ${it.metric} on ${it.dimension}",
                    "observed ${it.observed.toPlainString()} vs baseline ${it.baseline.toPlainString()}",
                    null,
                )
        }
        discrepancies.forEach {
            timeline +=
                TimelineEntry(
                    it.createdAt,
                    "DISCREPANCY",
                    it.id.toString(),
                    "Reconciliation discrepancy ${it.type}",
                    "payment ${it.paymentReference}",
                    null,
                )
        }
        if (payments.isNotEmpty()) {
            jdbc
                .sql(
                    """
                SELECT e.id, e.payment_id, e.event_type, e.from_status, e.to_status, e.occurred_at FROM payment_events e
                 WHERE e.payment_id IN (:ids) AND e.event_type <> 'OPERATION_STARTED' ORDER BY e.occurred_at DESC LIMIT 200
                """,
                ).param("ids", payments.map { it.id })
                .query { rs, _ ->
                    TimelineEntry(
                        rs.getTimestamp("occurred_at").toInstant(),
                        "PAYMENT_EVENT",
                        rs.getString("id"),
                        "${rs.getString("event_type")} (${rs.getString("from_status") ?: "-"} → ${rs.getString("to_status") ?: "-"})",
                        null,
                        rs.getObject("payment_id", UUID::class.java),
                    )
                }.list()
                .also { timeline += it }
            jdbc
                .sql(
                    "SELECT id, occurred_at, level, component, message, payment_id FROM operational_logs WHERE payment_id IN (:ids) AND level IN ('WARN','ERROR') ORDER BY occurred_at DESC LIMIT 100",
                ).param("ids", payments.map { it.id })
                .query { rs, _ ->
                    TimelineEntry(
                        rs.getTimestamp("occurred_at").toInstant(),
                        "LOG",
                        rs.getLong("id").toString(),
                        "[${rs.getString("level")}] ${rs.getString("component")}",
                        rs.getString("message"),
                        rs.getObject("payment_id", UUID::class.java),
                    )
                }.list()
                .also { timeline += it }
        }
        return IncidentDetail(incident, payments, anomalies, discrepancies, deadLetters, timeline.sortedBy { it.at })
    }

    /** Asks the AI layer for a structured, evidence-backed report and stores it next to the incident. */
    fun summarize(id: UUID): Map<String, Any?> {
        get(id)
        val result: JsonNode = ai.summarizeIncident(id)
        val map = mapper.convertValue(result, Map::class.java).mapKeys { it.key.toString() }
        jdbc
            .sql("UPDATE incidents SET ai_report = CAST(:r AS jsonb), ai_report_at = :now, updated_at = :now WHERE id = :id")
            .param("r", mapper.writeValueAsString(map))
            .param("now", Timestamp.from(clock.instant()))
            .param("id", id)
            .update()
        return map
    }

    /** Attach anomalies to an incident for the same processor/dimension, opening one if none is active. */
    @Transactional
    fun correlateAnomalies(anomalies: List<LinkedAnomaly>) {
        for (a in anomalies.filter { it.severity != "LOW" }) {
            val existing =
                jdbc
                    .sql(
                        """
                SELECT id FROM incidents WHERE status = 'OPEN' AND source = 'ANOMALY' AND jsonb_exists(components, :dim) AND started_at > :since ORDER BY started_at DESC LIMIT 1
                """,
                    ).param(
                        "dim",
                        a.dimension,
                    ).param("since", Timestamp.from(clock.instant().minus(Duration.ofHours(3))))
                    .query(UUID::class.java)
                    .optional()
                    .orElse(null)
            val incidentId =
                existing ?: create(
                    CreateIncidentCommand(
                        "${a.metric.lowercase().replace('_', ' ')} anomaly on ${a.dimension}",
                        a.severity,
                        "Opened automatically from a statistical anomaly; see linked evidence.",
                        listOf(a.dimension),
                        a.windowStart,
                        emptyList(),
                        emptyList(),
                        emptyList(),
                        "ANOMALY",
                    ),
                    "anomaly-correlator",
                )
            link(incidentId, "ANOMALY", a.id)
            if (a.dimension != "ALL") {
                jdbc
                    .sql(
                        "SELECT id FROM payments WHERE processor = :p AND created_at >= :from AND created_at < :to AND (status = 'FAILED' OR status = 'UNCERTAIN') ORDER BY created_at LIMIT 25",
                    ).param(
                        "p",
                        a.dimension,
                    ).param("from", Timestamp.from(a.windowStart))
                    .param("to", Timestamp.from(a.windowEnd))
                    .query(UUID::class.java)
                    .list()
                    .forEach { link(incidentId, "PAYMENT", it) }
            }
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun view(rs: ResultSet): IncidentView {
        val id = rs.getObject("id", UUID::class.java)
        val counts =
            jdbc
                .sql("SELECT link_type, COUNT(*) AS n FROM incident_links WHERE incident_id = :id GROUP BY link_type")
                .param("id", id)
                .query { r, _ -> r.getString("link_type").lowercase() to r.getLong("n") }
                .list()
                .toMap()
        return IncidentView(
            id,
            rs.getString("title"),
            rs.getString("status"),
            rs.getString("severity"),
            rs.getString("source"),
            mapper.readValue(rs.getString("components"), List::class.java).map { it.toString() },
            rs.getString("description"),
            rs.getTimestamp("started_at").toInstant(),
            rs.getTimestamp("resolved_at")?.toInstant(),
            rs.getString("ai_report")?.let { mapper.readValue(it, Map::class.java) as Map<String, Any?> },
            rs.getTimestamp("ai_report_at")?.toInstant(),
            rs.getString("created_by"),
            rs.getTimestamp("created_at").toInstant(),
            rs.getTimestamp("updated_at").toInstant(),
            counts,
        )
    }
}

/** Reacts to reconciliation findings by grouping them into one open incident per processor and day. */
@Component
class DiscrepancyIncidentHandler(
    private val incidents: IncidentService,
    private val jdbc: JdbcClient,
    private val clock: Clock,
) : EventHandler {
    override val name = "discrepancy-incident-linker"

    override fun supports(eventType: String) = eventType == DomainEventType.ReconciliationDiscrepancyDetected.name

    override fun handle(event: EventEnvelope) {
        val processor = event.payload["processor"] as? String ?: throw IllegalArgumentException("event payload has no processor")
        val discrepancyId =
            UUID.fromString(
                event.payload["discrepancyId"] as? String ?: throw IllegalArgumentException("event payload has no discrepancyId"),
            )
        val title = "Reconciliation discrepancies on $processor"
        val existing =
            jdbc
                .sql(
                    "SELECT id FROM incidents WHERE status = 'OPEN' AND source = 'DISCREPANCY' AND title = :t AND started_at > :since ORDER BY started_at DESC LIMIT 1",
                ).param(
                    "t",
                    title,
                ).param("since", Timestamp.from(clock.instant().minus(Duration.ofHours(24))))
                .query(UUID::class.java)
                .optional()
                .orElse(null)
        val incidentId =
            existing ?: incidents.create(
                CreateIncidentCommand(
                    title,
                    "MEDIUM",
                    "Opened automatically when reconciliation found differences against the processor report.",
                    listOf(processor),
                    clock.instant(),
                    emptyList(),
                    emptyList(),
                    emptyList(),
                    "DISCREPANCY",
                ),
                "discrepancy-linker",
            )
        incidents.link(incidentId, "DISCREPANCY", discrepancyId)
    }
}
