package com.paysense.idempotency

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.paysense.common.ConflictException
import com.paysense.common.PaySenseProperties
import com.paysense.common.UnprocessableException
import com.paysense.common.ValidationException
import org.slf4j.LoggerFactory
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.TransactionDefinition
import org.springframework.transaction.support.TransactionTemplate
import java.security.MessageDigest
import java.sql.Timestamp
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.UUID

sealed interface Claim {
    /** This caller owns the key and must execute the operation, then complete() or release(). */
    data class Fresh(
        val recordId: UUID,
    ) : Claim

    /** The operation already completed; return the stored response. */
    data class Replay(
        val status: Int,
        val body: JsonNode?,
        val resourceId: UUID?,
    ) : Claim
}

object IdempotencyKeys {
    private val VALID = Regex("^[\\x21-\\x7E]{1,255}$")

    fun validate(key: String?): String? {
        if (key == null) return null
        if (!VALID.matches(key)) throw ValidationException("Idempotency-Key must be 1-255 printable ASCII characters without spaces")
        return key
    }

    fun fingerprint(
        operation: String,
        vararg parts: Any?,
    ): String {
        val canonical = operation + "\u0000" + parts.joinToString("\u0000") { it?.toString() ?: "" }
        return MessageDigest.getInstance("SHA-256").digest(canonical.toByteArray()).joinToString("") { "%02x".format(it) }
    }
}

/**
 * Durable API-level idempotency. The unique constraint on (principal, idempotency_key) is the source of truth;
 * Redis is never consulted. Rules:
 *  - same key + same fingerprint + COMPLETED   -> replay the stored response, no new side effects
 *  - same key + different fingerprint/operation -> 422 IDEMPOTENCY_KEY_REUSED
 *  - same key while the first request is IN_PROGRESS -> 409 IDEMPOTENCY_REQUEST_IN_PROGRESS (Retry-After: 1)
 *  - an IN_PROGRESS record older than the configured timeout is considered abandoned and may be taken over
 */
@Service
class IdempotencyService(
    private val jdbc: JdbcClient,
    private val mapper: ObjectMapper,
    private val props: PaySenseProperties,
    private val clock: Clock,
    txManager: PlatformTransactionManager,
) {
    private val log = LoggerFactory.getLogger(javaClass)
    private val newTx = TransactionTemplate(txManager).apply { propagationBehavior = TransactionDefinition.PROPAGATION_REQUIRES_NEW }

    /** Joins the caller's transaction when there is one (atomic creation); see [claimInNewTransaction]. */
    fun claim(
        principal: String,
        key: String,
        operation: String,
        fingerprint: String,
    ): Claim {
        val now = clock.instant()
        val id = UUID.randomUUID()
        val inserted =
            jdbc
                .sql(
                    """
            INSERT INTO idempotency_records (id, principal, idempotency_key, operation, request_fingerprint, status, created_at, updated_at, expires_at)
            VALUES (:id, :principal, :key, :op, :fp, 'IN_PROGRESS', :now, :now, :exp)
            ON CONFLICT (principal, idempotency_key) DO NOTHING
            """,
                ).param("id", id)
                .param("principal", principal)
                .param("key", key)
                .param("op", operation)
                .param("fp", fingerprint)
                .param("now", Timestamp.from(now))
                .param("exp", Timestamp.from(now.plus(props.payments.idempotencyTtl)))
                .update()
        if (inserted == 1) return Claim.Fresh(id)

        val existing =
            jdbc
                .sql(
                    "SELECT id, operation, request_fingerprint, status, response_status, response_body, resource_id, updated_at FROM idempotency_records WHERE principal = :p AND idempotency_key = :k",
                ).param("p", principal)
                .param("k", key)
                .query { rs, _ ->
                    Existing(
                        rs.getObject("id", UUID::class.java),
                        rs.getString("operation"),
                        rs.getString("request_fingerprint").trim(),
                        rs.getString("status"),
                        rs.getInt("response_status").takeUnless { rs.wasNull() },
                        rs.getString("response_body"),
                        rs.getObject("resource_id", UUID::class.java),
                        rs.getTimestamp("updated_at").toInstant(),
                    )
                }.optional()
                .orElse(null) ?: return claim(principal, key, operation, fingerprint) // record expired/removed between statements

        if (existing.operation != operation || existing.fingerprint != fingerprint) {
            throw UnprocessableException(
                "IDEMPOTENCY_KEY_REUSED",
                "This Idempotency-Key was already used with a different request. Use a new key for a different payload.",
            )
        }
        if (existing.status == "COMPLETED") {
            return Claim.Replay(existing.responseStatus ?: 200, existing.body?.let { mapper.readTree(it) }, existing.resourceId)
        }
        // IN_PROGRESS: abandoned (crash) or genuinely running?
        val stale = Duration.between(existing.updatedAt, now) > props.payments.idempotencyInProgressTimeout
        if (stale) {
            val taken =
                jdbc
                    .sql("UPDATE idempotency_records SET updated_at = :now WHERE id = :id AND status = 'IN_PROGRESS' AND updated_at = :old")
                    .param("now", Timestamp.from(now))
                    .param("id", existing.id)
                    .param("old", Timestamp.from(existing.updatedAt))
                    .update()
            if (taken == 1) {
                log.warn("Taking over abandoned idempotency record {}", existing.id)
                return Claim.Fresh(existing.id)
            }
        }
        throw ConflictException(
            "IDEMPOTENCY_REQUEST_IN_PROGRESS",
            "A request with this Idempotency-Key is still being processed. Retry shortly.",
            mapOf("Retry-After" to "1"),
        )
    }

    fun claimInNewTransaction(
        principal: String,
        key: String,
        operation: String,
        fingerprint: String,
    ): Claim = newTx.execute { claim(principal, key, operation, fingerprint) }!!

    fun complete(
        recordId: UUID,
        status: Int,
        body: Any?,
        resourceId: UUID?,
        newTransaction: Boolean,
    ) {
        val block = {
            jdbc
                .sql(
                    """
                UPDATE idempotency_records SET status = 'COMPLETED', response_status = :st, response_body = CAST(:body AS jsonb),
                       resource_type = 'payment', resource_id = :rid, updated_at = :now WHERE id = :id
                """,
                ).param("st", status)
                .param("body", body?.let { mapper.writeValueAsString(it) })
                .param("rid", resourceId)
                .param("now", Timestamp.from(clock.instant()))
                .param("id", recordId)
                .update()
        }
        if (newTransaction) newTx.executeWithoutResult { block() } else block()
    }

    /** Frees the key so the client can retry. Used when the request failed without a deterministic outcome. */
    fun release(recordId: UUID) {
        newTx.executeWithoutResult {
            jdbc.sql("DELETE FROM idempotency_records WHERE id = :id AND status = 'IN_PROGRESS'").param("id", recordId).update()
        }
    }

    /** Retention: completed records are kept for the configured TTL, then removed. */
    fun purgeExpired(now: Instant): Int =
        jdbc.sql("DELETE FROM idempotency_records WHERE expires_at < :now").param("now", Timestamp.from(now)).update()

    private data class Existing(
        val id: UUID,
        val operation: String,
        val fingerprint: String,
        val status: String,
        val responseStatus: Int?,
        val body: String?,
        val resourceId: UUID?,
        val updatedAt: Instant,
    )
}

