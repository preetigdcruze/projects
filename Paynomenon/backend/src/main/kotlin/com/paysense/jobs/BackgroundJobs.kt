package com.paysense.jobs

import com.paysense.common.PaySenseProperties
import com.paysense.events.EventStatsRepository
import com.paysense.events.OutboxPublisher
import com.paysense.idempotency.IdempotencyService
import com.paysense.payments.StuckPaymentRecovery
import io.micrometer.core.instrument.Gauge
import io.micrometer.core.instrument.MeterRegistry
import org.slf4j.LoggerFactory
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.scheduling.annotation.SchedulingConfigurer
import org.springframework.scheduling.config.ScheduledTaskRegistrar
import org.springframework.stereotype.Component
import java.sql.Timestamp
import java.time.Clock
import java.time.Duration
import java.util.concurrent.atomic.AtomicLong

/**
 * Registers all periodic work in one place. Disabled with paysense.scheduling-enabled=false (tests drive the same
 * services directly). Every job catches its own failures so one bad run never stops the schedule.
 */
@Component
class BackgroundJobs(
    private val props: PaySenseProperties,
    private val publisher: OutboxPublisher,
    private val recovery: StuckPaymentRecovery,
    private val idempotency: IdempotencyService,
    private val stats: EventStatsRepository,
    private val jdbc: JdbcClient,
    private val clock: Clock,
    registry: MeterRegistry,
) : SchedulingConfigurer {
    private val log = LoggerFactory.getLogger(javaClass)
    private val outboxPending = AtomicLong()
    private val outboxFailed = AtomicLong()
    private val outboxAge = AtomicLong()
    private val deadLetters = AtomicLong()

    init {
        Gauge.builder("paysense.outbox.pending", outboxPending) { it.get().toDouble() }.register(registry)
        Gauge.builder("paysense.outbox.failed", outboxFailed) { it.get().toDouble() }.register(registry)
        Gauge.builder("paysense.outbox.oldest_pending_age_seconds", outboxAge) { it.get().toDouble() }.register(registry)
        Gauge.builder("paysense.events.dead_letters", deadLetters) { it.get().toDouble() }.register(registry)
    }

    override fun configureTasks(registrar: ScheduledTaskRegistrar) {
        if (!props.schedulingEnabled) return
        registrar.addFixedDelayTask(
            guard("outbox-publisher") {
                while (publisher.publishBatch() >=
                    props.events.outbox.batchSize
                ) { /* drain */ }
            },
            props.events.outbox.pollInterval,
        )
        registrar.addFixedDelayTask(guard("stuck-payment-recovery") { recovery.sweep() }, props.payments.recoveryInterval)
        registrar.addFixedDelayTask(guard("metrics-sampler") { sampleGauges() }, Duration.ofSeconds(10))
        registrar.addFixedDelayTask(guard("retention") { retention() }, Duration.ofMinutes(15))
    }

    fun sampleGauges() {
        val o = stats.outbox()
        outboxPending.set(o.pending)
        outboxFailed.set(o.failed)
        outboxAge.set(o.oldestPendingAgeSeconds ?: 0)
        deadLetters.set(stats.deadLetters().dead)
    }

    fun retention() {
        val now = clock.instant()
        val idem = idempotency.purgeExpired(now)
        val published = publisher.purgePublished()
        val logs =
            jdbc
                .sql(
                    "DELETE FROM operational_logs WHERE occurred_at < :c",
                ).param("c", Timestamp.from(now.minus(props.retention.operationalLogs)))
                .update()
        val processed =
            jdbc
                .sql(
                    "DELETE FROM processed_events WHERE processed_at < :c",
                ).param("c", Timestamp.from(now.minus(props.retention.processedEvents)))
                .update()
        val ai = jdbc.sql("DELETE FROM ai_investigations WHERE expires_at < :n").param("n", Timestamp.from(now)).update()
        log.info(
            "Retention: idempotency={}, outbox={}, logs={}, processedEvents={}, aiInvestigations={}",
            idem,
            published,
            logs,
            processed,
            ai,
        )
    }

    private fun guard(
        name: String,
        job: () -> Unit,
    ) = Runnable {
        try {
            job()
        } catch (e: Exception) {
            log.error("Background job '{}' failed: {}", name, e.toString())
        }
    }
}
