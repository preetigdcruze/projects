package com.paysense.observability

import com.fasterxml.jackson.databind.ObjectMapper
import com.paysense.common.PageResponse
import com.paysense.common.Paging
import com.paysense.common.PaySenseProperties
import com.paysense.common.TimeRange
import io.swagger.v3.oas.annotations.tags.Tag
import org.springframework.format.annotation.DateTimeFormat
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import java.sql.Timestamp
import java.time.Clock
import java.time.Instant
import java.util.UUID

data class LogEntryView(
    val id: Long,
    val occurredAt: Instant,
    val level: String,
    val component: String,
    val message: String,
    val correlationId: String?,
    val paymentId: UUID?,
    val attributes: Map<String, Any?>,
)

/** Read-only access to curated operational log lines. INVESTIGATOR role or above (messages can contain processor text). */
@RestController
@RequestMapping("/api/v1/operational-logs")
@Tag(name = "Operational logs")
class LogsController(
    private val jdbc: JdbcClient,
    private val mapper: ObjectMapper,
    private val props: PaySenseProperties,
    private val clock: Clock,
) {
    @GetMapping
    fun search(
        @RequestParam(required = false) paymentId: UUID?,
        @RequestParam(required = false) correlationId: String?,
        @RequestParam(required = false) component: String?,
        @RequestParam(required = false) level: String?,
        @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) from: Instant?,
        @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) to: Instant?,
        @RequestParam(defaultValue = "0") page: Int,
        @RequestParam(defaultValue = "50") size: Int,
    ): PageResponse<LogEntryView> {
        Paging.validate(page, size)
        val range = TimeRange.resolve(from, to, clock.instant(), props.analytics.maxWindow, props.analytics.maxWindow)
        val where = """
            WHERE occurred_at >= :from AND occurred_at < :to
              AND (CAST(:pid AS uuid) IS NULL OR payment_id = CAST(:pid AS uuid))
              AND (CAST(:corr AS text) IS NULL OR correlation_id = :corr)
              AND (CAST(:comp AS text) IS NULL OR component = :comp)
              AND (CAST(:level AS text) IS NULL OR level = :level)
        """

        fun q(sql: String) =
            jdbc
                .sql(sql)
                .param("from", Timestamp.from(range.from))
                .param("to", Timestamp.from(range.to))
                .param("pid", paymentId)
                .param("corr", correlationId)
                .param("comp", component)
                .param("level", level?.uppercase())
        val total = q("SELECT COUNT(*) FROM operational_logs $where").query(Long::class.java).single()
        val items =
            q("SELECT * FROM operational_logs $where ORDER BY occurred_at DESC, id DESC LIMIT :l OFFSET :o")
                .param("l", size)
                .param(
                    "o",
                    page * size,
                ).query { rs, _ ->
                    LogEntryView(
                        rs.getLong("id"),
                        rs.getTimestamp("occurred_at").toInstant(),
                        rs.getString("level"),
                        rs.getString("component"),
                        rs.getString("message"),
                        rs.getString("correlation_id"),
                        rs.getObject("payment_id", UUID::class.java),
                        mapper.readValue(rs.getString("attributes"), Map::class.java).mapKeys {
                            it.key.toString()
                        },
                    )
                }.list()
        return PageResponse.of(items, page, size, total)
    }
}
