package com.paysense.ai

import com.fasterxml.jackson.databind.ObjectMapper
import com.paysense.common.NotFoundException
import com.paysense.common.PageResponse
import com.paysense.common.Paging
import com.paysense.common.PaySenseProperties
import com.paysense.security.CurrentUser
import io.swagger.v3.oas.annotations.tags.Tag
import jakarta.validation.Valid
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.NotNull
import jakarta.validation.constraints.Size
import org.springframework.http.HttpStatus
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Service
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController
import java.sql.Timestamp
import java.time.Clock
import java.time.Instant
import java.util.UUID

enum class SubjectType { PAYMENT, INCIDENT, ANOMALY }

data class InvestigationRequest(
    @field:NotNull val subjectType: SubjectType?,
    @field:NotNull val subjectId: UUID?,
    @field:NotBlank @field:Size(min = 3, max = 1000) val question: String?,
)

data class AnalyticsQueryRequest(
    @field:NotBlank @field:Size(min = 3, max = 500) val question: String?,
)

data class InvestigationView(
    val id: UUID,
    val requestedBy: String,
    val subjectType: String,
    val subjectId: UUID,
    val question: String,
    /** RUNNING | COMPLETED | DEGRADED (AI unavailable, evidence-only result) | UNAVAILABLE | FAILED */
    val status: String,
    val result: Map<String, Any?>?,
    val provider: String?,
    val model: String?,
    val promptTokens: Int?,
    val completionTokens: Int?,
    val latencyMs: Int?,
    val errorCategory: String?,
    val createdAt: Instant,
    val completedAt: Instant?,
)

@Service
class AiInvestigationService(
    private val jdbc: JdbcClient,
    private val mapper: ObjectMapper,
    private val gateway: AiGateway,
    private val props: PaySenseProperties,
    private val clock: Clock,
) {
    fun start(
        req: InvestigationRequest,
        actor: String,
    ): InvestigationView {
        requireSubject(req.subjectType!!, req.subjectId!!)
        val id = UUID.randomUUID()
        val now = clock.instant()
        jdbc
            .sql(
                """
            INSERT INTO ai_investigations (id, requested_by, subject_type, subject_id, question, status, created_at, expires_at)
            VALUES (:id, :by, :st, :sid, :q, 'RUNNING', :now, :exp)
            """,
            ).param(
                "id",
                id,
            ).param("by", actor)
            .param("st", req.subjectType.name)
            .param("sid", req.subjectId)
            .param("q", req.question!!.trim())
            .param("now", Timestamp.from(now))
            .param("exp", Timestamp.from(now.plus(props.ai.retention)))
            .update()

        val started = System.nanoTime()
        try {
            val node = gateway.investigate(id, req.subjectType.name, req.subjectId, req.question.trim())
            val latency = ((System.nanoTime() - started) / 1_000_000).toInt()
            val status = node.path("status").asText("FAILED").takeIf { it in setOf("COMPLETED", "DEGRADED") } ?: "FAILED"
            val usage = node.path("usage")
            jdbc
                .sql(
                    """
                UPDATE ai_investigations SET status = :st, result = CAST(:res AS jsonb), provider = :prov, model = :model,
                       prompt_tokens = :pt, completion_tokens = :ct, latency_ms = :lat, error_category = :err, completed_at = :now WHERE id = :id
                """,
                ).param(
                    "st",
                    status,
                ).param("res", mapper.writeValueAsString(node))
                .param("prov", node.path("provider").asText(null)?.take(32))
                .param(
                    "model",
                    node.path("model").asText(null)?.take(64),
                ).param("pt", usage.path("promptTokens").takeIf { it.isNumber }?.asInt())
                .param("ct", usage.path("completionTokens").takeIf { it.isNumber }?.asInt())
                .param("lat", latency)
                .param(
                    "err",
                    node.path("errorCategory").asText(null)?.take(32),
                ).param("now", Timestamp.from(clock.instant()))
                .param("id", id)
                .update()
        } catch (e: AiUnavailableException) {
            jdbc
                .sql(
                    "UPDATE ai_investigations SET status = 'UNAVAILABLE', error_category = :err, latency_ms = :lat, completed_at = :now WHERE id = :id",
                ).param(
                    "err",
                    e.category,
                ).param(
                    "lat",
                    ((System.nanoTime() - started) / 1_000_000).toInt(),
                ).param("now", Timestamp.from(clock.instant()))
                .param("id", id)
                .update()
        }
        return get(id)
    }

    private fun requireSubject(
        type: SubjectType,
        id: UUID,
    ) {
        val table =
            when (type) {
                SubjectType.PAYMENT -> "payments"
                SubjectType.INCIDENT -> "incidents"
                SubjectType.ANOMALY -> "anomaly_events"
            }
        val exists =
            jdbc
                .sql("SELECT 1 FROM $table WHERE id = :id")
                .param("id", id)
                .query(Int::class.java)
                .optional()
                .isPresent
        if (!exists) throw NotFoundException(type.name.lowercase().replaceFirstChar { it.uppercase() }, id)
    }

    fun get(id: UUID): InvestigationView =
        jdbc
            .sql("SELECT * FROM ai_investigations WHERE id = :id")
            .param("id", id)
            .query {
                    rs,
                    _,
                ->
                view(rs)
            }.optional()
            .orElseThrow { NotFoundException("Investigation", id) }

    fun history(
        type: SubjectType?,
        subjectId: UUID?,
        page: Int,
        size: Int,
    ): PageResponse<InvestigationView> {
        Paging.validate(page, size)
        val where = "WHERE (CAST(:t AS text) IS NULL OR subject_type = :t) AND (CAST(:s AS uuid) IS NULL OR subject_id = CAST(:s AS uuid))"
        val total =
            jdbc
                .sql(
                    "SELECT COUNT(*) FROM ai_investigations $where",
                ).param("t", type?.name)
                .param("s", subjectId)
                .query(Long::class.java)
                .single()
        val items =
            jdbc
                .sql("SELECT * FROM ai_investigations $where ORDER BY created_at DESC, id LIMIT :l OFFSET :o")
                .param("t", type?.name)
                .param("s", subjectId)
                .param("l", size)
                .param("o", page * size)
                .query { rs, _ -> view(rs) }
                .list()
        return PageResponse.of(items, page, size, total)
    }

    @Suppress("UNCHECKED_CAST")
    private fun view(rs: java.sql.ResultSet) =
        InvestigationView(
            rs.getObject("id", UUID::class.java),
            rs.getString("requested_by"),
            rs.getString("subject_type"),
            rs.getObject("subject_id", UUID::class.java),
            rs.getString("question"),
            rs.getString("status"),
            rs.getString("result")?.let {
                mapper.readValue(it, Map::class.java) as Map<String, Any?>
            },
            rs.getString("provider"),
            rs.getString("model"),
            rs.getInt("prompt_tokens").takeUnless {
                rs.wasNull()
            },
            rs.getInt("completion_tokens").takeUnless { rs.wasNull() },
            rs.getInt("latency_ms").takeUnless { rs.wasNull() },
            rs.getString("error_category"),
            rs.getTimestamp("created_at").toInstant(),
            rs.getTimestamp("completed_at")?.toInstant(),
        )
}

