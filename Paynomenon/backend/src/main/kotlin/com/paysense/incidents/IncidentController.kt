package com.paysense.incidents

import com.paysense.common.PageResponse
import com.paysense.common.ValidationException
import com.paysense.security.CurrentUser
import io.swagger.v3.oas.annotations.tags.Tag
import jakarta.validation.Valid
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
import org.springframework.format.annotation.DateTimeFormat
import org.springframework.http.HttpStatus
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController
import java.math.BigDecimal
import java.sql.Timestamp
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.UUID

data class CreateIncidentRequest(
    @field:NotBlank @field:Size(max = 200) val title: String?,
    val severity: String = "MEDIUM",
    @field:Size(max = 2000) val description: String? = null,
    @field:Size(max = 20) val components: List<String> = emptyList(),
    val startedAt: Instant? = null,
    @field:Size(max = 500) val paymentIds: List<UUID> = emptyList(),
    @field:Size(max = 100) val anomalyIds: List<UUID> = emptyList(),
    @field:Size(max = 100) val discrepancyIds: List<UUID> = emptyList(),
)

@RestController
@RequestMapping("/api/v1/incidents")
@Tag(name = "Incidents")
class IncidentController(
    private val service: IncidentService,
) {
    @GetMapping
    fun list(
        @RequestParam(required = false) status: String?,
        @RequestParam(defaultValue = "0") page: Int,
        @RequestParam(defaultValue = "20") size: Int,
    ): PageResponse<IncidentView> = service.list(status, page, size)

    @GetMapping("/{id}")
    fun get(
        @PathVariable id: UUID,
    ): IncidentDetail = service.detail(id)

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    fun create(
        @Valid @RequestBody req: CreateIncidentRequest,
    ): IncidentView {
        val id =
            service.create(
                CreateIncidentCommand(
                    req.title!!.trim(),
                    req.severity,
                    req.description,
                    req.components,
                    req.startedAt,
                    req.paymentIds,
                    req.anomalyIds,
                    req.discrepancyIds,
                ),
                CurrentUser.name(),
            )
        return service.get(id)
    }

    @PostMapping("/{id}/resolve")
    fun resolve(
        @PathVariable id: UUID,
    ) = service.resolve(id)

    @PostMapping("/{id}/summarize")
    fun summarize(
        @PathVariable id: UUID,
    ): Map<String, Any?> = service.summarize(id)
}

data class AnomalyInput(
    val metric: String,
    val dimension: String = "ALL",
    val windowStart: Instant,
    val windowEnd: Instant,
    val observed: BigDecimal,
    val baseline: BigDecimal,
    val threshold: BigDecimal,
    val score: BigDecimal,
    val direction: String,
    val severity: String,
    val method: String,
    val sampleSize: Int,
    val details: Map<String, Any?> = emptyMap(),
)

data class AnomalyView(
    val id: UUID,
    val metric: String,
    val dimension: String,
    val windowStart: Instant,
    val windowEnd: Instant,
    val observed: BigDecimal,
    val baseline: BigDecimal,
    val threshold: BigDecimal,
    val score: BigDecimal,
    val direction: String,
    val severity: String,
    val method: String,
    val sampleSize: Int,
    val details: Map<String, Any?>,
    val detectedAt: Instant,
)

data class AnomalyBatch(
    @field:Size(max = 200) val anomalies: List<AnomalyInput>,
)

data class AnomalyStored(
    val id: UUID,
    val created: Boolean,
)

