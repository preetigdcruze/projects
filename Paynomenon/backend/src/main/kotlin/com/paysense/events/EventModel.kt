package com.paysense.events

import com.fasterxml.jackson.databind.ObjectMapper
import com.paysense.common.PaySenseProperties
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import java.time.Clock
import java.time.Instant
import java.util.UUID

/** Versioned event contracts. Changing the payload of a type means bumping its schema version. */
enum class DomainEventType(
    val schemaVersion: Int = 1,
) {
    PaymentCreated,
    PaymentAuthorized,
    PaymentCaptured,
    PaymentFailed,
    PaymentRefunded,
    ProcessorTimeout,
    ReconciliationDiscrepancyDetected,
}

/** Wire format published to Kafka (as JSON) and handed to consumers. */
data class EventEnvelope(
    val eventId: UUID,
    val eventType: String,
    val schemaVersion: Int,
    val aggregateType: String,
    val aggregateId: UUID,
    val occurredAt: Instant,
    val correlationId: String,
    val payload: Map<String, Any?>,
)

/**
 * Writes domain events to the transactional outbox. It must be called inside the same database transaction as the
 * business change, so either both are committed or neither is.
 */
@Repository
class OutboxWriter(
    private val jdbc: JdbcClient,
    private val mapper: ObjectMapper,
    private val clock: Clock,
) {
    fun append(
        type: DomainEventType,
        aggregateType: String,
        aggregateId: UUID,
        payload: Map<String, Any?>,
        correlationId: String,
    ): UUID {
        val id = UUID.randomUUID()
        val now = java.sql.Timestamp.from(clock.instant())
        jdbc
            .sql(
                """
            INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, schema_version, payload, correlation_id, status, attempts, next_attempt_at, created_at)
            VALUES (:id, :at, :aid, :type, :ver, CAST(:payload AS jsonb), :corr, 'PENDING', 0, :now, :now)
            """,
            ).param("id", id)
            .param("at", aggregateType)
            .param("aid", aggregateId)
            .param("type", type.name)
            .param("ver", type.schemaVersion)
            .param("payload", mapper.writeValueAsString(payload))
            .param("corr", correlationId)
            .param("now", now)
            .update()
        return id
    }
}

data class OutboxStats(
    val pending: Long,
    val failed: Long,
    val published: Long,
    val oldestPendingAgeSeconds: Long?,
)

data class DeadLetterStats(
    val dead: Long,
    val replayed: Long,
)

@Repository
class EventStatsRepository(
    private val jdbc: JdbcClient,
    private val clock: Clock,
) {
    fun outbox(): OutboxStats {
        val row =
            jdbc
                .sql(
                    """
            SELECT COUNT(*) FILTER (WHERE status = 'PENDING') AS pending,
                   COUNT(*) FILTER (WHERE status = 'FAILED') AS failed,
                   COUNT(*) FILTER (WHERE status = 'PUBLISHED') AS published,
                   MIN(created_at) FILTER (WHERE status = 'PENDING') AS oldest
              FROM outbox_events
            """,
                ).query { rs, _ ->
                    val oldest = rs.getTimestamp("oldest")?.toInstant()
                    OutboxStats(
                        rs.getLong("pending"),
                        rs.getLong("failed"),
                        rs.getLong("published"),
                        oldest?.let { clock.instant().epochSecond - it.epochSecond },
                    )
                }.single()
        return row
    }

    fun deadLetters(): DeadLetterStats =
        jdbc
            .sql(
                "SELECT COUNT(*) FILTER (WHERE status = 'DEAD') AS dead, COUNT(*) FILTER (WHERE status = 'REPLAYED') AS replayed FROM dead_letter_events",
            ).query { rs, _ -> DeadLetterStats(rs.getLong("dead"), rs.getLong("replayed")) }
            .single()
}

/** Marker so wiring code can reference the configured transport without string comparisons. */
class EventTransportSettings(
    props: PaySenseProperties,
) {
    val kafka: Boolean = props.events.transport.equals("kafka", ignoreCase = true)
}