@RestController
@RequestMapping("/api/v1/ai")
@Tag(name = "AI")
class AiController(
    private val investigations: AiInvestigationService,
    private val gateway: AiGateway,
    private val mapper: ObjectMapper,
) {
    @PostMapping("/investigations")
    @ResponseStatus(HttpStatus.CREATED)
    fun investigate(
        @Valid @RequestBody req: InvestigationRequest,
    ) = investigations.start(req, CurrentUser.name())

    @GetMapping("/investigations/{id}")
    fun get(
        @PathVariable id: UUID,
    ) = investigations.get(id)

    @GetMapping("/investigations")
    fun history(
        @RequestParam(required = false) subjectType: SubjectType?,
        @RequestParam(required = false) subjectId: UUID?,
        @RequestParam(defaultValue = "0") page: Int,
        @RequestParam(defaultValue = "20") size: Int,
    ) = investigations.history(subjectType, subjectId, page, size)

    @PostMapping("/analytics-queries")
    fun analytics(
        @Valid @RequestBody req: AnalyticsQueryRequest,
    ): Any =
        try {
            gateway.analyticsQuery(req.question!!.trim())
        } catch (e: AiUnavailableException) {
            mapOf(
                "status" to "UNAVAILABLE",
                "errorCategory" to e.category,
                "message" to "The AI service is unavailable. Dashboards and the analytics API remain fully functional.",
            )
        }

    @PostMapping("/runbook-questions")
    fun runbooks(
        @Valid @RequestBody req: AnalyticsQueryRequest,
    ): Any =
        try {
            gateway.runbookQuestion(req.question!!.trim())
        } catch (e: AiUnavailableException) {
            mapOf("status" to "UNAVAILABLE", "errorCategory" to e.category)
        }

    @GetMapping("/provider-status")
    fun providerStatus(): Any =
        try {
            gateway.providerStatus()
        } catch (e: AiUnavailableException) {
            mapOf("status" to "UNAVAILABLE", "errorCategory" to e.category)
        }

    @PostMapping("/anomalies/detect")
    fun detect(
        @RequestBody(required = false) body: Map<String, Any?>?,
    ): Any =
        try {
            gateway.detectAnomalies(body ?: emptyMap())
        } catch (e: AiUnavailableException) {
            mapOf("status" to "UNAVAILABLE", "errorCategory" to e.category)
        }
}