@RestController
@RequestMapping("/api/v1")
@Tag(name = "Anomalies")
class AnomalyController(
    private val jdbc: JdbcClient,
    private val mapper: com.fasterxml.jackson.databind.ObjectMapper,
    private val incidents: IncidentService,
    private val clock: Clock,
) {
    @GetMapping("/anomalies")
    fun list(
        @RequestParam(required = false) metric: String?,
        @RequestParam(required = false) dimension: String?,
        @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) since: Instant?,
        @RequestParam(defaultValue = "0") page: Int,
        @RequestParam(defaultValue = "20") size: Int,
    ): PageResponse<AnomalyView> {
        com.paysense.common.Paging
            .validate(page, size)
        val floor = since ?: clock.instant().minus(Duration.ofDays(31))
        val total =
            jdbc
                .sql(
                    "SELECT COUNT(*) FROM anomaly_events WHERE detected_at >= :since AND (CAST(:m AS text) IS NULL OR metric = :m) AND (CAST(:d AS text) IS NULL OR dimension = :d)",
                ).param("since", Timestamp.from(floor))
                .param("m", metric)
                .param("d", dimension)
                .query(Long::class.java)
                .single()
        val items =
            jdbc
                .sql(
                    "SELECT * FROM anomaly_events WHERE detected_at >= :since AND (CAST(:m AS text) IS NULL OR metric = :m) AND (CAST(:d AS text) IS NULL OR dimension = :d) ORDER BY detected_at DESC, id LIMIT :l OFFSET :o",
                ).param("since", Timestamp.from(floor))
                .param("m", metric)
                .param("d", dimension)
                .param("l", size)
                .param("o", page * size)
                .query {
                        rs,
                        _,
                    ->
                    AnomalyView(
                        rs.getObject("id", UUID::class.java),
                        rs.getString("metric"),
                        rs.getString("dimension"),
                        rs.getTimestamp("window_start").toInstant(),
                        rs.getTimestamp("window_end").toInstant(),
                        rs.getBigDecimal("observed"),
                        rs.getBigDecimal("baseline"),
                        rs.getBigDecimal("threshold"),
                        rs.getBigDecimal("score"),
                        rs.getString("direction"),
                        rs.getString("severity"),
                        rs.getString("method"),
                        rs.getInt("sample_size"),
                        mapper.readValue(rs.getString("details"), Map::class.java).mapKeys {
                            it.key.toString()
                        },
                        rs.getTimestamp("detected_at").toInstant(),
                    )
                }.list()
        return PageResponse.of(items, page, size, total)
    }

    @GetMapping("/anomalies/{id}")
    fun anomaly(
        @org.springframework.web.bind.annotation.PathVariable id: UUID,
    ): AnomalyView =
        jdbc
            .sql("SELECT * FROM anomaly_events WHERE id = :id")
            .param("id", id)
            .query { rs, _ ->
                AnomalyView(
                    rs.getObject("id", UUID::class.java),
                    rs.getString("metric"),
                    rs.getString("dimension"),
                    rs.getTimestamp("window_start").toInstant(),
                    rs.getTimestamp("window_end").toInstant(),
                    rs.getBigDecimal("observed"),
                    rs.getBigDecimal("baseline"),
                    rs.getBigDecimal("threshold"),
                    rs.getBigDecimal("score"),
                    rs.getString("direction"),
                    rs.getString("severity"),
                    rs.getString("method"),
                    rs.getInt("sample_size"),
                    mapper.readValue(rs.getString("details"), Map::class.java).mapKeys {
                        it.key.toString()
                    },
                    rs.getTimestamp("detected_at").toInstant(),
                )
            }.optional()
            .orElseThrow { com.paysense.common.NotFoundException("Anomaly", id) }

    /** Called by the AI layer's statistical detector (service credential only). Idempotent per metric/dimension/window. */
    @PostMapping("/internal/anomalies")
    fun store(
        @Valid @RequestBody batch: AnomalyBatch,
    ): List<AnomalyStored> {
        val stored = mutableListOf<AnomalyStored>()
        val fresh = mutableListOf<LinkedAnomaly>()
        for (a in batch.anomalies) {
            if (a.direction !in setOf("HIGH", "LOW") ||
                a.severity !in setOf("LOW", "MEDIUM", "HIGH")
            ) {
                throw ValidationException("invalid direction or severity")
            }
            val id = UUID.randomUUID()
            val now = clock.instant()
            val inserted =
                jdbc
                    .sql(
                        """
                INSERT INTO anomaly_events (id, metric, dimension, window_start, window_end, observed, baseline, threshold, score, direction, severity, method, sample_size, details, detected_at)
                VALUES (:id, :metric, :dim, :ws, :we, :obs, :base, :thr, :score, :dir, :sev, :method, :n, CAST(:details AS jsonb), :now)
                ON CONFLICT (metric, dimension, window_start, window_end) DO NOTHING
                """,
                    ).param(
                        "id",
                        id,
                    ).param(
                        "metric",
                        a.metric.take(48),
                    ).param("dim", a.dimension.take(64))
                    .param("ws", Timestamp.from(a.windowStart))
                    .param("we", Timestamp.from(a.windowEnd))
                    .param(
                        "obs",
                        a.observed,
                    ).param(
                        "base",
                        a.baseline,
                    ).param("thr", a.threshold)
                    .param("score", a.score)
                    .param("dir", a.direction)
                    .param("sev", a.severity)
                    .param(
                        "method",
                        a.method.take(16),
                    ).param("n", a.sampleSize)
                    .param("details", mapper.writeValueAsString(a.details))
                    .param("now", Timestamp.from(now))
                    .update()
            if (inserted == 1) {
                stored += AnomalyStored(id, true)
                fresh += LinkedAnomaly(id, a.metric, a.dimension, a.severity, a.observed, a.baseline, a.windowStart, a.windowEnd, now)
            } else {
                val existing =
                    jdbc
                        .sql(
                            "SELECT id FROM anomaly_events WHERE metric = :m AND dimension = :d AND window_start = :ws AND window_end = :we",
                        ).param(
                            "m",
                            a.metric,
                        ).param(
                            "d",
                            a.dimension,
                        ).param("ws", Timestamp.from(a.windowStart))
                        .param("we", Timestamp.from(a.windowEnd))
                        .query(UUID::class.java)
                        .single()
                stored += AnomalyStored(existing, false)
            }
        }
        incidents.correlateAnomalies(fresh)
        return stored
    }
}
