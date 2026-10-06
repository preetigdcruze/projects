package com.paysense.events

import com.fasterxml.jackson.databind.ObjectMapper
import com.paysense.common.CorrelationId
import com.paysense.common.PaySenseProperties
import com.paysense.common.resilience.ErrorClassifier
import com.paysense.common.resilience.RetryExecutor
import com.paysense.common.resilience.RetryExhaustedException
import com.paysense.common.resilience.RetryListener
import com.paysense.common.resilience.RetryPolicy
import com.paysense.common.resilience.Retryability
import com.paysense.observability.OperationalLogService
import com.paysense.observability.PaySenseMetrics
import org.slf4j.LoggerFactory
import org.slf4j.MDC
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import java.sql.Timestamp
import java.time.Clock
import java.util.UUID

/** A handler for one kind of event. Delivery is at-least-once, so handlers must tolerate seeing an event twice. */
interface EventHandler {
    /** Stable identifier; also the deduplication scope in processed_events and the dead-letter owner. */
    val name: String

    /**
     * true: the dedupe marker and the handler's database effects commit in one transaction (exactly-once *effect*
     * for database-only handlers). false: the handler is itself idempotent and may call external systems; the
     * marker is written after it succeeds.
     */
    val atomicWithDedupe: Boolean get() = true

    fun supports(eventType: String): Boolean

    fun handle(event: EventEnvelope)
}

/** Failures that can never succeed on retry (bad data); they go straight to the dead-letter table. */
class NonRetryableEventException(
    message: String,
    cause: Throwable? = null,
) : RuntimeException(message, cause)

object HandlerErrorClassifier : ErrorClassifier {
    override fun classify(error: Throwable) =
        when (error) {
            is NonRetryableEventException, is IllegalArgumentException -> Retryability.NON_RETRYABLE
            else -> Retryability.RETRYABLE
        }
}

enum class HandleResult { PROCESSED, DUPLICATE }

/**
 * Runs every interested handler for an event with durable deduplication, bounded retries with jittered exponential
 * backoff and a dead-letter table for what still fails. Shared by the Kafka listener and the in-process transport,
 * so both modes behave identically.
 */
