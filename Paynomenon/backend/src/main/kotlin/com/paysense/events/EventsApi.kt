package com.paysense.events

import com.fasterxml.jackson.databind.ObjectMapper
import com.paysense.common.ConflictException
import com.paysense.common.NotFoundException
import com.paysense.common.PageResponse
import com.paysense.common.Paging
import com.paysense.common.UnprocessableException
import com.paysense.common.ValidationException
import com.paysense.observability.OperationalLogService
import com.paysense.security.CurrentUser
import io.swagger.v3.oas.annotations.tags.Tag
import jakarta.validation.Valid
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import java.sql.Timestamp
import java.time.Clock
import java.time.Instant
import java.util.UUID

data class DeadLetterView(
    val id: UUID,
    val consumer: String,
    val eventId: UUID?,
    val eventType: String?,
    val errorClass: String,
    val errorMessage: String?,
    val attempts: Int,
    val status: String,
    val replayCount: Int,
    val replayedBy: String?,
    val replayReason: String?,
    val replayedAt: Instant?,
    val failedAt: Instant,
    val payload: String,
)

data class ReplayRequest(
    @field:NotBlank @field:Size(min = 10, max = 500) val reason: String?,
)

data class ReplayResult(
    val id: UUID,
    val status: String,
    val outcome: String,
)

@Service
class DeadLetterService(
    private val jdbc: JdbcClient,
    private val dispatcher: EventDispatcher,
    private val mapper: ObjectMapper,
    private val opLog: OperationalLogService,
    private val clock: Clock,
) {
    fun list(
        status: String?,
        page: Int,
        size: Int,
    ): PageResponse<DeadLetterView> {
        Paging.validate(page, size)
        if (status != null && status !in setOf("DEAD", "REPLAYED")) throw ValidationException("status must be DEAD or REPLAYED")
        val total =
            jdbc
                .sql(
                    "SELECT COUNT(*) FROM dead_letter_events WHERE (CAST(:s AS text) IS NULL OR status = :s)",
                ).param("s", status)
                .query(Long::class.java)
                .single()
        val items =
            jdbc
                .sql(
                    "SELECT * FROM dead_letter_events WHERE (CAST(:s AS text) IS NULL OR status = :s) ORDER BY failed_at DESC, id LIMIT :l OFFSET :o",
                ).param("s", status)
                .param("l", size)
                .param("o", page * size)
                .query { rs, _ ->
                    DeadLetterView(
                        rs.getObject("id", UUID::class.java),
                        rs.getString("consumer"),
                        rs.getObject("event_id", UUID::class.java),
                        rs.getString("event_type"),
                        rs.getString("error_class"),
                        rs.getString("error_message"),
                        rs.getInt("attempts"),
                        rs.getString("status"),
                        rs.getInt("replay_count"),
                        rs.getString("replayed_by"),
                        rs.getString("replay_reason"),
                        rs.getTimestamp("replayed_at")?.toInstant(),
                        rs.getTimestamp("failed_at").toInstant(),
                        rs.getString("payload").take(4000),
                    )
                }.list()
        return PageResponse.of(items, page, size, total)
    }

    /**
     * Replays one dead-lettered event through the same handler that failed, exactly once per call. Safeguards:
     * ADMIN only, a written reason is mandatory, at most [MAX_REPLAYS] replays per event, and the replay goes through
     * durable deduplication, so an event that was in fact processed cannot take effect twice.
     */
    @Transactional(noRollbackFor = [Exception::class])
    fun replay(
        id: UUID,
        reason: String,
        actor: String,
    ): ReplayResult {
        val row =
            jdbc
                .sql(
                    "SELECT consumer, payload, status, replay_count FROM dead_letter_events WHERE id = :id FOR UPDATE",
                ).param("id", id)
                .query {
                        rs,
                        _,
                    ->
                    arrayOf(rs.getString("consumer"), rs.getString("payload"), rs.getString("status"), rs.getInt("replay_count"))
                }.optional()
                .orElseThrow { NotFoundException("Dead-letter event", id) }
        val (consumer, payload, status, count) = row.let { listOf(it[0] as String, it[1] as String, it[2] as String, it[3] as Int) }
        if (status != "DEAD") throw ConflictException("ALREADY_REPLAYED", "This dead-letter event was already replayed successfully")
        if ((count as Int) >=
            MAX_REPLAYS
        ) {
            throw ConflictException(
                "REPLAY_LIMIT_REACHED",
                "This event was replayed $count times without success; investigate before trying again",
            )
        }
        val handler =
            dispatcher.handlerNamed(consumer as String)
                ?: throw UnprocessableException(
                    "NO_SUCH_HANDLER",
                    "No handler named '$consumer' is registered, so this event cannot be replayed",
                )
        val envelope =
            try {
                mapper.readValue(payload as String, EventEnvelope::class.java)
            } catch (e: Exception) {
                throw UnprocessableException("UNREPLAYABLE_PAYLOAD", "The stored payload is not a valid event envelope")
            }
        val now = Timestamp.from(clock.instant())
        return try {
            val result = dispatcher.handleOnce(handler, envelope)
            jdbc
                .sql(
                    "UPDATE dead_letter_events SET status = 'REPLAYED', replay_count = replay_count + 1, replayed_by = :by, replay_reason = :why, replayed_at = :at WHERE id = :id",
                ).param("by", actor)
                .param("why", reason)
                .param("at", now)
                .param("id", id)
                .update()
            opLog.record(
                "INFO",
                "dead-letter",
                "Dead-letter event $id replayed by $actor: ${result.name}",
                envelope.correlationId,
                envelope.aggregateId,
            )
            ReplayResult(id, "REPLAYED", result.name)
        } catch (e: Exception) {
            jdbc
                .sql(
                    "UPDATE dead_letter_events SET replay_count = replay_count + 1, replayed_by = :by, replay_reason = :why, replayed_at = :at, error_message = :err WHERE id = :id",
                ).param(
                    "by",
                    actor,
                ).param(
                    "why",
                    reason,
                ).param(
                    "at",
                    now,
                ).param("err", "replay failed: ${e.javaClass.simpleName}: ${e.message}".take(1000))
                .param("id", id)
                .update()
            ReplayResult(id, "DEAD", "FAILED: ${e.javaClass.simpleName}")
        }
    }

    companion object {
        const val MAX_REPLAYS = 3
    }
}

@RestController
@RequestMapping("/api/v1")
@Tag(name = "Events")
class EventsController(
    private val deadLetters: DeadLetterService,
    private val publisher: OutboxPublisher,
    private val stats: EventStatsRepository,
) {
    @GetMapping("/events/dead-letters")
    fun list(
        @RequestParam(required = false) status: String?,
        @RequestParam(defaultValue = "0") page: Int,
        @RequestParam(defaultValue = "20") size: Int,
    ) = deadLetters.list(status, page, size)

    @GetMapping("/events/outbox/stats")
    fun outbox() = stats.outbox()

    @PostMapping("/admin/events/dead-letters/{id}/replay")
    fun replay(
        @PathVariable id: UUID,
        @Valid @RequestBody req: ReplayRequest,
    ) = deadLetters.replay(id, req.reason!!.trim(), CurrentUser.name())

    @PostMapping("/admin/events/outbox/requeue-failed")
    fun requeue() = mapOf("requeued" to publisher.requeueFailed())
}
