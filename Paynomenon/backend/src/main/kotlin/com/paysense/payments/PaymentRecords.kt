package com.paysense.payments

import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import java.sql.ResultSet
import java.time.Instant
import java.util.UUID

enum class PaymentEventType {
    PAYMENT_CREATED,
    OPERATION_STARTED,
    OPERATION_SUCCEEDED,
    OPERATION_DECLINED,
    OPERATION_NOT_EXECUTED,
    OUTCOME_UNCERTAIN,
    OUTCOME_RESOLVED,
    CALLBACK_RECEIVED,
    CANCELLED,
    RECOVERY_SWEEP,
}

object EventSource {
    const val API = "API"
    const val PROCESSOR_CALLBACK = "PROCESSOR_CALLBACK"
    const val RECOVERY = "RECOVERY"
    const val CONSUMER = "CONSUMER"
    const val SEED = "SEED"
}

data class PaymentEventRecord(
    val id: UUID,
    val paymentId: UUID,
    val sequence: Int,
    val eventType: String,
    val fromStatus: String?,
    val toStatus: String?,
    val source: String,
    val actor: String,
    val correlationId: String,
    val metadata: Map<String, Any?>,
    val occurredAt: Instant,
)

@Repository
class PaymentEventRepository(
    private val jdbc: JdbcClient,
    private val mapper: ObjectMapper,
) {
    /** Appends to the payment's audit trail. Must run inside the transaction that holds the payment row lock. */
    fun append(
        paymentId: UUID,
        type: PaymentEventType,
        from: PaymentStatus?,
        to: PaymentStatus?,
        source: String,
        actor: String,
        correlationId: String,
        metadata: Map<String, Any?>,
        at: Instant,
    ): UUID {
        val id = UUID.randomUUID()
        jdbc
            .sql(
                """
            INSERT INTO payment_events (id, payment_id, sequence, event_type, from_status, to_status, source, actor, correlation_id, metadata, occurred_at)
            VALUES (:id, :pid, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM payment_events WHERE payment_id = :pid),
                    :type, :from, :to, :source, :actor, :corr, CAST(:meta AS jsonb), :at)
            """,
            ).param("id", id)
            .param("pid", paymentId)
            .param("type", type.name)
            .param("from", from?.name)
            .param("to", to?.name)
            .param("source", source)
            .param("actor", actor)
            .param("corr", correlationId)
            .param("meta", mapper.writeValueAsString(metadata))
            .param("at", java.sql.Timestamp.from(at))
            .update()
        return id
    }

    fun page(
        paymentId: UUID,
        offset: Int,
        limit: Int,
    ): List<PaymentEventRecord> =
        jdbc
            .sql("SELECT * FROM payment_events WHERE payment_id = :pid ORDER BY sequence LIMIT :limit OFFSET :offset")
            .param("pid", paymentId)
            .param("limit", limit)
            .param("offset", offset)
            .query { rs, _ -> map(rs) }
            .list()

    fun count(paymentId: UUID): Long =
        jdbc
            .sql("SELECT COUNT(*) FROM payment_events WHERE payment_id = :pid")
            .param("pid", paymentId)
            .query(Long::class.java)
            .single()

    private fun map(rs: ResultSet) =
        PaymentEventRecord(
            rs.getObject("id", UUID::class.java),
            rs.getObject("payment_id", UUID::class.java),
            rs.getInt("sequence"),
            rs.getString("event_type"),
            rs.getString("from_status"),
            rs.getString("to_status"),
            rs.getString("source"),
            rs.getString("actor"),
            rs.getString("correlation_id"),
            mapper.readValue(rs.getString("metadata"), Map::class.java).mapKeys { it.key.toString() },
            rs.getTimestamp("occurred_at").toInstant(),
        )
}

enum class AttemptStatus { STARTED, APPROVED, DECLINED, INVALID, UNAVAILABLE, TIMEOUT, ERROR }