@Service
class EventDispatcher(
    handlers: List<EventHandler>,
    private val jdbc: JdbcClient,
    private val mapper: ObjectMapper,
    private val props: PaySenseProperties,
    private val metrics: PaySenseMetrics,
    private val opLog: OperationalLogService,
    private val clock: Clock,
    txManager: PlatformTransactionManager,
    private val retryExecutor: RetryExecutor = RetryExecutor(),
) {
    private val log = LoggerFactory.getLogger(javaClass)

    // Handlers always run in their own transaction, even when the in-process transport calls us from inside the
    // outbox publisher's transaction: a failing handler must never poison the publisher's transaction.
    private val tx =
        TransactionTemplate(txManager).apply {
            propagationBehavior =
                org.springframework.transaction.TransactionDefinition.PROPAGATION_REQUIRES_NEW
        }
    private val handlerList = handlers
    private val c = props.events.consumer
    private val policy = RetryPolicy(c.maxAttempts, c.initialBackoff, c.maxBackoff, c.multiplier, c.maxElapsed)

    fun handlerNamed(name: String): EventHandler? = handlerList.firstOrNull { it.name == name }

    /**
     * Returns normally once every handler either processed the event, saw it as a duplicate, or the failure was
     * safely recorded in the dead-letter table. Throws only when even that bookkeeping failed (e.g. database down),
     * in which case the caller must NOT acknowledge the message so it is delivered again.
     */
    fun dispatch(
        event: EventEnvelope,
        rawPayload: String? = null,
        partition: Int? = null,
        offset: Long? = null,
    ) {
        val interested = handlerList.filter { it.supports(event.eventType) }
        MDC.put("eventId", event.eventId.toString())
        try {
            CorrelationId.with(event.correlationId) {
                for (handler in interested) {
                    try {
                        val result =
                            retryExecutor.execute(
                                policy,
                                HandlerErrorClassifier,
                                retryLogger(handler, event),
                            ) { handleOnce(handler, event) }
                        metrics.eventHandled(handler.name, result.name.lowercase())
                    } catch (e: Throwable) {
                        val attempts = (e as? RetryExhaustedException)?.attempts ?: 1
                        val cause = (e as? RetryExhaustedException)?.cause ?: e
                        deadLetter(handler.name, event, rawPayload ?: mapper.writeValueAsString(event), cause, attempts, partition, offset)
                    }
                }
            }
        } finally {
            MDC.remove("eventId")
        }
    }

    /** One delivery attempt of one handler. Public so replay can reuse the exact same semantics. */
    fun handleOnce(
        handler: EventHandler,
        event: EventEnvelope,
    ): HandleResult {
        if (handler.atomicWithDedupe) {
            return tx.execute {
                if (!markProcessed(handler.name, event.eventId)) return@execute HandleResult.DUPLICATE
                handler.handle(event)
                HandleResult.PROCESSED
            }!!
        }
        val seen =
            jdbc
                .sql(
                    "SELECT 1 FROM processed_events WHERE consumer = :c AND event_id = :e",
                ).param("c", handler.name)
                .param("e", event.eventId)
                .query(Int::class.java)
                .optional()
                .isPresent
        if (seen) return HandleResult.DUPLICATE
        handler.handle(event)
        tx.execute { markProcessed(handler.name, event.eventId) }
        return HandleResult.PROCESSED
    }

    private fun markProcessed(
        consumer: String,
        eventId: UUID,
    ): Boolean =
        jdbc
            .sql("INSERT INTO processed_events (consumer, event_id, processed_at) VALUES (:c, :e, :at) ON CONFLICT DO NOTHING")
            .param("c", consumer)
            .param("e", eventId)
            .param("at", Timestamp.from(clock.instant()))
            .update() == 1

    private fun retryLogger(
        handler: EventHandler,
        event: EventEnvelope,
    ) = RetryListener { attempt, error, delay ->
        log.warn(
            "Handler {} failed on event {} (attempt {}), retrying in {}ms: {}",
            handler.name,
            event.eventId,
            attempt,
            delay.toMillis(),
            error.javaClass.simpleName,
        )
    }

    fun deadLetter(
        consumer: String,
        event: EventEnvelope?,
        raw: String,
        error: Throwable,
        attempts: Int,
        partition: Int?,
        offset: Long?,
    ) {
        val inserted = tx.execute { insertDeadLetter(consumer, event, raw, error, attempts, partition, offset) } ?: 0
        metrics.deadLettered(consumer)
        if (inserted == 1) {
            opLog.record(
                "ERROR",
                "event-consumer",
                "Event ${event?.eventType ?: "<unparseable>"} dead-lettered for consumer $consumer after $attempts attempt(s): ${error.javaClass.simpleName}",
                event?.correlationId,
                event?.aggregateId,
                mapOf("consumer" to consumer, "eventId" to event?.eventId?.toString()),
            )
        }
    }

    private fun insertDeadLetter(
        consumer: String,
        event: EventEnvelope?,
        raw: String,
        error: Throwable,
        attempts: Int,
        partition: Int?,
        offset: Long?,
    ): Int =
        jdbc
            .sql(
                """
            INSERT INTO dead_letter_events (id, consumer, event_id, event_type, topic, kafka_partition, kafka_offset, payload, error_class, error_message, attempts, status, failed_at)
            VALUES (:id, :consumer, :eid, :type, :topic, :part, :off, :payload, :ec, :em, :attempts, 'DEAD', :at)
            ON CONFLICT (consumer, event_id) WHERE event_id IS NOT NULL DO NOTHING
            """,
            ).param("id", UUID.randomUUID())
            .param("consumer", consumer)
            .param("eid", event?.eventId)
            .param("type", event?.eventType)
            .param("topic", props.events.topic)
            .param("part", partition)
            .param("off", offset)
            .param("payload", raw)
            .param("ec", error.javaClass.name.take(200))
            .param("em", error.message?.take(1000))
            .param("attempts", attempts)
            .param("at", Timestamp.from(clock.instant()))
            .update()
}
