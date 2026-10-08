package com.paysense.analytics

import com.fasterxml.jackson.databind.ObjectMapper
import com.paysense.common.PaySenseProperties
import com.paysense.common.TimeRange
import com.paysense.common.ValidationException
import io.swagger.v3.oas.annotations.tags.Tag
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.ObjectProvider
import org.springframework.data.redis.core.StringRedisTemplate
import org.springframework.format.annotation.DateTimeFormat
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Service
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import java.math.BigDecimal
import java.math.RoundingMode
import java.sql.Timestamp
import java.time.Clock
import java.time.Duration
import java.time.Instant

data class Range(
    val from: Instant,
    val to: Instant,
)

data class StatusTotals(
    val total: Long,
    val successful: Long,
    val failed: Long,
    val pending: Long,
    val uncertain: Long,
    val cancelled: Long,
)

data class VolumeByCurrency(
    val currency: String,
    val capturedAmount: BigDecimal,
    val capturedCount: Long,
)

data class LatencySummary(
    val p50: Long?,
    val p95: Long?,
    val p99: Long?,
    val sampleSize: Long,
    val sufficientSample: Boolean,
    val minSample: Int,
)

data class Overview(
    val range: Range,
    val totals: StatusTotals,
    val successRate: BigDecimal?,
    val volume: List<VolumeByCurrency>,
    val latency: LatencySummary,
    val syntheticDataPresent: Boolean,
    val openDiscrepancies: Long,
    val openIncidents: Long,
    val deadLetters: Long,
    val generatedAt: Instant,
)

enum class Bucket(
    val sql: String,
    val duration: Duration,
) {
    MINUTE_5("5 minutes", Duration.ofMinutes(5)),
    MINUTE_15("15 minutes", Duration.ofMinutes(15)),
    HOUR("1 hour", Duration.ofHours(1)),
    DAY("1 day", Duration.ofDays(1)),
}

data class TrendPoint(
    val bucketStart: Instant,
    val total: Long,
    val successful: Long,
    val failed: Long,
    val uncertain: Long,
    val failureRate: BigDecimal?,
)

data class FailureReason(
    val reason: String,
    val category: String,
    val count: Long,
    val share: BigDecimal,
)

data class ProcessorStats(
    val processor: String,
    val attempts: Long,
    val approved: Long,
    val declined: Long,
    val invalid: Long,
    val unavailable: Long,
    val timeouts: Long,
    val failureRate: BigDecimal?,
    val timeoutRate: BigDecimal?,
    val latency: LatencySummary,
)

enum class Metric(
    val description: String,
) {
    FAILURE_RATE("Share of completed processor attempts that did not end in approval"),
    TIMEOUT_RATE("Share of completed processor attempts that timed out"),
    PROCESSOR_LATENCY_P95("95th percentile processor response time (ms) over responded attempts"),
    THROUGHPUT("Payments created per bucket"),
    DISCREPANCY_COUNT("Reconciliation discrepancies recorded per bucket"),
}

data class SeriesPoint(
    val bucketStart: Instant,
    val value: BigDecimal?,
    val sampleSize: Long,
)

data class Series(
    val metric: Metric,
    val processor: String?,
    val bucket: Bucket,
    val range: Range,
    val points: List<SeriesPoint>,
)

private const val SUCCESS_SET = "'AUTHORIZED','CAPTURING','CAPTURED','REFUNDING','REFUNDED'"
private const val PENDING_SET = "'CREATED','PROCESSING'"
private const val RESPONDED = "status IN ('APPROVED','DECLINED','INVALID')"
private const val COMPLETED_ATTEMPT = "status <> 'STARTED'"