/** The outcome of the guarded operation, as it should be returned (and, if [store], replayed). */
data class IdempotentResult(
    val status: Int,
    val body: Any,
    val resourceId: UUID? = null,
    /** false for transient outcomes (e.g. processor unavailable): the key is released so the client may retry. */
    val store: Boolean = true,
)

@Service
class IdempotentExecutor(
    private val idempotency: IdempotencyService,
    private val txManager: PlatformTransactionManager,
) {
    private val tx = TransactionTemplate(txManager)

    /**
     * Single-transaction mode (payment creation): the key record and the business change commit atomically, so there is
     * no window in which one exists without the other. A concurrent request with the same key blocks on the unique
     * index until this transaction ends, then replays or proceeds.
     */
    fun atomic(
        principal: String,
        key: String?,
        operation: String,
        fingerprint: String,
        block: () -> IdempotentResult,
    ): ResponseEntity<Any> {
        if (key == null) return respond(block(), replayed = false)
        return tx.execute {
            when (val claim = idempotency.claim(principal, key, operation, fingerprint)) {
                is Claim.Replay -> replay(claim)
                is Claim.Fresh -> {
                    val result = block()
                    idempotency.complete(claim.recordId, result.status, result.body, result.resourceId, newTransaction = false)
                    respond(result, replayed = false)
                }
            }
        }!!
    }

    /**
     * Two-phase mode for operations that call an external system between transactions (authorize/capture/refund):
     * IN_PROGRESS is committed first so concurrent duplicates are rejected immediately.
     */
    fun twoPhase(
        principal: String,
        key: String?,
        operation: String,
        fingerprint: String,
        block: () -> IdempotentResult,
    ): ResponseEntity<Any> {
        if (key == null) return respond(block(), replayed = false)
        val claim = idempotency.claimInNewTransaction(principal, key, operation, fingerprint)
        if (claim is Claim.Replay) return replay(claim)
        val recordId = (claim as Claim.Fresh).recordId
        val result =
            try {
                block()
            } catch (e: Throwable) {
                // Validation/conflict/internal failures produce no durable outcome: release the key so the client can retry.
                runCatching { idempotency.release(recordId) }
                throw e
            }
        if (!result.store) {
            idempotency.release(recordId)
        } else {
            idempotency.complete(recordId, result.status, result.body, result.resourceId, newTransaction = true)
        }
        return respond(result, replayed = false)
    }

    private fun replay(claim: Claim.Replay): ResponseEntity<Any> =
        ResponseEntity.status(claim.status).header("Idempotent-Replayed", "true").body(claim.body ?: "")

    private fun respond(
        result: IdempotentResult,
        replayed: Boolean,
    ): ResponseEntity<Any> {
        val b = ResponseEntity.status(HttpStatus.valueOf(result.status))
        if (replayed) b.header("Idempotent-Replayed", "true")
        return b.body(result.body)
    }
}
