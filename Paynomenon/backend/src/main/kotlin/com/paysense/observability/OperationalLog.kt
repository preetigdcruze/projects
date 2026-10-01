package com.paysense.observability

import com.fasterxml.jackson.databind.ObjectMapper
import org.slf4j.LoggerFactory
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.TransactionDefinition
import org.springframework.transaction.support.TransactionTemplate
import java.time.Clock
import java.util.UUID

/**
 * Persists curated operational log lines (processor errors, retries, breaker transitions, consumer failures) so that
 * investigations can cite them by id. Written in its own short transaction so a rolled-back business transaction
 * does not erase the evidence of why it failed. A failure to write a log line never fails the business operation.
 */
@Service
class OperationalLogService(
    private val jdbc: JdbcClient,
    private val mapper: ObjectMapper,
    private val clock: Clock,
    txManager: PlatformTransactionManager,
) {
    private val log = LoggerFactory.getLogger(javaClass)
    private val tx = TransactionTemplate(txManager).apply { propagationBehavior = TransactionDefinition.PROPAGATION_REQUIRES_NEW }

    fun record(
        level: String,
        component: String,
        message: String,
        correlationId: String? = null,
        paymentId: UUID? = null,
        attributes: Map<String, Any?> = emptyMap(),
    ) {
        log
            .atLevel(
                if (level ==
                    "ERROR"
                ) {
                    org.slf4j.event.Level.ERROR
                } else if (level == "WARN") {
                    org.slf4j.event.Level.WARN
                } else {
                    org.slf4j.event.Level.INFO
                },
            ).log("[{}] {} paymentId={}", component, message, paymentId)
        try {
            tx.executeWithoutResult {
                jdbc
                    .sql(
                        """
                    INSERT INTO operational_logs (occurred_at, level, component, message, correlation_id, payment_id, attributes)
                    VALUES (:at, :level, :component, :message, :corr, :pid, CAST(:attrs AS jsonb))
                    """,
                    ).param("at", java.sql.Timestamp.from(clock.instant()))
                    .param("level", level)
                    .param("component", component)
                    .param("message", sanitize(message))
                    .param("corr", correlationId)
                    .param("pid", paymentId)
                    .param("attrs", mapper.writeValueAsString(attributes))
                    .update()
            }
        } catch (e: Exception) {
            log.warn("Could not persist operational log line: {}", e.javaClass.simpleName)
        }
    }

    companion object {
        /** Bounds length and strips control characters; content is still treated as untrusted by consumers. */
        fun sanitize(message: String): String = message.replace(Regex("[\\p{Cntrl}&&[^ ]]"), " ").take(1000)
    }
}