/** Read-only, parameterised aggregate queries. These are the only numbers the AI layer may use. */
@Service
class AnalyticsService(
    private val jdbc: JdbcClient,
    private val props: PaySenseProperties,
    private val clock: Clock,
    private val redis: ObjectProvider<StringRedisTemplate>,
    private val mapper: ObjectMapper,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    fun range(
        from: Instant?,
        to: Instant?,
    ): TimeRange = TimeRange.resolve(from, to, clock.instant(), props.analytics.defaultWindow, props.analytics.maxWindow)

    fun overview(
        from: Instant?,
        to: Instant?,
    ): Overview {
        val cacheable = from == null && to == null && props.redis.enabled
        val key = "paysense:cache:overview:default"
        if (cacheable) {
            cached(key)?.let { return it }
        }
        val r = range(from, to)
        val result = computeOverview(r)
        if (cacheable) store(key, result)
        return result
    }

    private fun cached(key: String): Overview? =
        try {
            redis.ifAvailable
                ?.opsForValue()
                ?.get(key)
                ?.let { mapper.readValue(it, Overview::class.java) }
        } catch (e: Exception) {
            log.debug("Overview cache read skipped: {}", e.javaClass.simpleName)
            null
        }

    private fun store(
        key: String,
        value: Overview,
    ) {
        try {
            redis.ifAvailable?.opsForValue()?.set(key, mapper.writeValueAsString(value), props.analytics.cacheTtl)
        } catch (e: Exception) {
            log.debug("Overview cache write skipped: {}", e.javaClass.simpleName)
        }
    }

    private fun computeOverview(r: TimeRange): Overview {
        val p = mapOf("from" to Timestamp.from(r.from), "to" to Timestamp.from(r.to))
        val totals =
            jdbc
                .sql(
                    """
            SELECT COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE status IN ($SUCCESS_SET)) AS successful,
                   COUNT(*) FILTER (WHERE status = 'FAILED') AS failed,
                   COUNT(*) FILTER (WHERE status IN ($PENDING_SET)) AS pending,
                   COUNT(*) FILTER (WHERE status = 'UNCERTAIN') AS uncertain,
                   COUNT(*) FILTER (WHERE status = 'CANCELLED') AS cancelled,
                   COUNT(*) FILTER (WHERE synthetic) AS synthetic
              FROM payments WHERE created_at >= :from AND created_at < :to
            """,
                ).params(p)
                .query { rs, _ ->
                    StatusTotals(
                        rs.getLong("total"),
                        rs.getLong("successful"),
                        rs.getLong("failed"),
                        rs.getLong("pending"),
                        rs.getLong("uncertain"),
                        rs.getLong("cancelled"),
                    ) to
                        (rs.getLong("synthetic") > 0)
                }.single()
        val volume =
            jdbc
                .sql(
                    "SELECT currency, SUM(amount) AS amt, COUNT(*) AS n FROM payments WHERE captured_at >= :from AND captured_at < :to GROUP BY currency ORDER BY currency",
                ).params(p)
                .query { rs, _ -> VolumeByCurrency(rs.getString("currency").trim(), rs.getBigDecimal("amt"), rs.getLong("n")) }
                .list()
        val decided = totals.first.successful + totals.first.failed
        return Overview(
            Range(r.from, r.to),
            totals.first,
            ratio(totals.first.successful, decided),
            volume,
            latency(r.from, r.to, null),
            totals.second,
            count("SELECT COUNT(*) FROM reconciliation_discrepancies WHERE status = 'OPEN'"),
            count("SELECT COUNT(*) FROM incidents WHERE status = 'OPEN'"),
            count("SELECT COUNT(*) FROM dead_letter_events WHERE status = 'DEAD'"),
            clock.instant(),
        )
    }

    private fun count(sql: String) = jdbc.sql(sql).query(Long::class.java).single()

    fun latency(
        from: Instant,
        to: Instant,
        processor: String?,
    ): LatencySummary {
        val row =
            jdbc
                .sql(
                    """
            SELECT COUNT(*) AS n,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY response_time_ms) AS p50,
                   percentile_cont(0.95) WITHIN GROUP (ORDER BY response_time_ms) AS p95,
                   percentile_cont(0.99) WITHIN GROUP (ORDER BY response_time_ms) AS p99
              FROM payment_attempts
             WHERE started_at >= :from AND started_at < :to AND $RESPONDED AND response_time_ms IS NOT NULL
               AND (CAST(:proc AS text) IS NULL OR processor = :proc)
            """,
                ).param("from", Timestamp.from(from))
                .param("to", Timestamp.from(to))
                .param("proc", processor)
                .query { rs, _ ->
                    Triple(rs.getLong("n"), listOf(rs.getBigDecimal("p50"), rs.getBigDecimal("p95"), rs.getBigDecimal("p99")), Unit)
                }.single()
        val enough = row.first >= props.analytics.minLatencySample

        fun v(i: Int) = if (enough) row.second[i]?.setScale(0, RoundingMode.HALF_UP)?.toLong() else null
        return LatencySummary(v(0), v(1), v(2), row.first, enough, props.analytics.minLatencySample)
    }

    fun trends(
        from: Instant?,
        to: Instant?,
        bucket: Bucket,
    ): List<TrendPoint> {
        val r = range(from, to)
        if (Duration.between(r.from, r.to).dividedBy(bucket.duration) >
            1000
        ) {
            throw ValidationException("too many buckets requested; use a larger bucket or a shorter range")
        }
        return jdbc
            .sql(
                """
            SELECT date_bin(CAST(:bucket AS interval), created_at, TIMESTAMPTZ '2000-01-01') AS b,
                   COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE status IN ($SUCCESS_SET)) AS successful,
                   COUNT(*) FILTER (WHERE status = 'FAILED') AS failed,
                   COUNT(*) FILTER (WHERE status = 'UNCERTAIN') AS uncertain
              FROM payments WHERE created_at >= :from AND created_at < :to GROUP BY b ORDER BY b
            """,
            ).param("bucket", bucket.sql)
            .param("from", Timestamp.from(r.from))
            .param("to", Timestamp.from(r.to))
            .query { rs, _ ->
                val s = rs.getLong("successful")
                val f = rs.getLong("failed")
                TrendPoint(rs.getTimestamp("b").toInstant(), rs.getLong("total"), s, f, rs.getLong("uncertain"), ratio(f, s + f))
            }.list()
    }

    fun failureReasons(
        from: Instant?,
        to: Instant?,
        limit: Int = 20,
    ): List<FailureReason> {
        val r = range(from, to)
        val rows =
            jdbc
                .sql(
                    """
            SELECT COALESCE(response_code, 'UNKNOWN') AS reason, COALESCE(failure_category, 'UNKNOWN') AS category, COUNT(*) AS n
              FROM payment_attempts
             WHERE started_at >= :from AND started_at < :to AND $COMPLETED_ATTEMPT AND status <> 'APPROVED'
             GROUP BY 1, 2 ORDER BY n DESC, 1 LIMIT :limit
            """,
                ).param("from", Timestamp.from(r.from))
                .param("to", Timestamp.from(r.to))
                .param("limit", limit.coerceIn(1, 50))
                .query { rs, _ ->
                    Triple(rs.getString("reason"), rs.getString("category"), rs.getLong("n"))
                }.list()
        val total = rows.sumOf { it.third }
        return rows.map { FailureReason(it.first, it.second, it.third, ratio(it.third, total) ?: BigDecimal.ZERO) }
    }

    fun processors(
        from: Instant?,
        to: Instant?,
    ): List<ProcessorStats> {
        val r = range(from, to)
        val rows =
            jdbc
                .sql(
                    """
            SELECT processor,
                   COUNT(*) AS attempts,
                   COUNT(*) FILTER (WHERE status = 'APPROVED') AS approved,
                   COUNT(*) FILTER (WHERE status = 'DECLINED') AS declined,
                   COUNT(*) FILTER (WHERE status = 'INVALID') AS invalid,
                   COUNT(*) FILTER (WHERE status = 'UNAVAILABLE') AS unavailable,
                   COUNT(*) FILTER (WHERE status = 'TIMEOUT') AS timeouts
              FROM payment_attempts WHERE started_at >= :from AND started_at < :to AND $COMPLETED_ATTEMPT
             GROUP BY processor ORDER BY processor
            """,
                ).param("from", Timestamp.from(r.from))
                .param("to", Timestamp.from(r.to))
                .query { rs, _ ->
                    val attempts = rs.getLong("attempts")
                    val approved = rs.getLong("approved")
                    ProcessorStats(
                        rs.getString("processor"),
                        attempts,
                        approved,
                        rs.getLong("declined"),
                        rs.getLong("invalid"),
                        rs.getLong("unavailable"),
                        rs.getLong("timeouts"),
                        ratio(attempts - approved, attempts),
                        ratio(rs.getLong("timeouts"), attempts),
                        LatencySummary(null, null, null, 0, false, props.analytics.minLatencySample),
                    )
                }.list()
        return rows.map { it.copy(latency = latency(r.from, r.to, it.processor)) }
    }

    /** Bucketed time series used by the statistical anomaly detector. Values are null where the denominator is zero. */
    fun series(
        metric: Metric,
        from: Instant?,
        to: Instant?,
        bucket: Bucket,
        processor: String?,
    ): Series {
        val r = range(from, to)
        if (Duration.between(r.from, r.to).dividedBy(bucket.duration) >
            2000
        ) {
            throw ValidationException("too many buckets requested; use a larger bucket or a shorter range")
        }
        val (sql, scale) =
            when (metric) {
                Metric.FAILURE_RATE ->
                    """
                SELECT date_bin(CAST(:bucket AS interval), started_at, TIMESTAMPTZ '2000-01-01') AS b,
                       COUNT(*) AS n, COUNT(*) FILTER (WHERE status <> 'APPROVED') AS x
                  FROM payment_attempts WHERE started_at >= :from AND started_at < :to AND $COMPLETED_ATTEMPT AND (CAST(:proc AS text) IS NULL OR processor = :proc)
                 GROUP BY b ORDER BY b""" to 6
                Metric.TIMEOUT_RATE ->
                    """
                SELECT date_bin(CAST(:bucket AS interval), started_at, TIMESTAMPTZ '2000-01-01') AS b,
                       COUNT(*) AS n, COUNT(*) FILTER (WHERE status = 'TIMEOUT') AS x
                  FROM payment_attempts WHERE started_at >= :from AND started_at < :to AND $COMPLETED_ATTEMPT AND (CAST(:proc AS text) IS NULL OR processor = :proc)
                 GROUP BY b ORDER BY b""" to 6
                Metric.PROCESSOR_LATENCY_P95 ->
                    """
                SELECT date_bin(CAST(:bucket AS interval), started_at, TIMESTAMPTZ '2000-01-01') AS b,
                       COUNT(*) AS n, percentile_cont(0.95) WITHIN GROUP (ORDER BY response_time_ms) AS x
                  FROM payment_attempts WHERE started_at >= :from AND started_at < :to AND $RESPONDED AND response_time_ms IS NOT NULL AND (CAST(:proc AS text) IS NULL OR processor = :proc)
                 GROUP BY b ORDER BY b""" to 2
                Metric.THROUGHPUT ->
                    """
                SELECT date_bin(CAST(:bucket AS interval), created_at, TIMESTAMPTZ '2000-01-01') AS b, COUNT(*) AS n, COUNT(*) AS x
                  FROM payments WHERE created_at >= :from AND created_at < :to AND (CAST(:proc AS text) IS NULL OR processor = :proc)
                 GROUP BY b ORDER BY b""" to 0
                Metric.DISCREPANCY_COUNT ->
                    """
                SELECT date_bin(CAST(:bucket AS interval), d.created_at, TIMESTAMPTZ '2000-01-01') AS b, COUNT(*) AS n, COUNT(*) AS x
                  FROM reconciliation_discrepancies d JOIN reconciliation_runs r ON r.id = d.run_id
                 WHERE d.created_at >= :from AND d.created_at < :to AND (CAST(:proc AS text) IS NULL OR r.processor = :proc)
                 GROUP BY b ORDER BY b""" to 0
            }
        val rate = metric == Metric.FAILURE_RATE || metric == Metric.TIMEOUT_RATE
        val points =
            jdbc
                .sql(
                    sql,
                ).param(
                    "bucket",
                    bucket.sql,
                ).param("from", Timestamp.from(r.from))
                .param("to", Timestamp.from(r.to))
                .param("proc", processor)
                .query {
                        rs,
                        _,
                    ->
                    val n = rs.getLong("n")
                    val x = rs.getBigDecimal("x")
                    val value =
                        when {
                            rate -> if (n == 0L) null else x.divide(BigDecimal(n), scale, RoundingMode.HALF_UP)
                            else -> x?.setScale(scale, RoundingMode.HALF_UP)
                        }
                    SeriesPoint(rs.getTimestamp("b").toInstant(), value, n)
                }.list()
        return Series(metric, processor, bucket, Range(r.from, r.to), points)
    }

    private fun ratio(
        num: Long,
        den: Long,
    ): BigDecimal? =
        if (den ==
            0L
        ) {
            null
        } else {
            BigDecimal(num).divide(BigDecimal(den), 4, RoundingMode.HALF_UP)
        }
}

