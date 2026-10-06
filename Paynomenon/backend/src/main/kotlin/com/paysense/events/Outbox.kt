package com.paysense.events

import com.fasterxml.jackson.databind.ObjectMapper
import com.paysense.common.CorrelationId
import com.paysense.common.PaySenseProperties
import com.paysense.common.resilience.RetryPolicy
import com.paysense.observability.OperationalLogService
import com.paysense.observability.PaySenseMetrics
import org.apache.kafka.clients.producer.ProducerRecord
import org.slf4j.LoggerFactory
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.kafka.core.KafkaTemplate
import org.springframework.stereotype.Component
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import java.nio.charset.StandardCharsets
import java.sql.Timestamp
import java.time.Clock
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Moves an envelope from the outbox to its consumers. Must throw if delivery could not be confirmed. */
interface EventTransport {
    fun send(event: EventEnvelope)
}

@Component
@ConditionalOnProperty("paysense.events.transport", havingValue = "in-process", matchIfMissing = true)
class InProcessEventTransport(
    private val dispatcher: EventDispatcher,
) : EventTransport {
    override fun send(event: EventEnvelope) = dispatcher.dispatch(event)
}

@Component
@ConditionalOnProperty("paysense.events.transport", havingValue = "kafka")
class KafkaEventTransport(
    private val kafka: KafkaTemplate<String, String>,
    private val mapper: ObjectMapper,
    private val props: PaySenseProperties,
) : EventTransport {
    override fun send(event: EventEnvelope) {
        val record = ProducerRecord(props.events.topic, null, event.aggregateId.toString(), mapper.writeValueAsString(event))
        record.headers().add("eventId", event.eventId.toString().toByteArray(StandardCharsets.UTF_8))
        record.headers().add("eventType", event.eventType.toByteArray(StandardCharsets.UTF_8))
        record.headers().add("schemaVersion", event.schemaVersion.toString().toByteArray(StandardCharsets.UTF_8))
        record.headers().add(CorrelationId.HEADER, event.correlationId.toByteArray(StandardCharsets.UTF_8))
        // wait for the broker acknowledgement: the outbox row is only marked published after this returns
        kafka.send(record).get(10, TimeUnit.SECONDS)
    }
}

/**
 * Polls the outbox and publishes pending events. Guarantee: at-least-once. An event is marked PUBLISHED only after
 * the transport confirmed it; if the process dies between confirming and marking, the event is sent again and
 * consumers deduplicate by event id. Multiple instances are safe (FOR UPDATE SKIP LOCKED).
 */
@Service
class OutboxPublisher(
    private val jdbc: JdbcClient,
    private val transport: EventTransport,
    private val mapper: ObjectMapper,
    private val props: PaySenseProperties,
    private val metrics: PaySenseMetrics,
    private val opLog: OperationalLogService,
    private val clock: Clock,
    txManager: PlatformTransactionManager,
) {
    private val log = LoggerFactory.getLogger(javaClass)
    private val tx = TransactionTemplate(txManager)
    private val cfg = props.events.outbox
    private val backoff = RetryPolicy(cfg.maxAttempts, cfg.initialBackoff, cfg.maxBackoff, 2.0, java.time.Duration.ofDays(1))

    private data class Row(
        val envelope: EventEnvelope,
        val attempts: Int,
    )

    /** Publishes one batch; returns the number of events successfully published. */
    fun publishBatch(): Int = tx.execute { publishLocked() } ?: 0

    private fun publishLocked(): Int {
        val now = clock.instant()
        val rows =
            jdbc
                .sql(
                    """
            SELECT o.id, o.aggregate_type, o.aggregate_id, o.event_type, o.schema_version, o.payload::text AS payload,
                   o.correlation_id, o.attempts, o.created_at
              FROM outbox_events o
             WHERE o.status = 'PENDING' AND o.next_attempt_at <= :now
               AND NOT EXISTS (SELECT 1 FROM outbox_events e2 WHERE e2.aggregate_id = o.aggregate_id AND e2.status = 'PENDING'
                                  AND e2.created_at < o.created_at AND e2.next_attempt_at > :now)
             ORDER BY o.created_at, o.id
             LIMIT :limit FOR UPDATE OF o SKIP LOCKED
            """,
                ).param("now", Timestamp.from(now))
                .param("limit", cfg.batchSize)
                .query { rs, _ ->
                    Row(
                        EventEnvelope(
                            rs.getObject("id", UUID::class.java),
                            rs.getString("event_type"),
                            rs.getInt("schema_version"),
                            rs.getString("aggregate_type"),
                            rs.getObject("aggregate_id", UUID::class.java),
                            rs.getTimestamp("created_at").toInstant(),
                            rs.getString("correlation_id"),
                            @Suppress("UNCHECKED_CAST") (mapper.readValue(rs.getString("payload"), Map::class.java) as Map<String, Any?>),
                        ),
                        rs.getInt("attempts"),
                    )
                }.list()

        var published = 0
        val blockedAggregates = mutableSetOf<UUID>() // keep per-aggregate order: after a failure, skip that aggregate's later events
        for (row in rows) {
            val e = row.envelope
            if (e.aggregateId in blockedAggregates) continue
            try {
                transport.send(e)
                jdbc
                    .sql("UPDATE outbox_events SET status = 'PUBLISHED', published_at = :now, last_error = NULL WHERE id = :id")
                    .param("now", Timestamp.from(clock.instant()))
                    .param("id", e.eventId)
                    .update()
                metrics.eventPublished("success")
                published++
            } catch (ex: Exception) {
                blockedAggregates += e.aggregateId
                recordFailure(row, ex)
            }
        }
        return published
    }

    private fun recordFailure(
        row: Row,
        ex: Exception,
    ) {
        val attempts = row.attempts + 1
        val exhausted = attempts >= cfg.maxAttempts
        val delay = backoff.delayFor(attempts)
        jdbc
            .sql(
                "UPDATE outbox_events SET attempts = :a, status = :st, next_attempt_at = :next, last_error = :err WHERE id = :id",
            ).param("a", attempts)
            .param("st", if (exhausted) "FAILED" else "PENDING")
            .param("next", Timestamp.from(clock.instant().plus(delay)))
            .param("err", "${ex.javaClass.simpleName}: ${ex.message}".take(500))
            .param("id", row.envelope.eventId)
            .update()
        metrics.eventPublished(if (exhausted) "failed" else "retry")
        log.warn("Outbox publish failed for {} (attempt {}): {}", row.envelope.eventId, attempts, ex.javaClass.simpleName)
        if (exhausted) {
            opLog.record(
                "ERROR",
                "outbox",
                "Outbox event ${row.envelope.eventType} gave up after $attempts attempts; manual requeue required",
                row.envelope.correlationId,
                row.envelope.aggregateId,
                mapOf("eventId" to row.envelope.eventId.toString()),
            )
        }
    }

    /** Admin action: gives FAILED events a fresh retry budget. */
    fun requeueFailed(): Int =
        tx.execute {
            jdbc
                .sql("UPDATE outbox_events SET status = 'PENDING', attempts = 0, next_attempt_at = :now WHERE status = 'FAILED'")
                .param("now", Timestamp.from(clock.instant()))
                .update()
        } ?: 0

    /** Retention: published rows are deleted after the configured period. */
    fun purgePublished(): Int =
        jdbc
            .sql("DELETE FROM outbox_events WHERE status = 'PUBLISHED' AND published_at < :cutoff")
            .param("cutoff", Timestamp.from(clock.instant().minus(cfg.retention)))
            .update()
}