data class PaymentAttemptRecord(
    val id: UUID,
    val paymentId: UUID,
    val operation: String,
    val attemptNumber: Int,
    val processor: String,
    val processorRequestId: String,
    val status: String,
    val responseCode: String?,
    val failureCategory: String?,
    val responseTimeMs: Int?,
    val sanitizedResponse: Map<String, Any?>?,
    val correlationId: String,
    val startedAt: Instant,
    val completedAt: Instant?,
)

@Repository
class PaymentAttemptRepository(
    private val jdbc: JdbcClient,
    private val mapper: ObjectMapper,
) {
    fun start(
        payment: Payment,
        operation: PaymentOperation,
        correlationId: String,
        at: Instant,
    ): PaymentAttemptRecord {
        val number =
            jdbc
                .sql("SELECT COALESCE(MAX(attempt_number), 0) + 1 FROM payment_attempts WHERE payment_id = :pid AND operation = :op")
                .param("pid", payment.id)
                .param("op", operation.name)
                .query(Int::class.java)
                .single()
        val id = UUID.randomUUID()
        // the processor-level idempotency key: stable per (payment, operation, attempt)
        val requestId = "${payment.id}:${operation.name}:$number"
        jdbc
            .sql(
                """
            INSERT INTO payment_attempts (id, payment_id, operation, attempt_number, processor, processor_request_id, status, correlation_id, started_at)
            VALUES (:id, :pid, :op, :n, :processor, :req, 'STARTED', :corr, :at)
            """,
            ).param("id", id)
            .param("pid", payment.id)
            .param("op", operation.name)
            .param("n", number)
            .param("processor", payment.processor)
            .param("req", requestId)
            .param("corr", correlationId)
            .param("at", java.sql.Timestamp.from(at))
            .update()
        return PaymentAttemptRecord(
            id,
            payment.id,
            operation.name,
            number,
            payment.processor,
            requestId,
            "STARTED",
            null,
            null,
            null,
            null,
            correlationId,
            at,
            null,
        )
    }

    fun complete(
        id: UUID,
        status: AttemptStatus,
        responseCode: String?,
        failureCategory: String?,
        responseTimeMs: Int?,
        sanitized: Map<String, Any?>,
        at: Instant,
    ) {
        jdbc
            .sql(
                """
            UPDATE payment_attempts SET status = :status, response_code = :code, failure_category = :cat,
                   response_time_ms = :ms, sanitized_response = CAST(:resp AS jsonb), completed_at = :at
             WHERE id = :id
            """,
            ).param("status", status.name)
            .param("code", responseCode)
            .param("cat", failureCategory)
            .param("ms", responseTimeMs)
            .param("resp", mapper.writeValueAsString(sanitized))
            .param("at", java.sql.Timestamp.from(at))
            .param("id", id)
            .update()
    }

    fun forPayment(
        paymentId: UUID,
        limit: Int = 50,
    ): List<PaymentAttemptRecord> =
        jdbc
            .sql("SELECT * FROM payment_attempts WHERE payment_id = :pid ORDER BY started_at, attempt_number LIMIT :limit")
            .param("pid", paymentId)
            .param("limit", limit)
            .query { rs, _ -> map(rs) }
            .list()

    fun findById(id: UUID): PaymentAttemptRecord? =
        jdbc
            .sql("SELECT * FROM payment_attempts WHERE id = :id")
            .param("id", id)
            .query { rs, _ -> map(rs) }
            .optional()
            .orElse(null)

    private fun map(rs: ResultSet) =
        PaymentAttemptRecord(
            rs.getObject("id", UUID::class.java),
            rs.getObject("payment_id", UUID::class.java),
            rs.getString("operation"),
            rs.getInt("attempt_number"),
            rs.getString("processor"),
            rs.getString("processor_request_id"),
            rs.getString("status"),
            rs.getString("response_code"),
            rs.getString("failure_category"),
            rs.getInt("response_time_ms").takeUnless { rs.wasNull() },
            rs.getString("sanitized_response")?.let { json -> mapper.readValue(json, Map::class.java).mapKeys { it.key.toString() } },
            rs.getString("correlation_id"),
            rs.getTimestamp("started_at").toInstant(),
            rs.getTimestamp("completed_at")?.toInstant(),
        )
}