@RestController
@RequestMapping("/api/v1/analytics")
@Tag(name = "Analytics")
class AnalyticsController(
    private val service: AnalyticsService,
) {
    @GetMapping("/overview")
    fun overview(
        @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) from: Instant?,
        @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) to: Instant?,
    ) = service.overview(from, to)

    @GetMapping("/payment-trends")
    fun trends(
        @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) from: Instant?,
        @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) to: Instant?,
        @RequestParam(defaultValue = "HOUR") bucket: Bucket,
    ) = service.trends(from, to, bucket)

    @GetMapping("/failure-reasons")
    fun failureReasons(
        @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) from: Instant?,
        @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) to: Instant?,
        @RequestParam(defaultValue = "10") limit: Int,
    ) = service.failureReasons(from, to, limit)

    @GetMapping("/processors")
    fun processors(
        @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) from: Instant?,
        @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) to: Instant?,
    ) = service.processors(from, to)

    @GetMapping("/timeseries")
    fun timeseries(
        @RequestParam metric: Metric,
        @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) from: Instant?,
        @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) to: Instant?,
        @RequestParam(defaultValue = "HOUR") bucket: Bucket,
        @RequestParam(required = false) processor: String?,
    ) = service.series(metric, from, to, bucket, processor)

    @GetMapping("/metrics")
    fun metrics() = Metric.entries.map { mapOf("id" to it.name, "description" to it.description) }
}
