package com.paysense.admin

import com.paysense.ai.AiGateway
import com.paysense.ai.AiUnavailableException
import com.paysense.common.PaySenseProperties
import com.paysense.events.EventStatsRepository
import com.paysense.events.KafkaLagReader
import com.paysense.processors.ProcessorRegistry
import com.paysense.processors.ResilientProcessorClient
import com.paysense.processors.SimulationControl
import io.swagger.v3.oas.annotations.tags.Tag
import org.springframework.beans.factory.ObjectProvider
import org.springframework.data.redis.core.StringRedisTemplate
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import java.lang.management.ManagementFactory
import java.time.Clock
import java.time.Instant

data class ComponentStatus(
    val status: String,
    val detail: String? = null,
)

@RestController
@RequestMapping("/api/v1/system")
@Tag(name = "System")
class SystemStatusController(
    private val jdbc: JdbcClient,
    private val redis: ObjectProvider<StringRedisTemplate>,
    private val props: PaySenseProperties,
    private val stats: EventStatsRepository,
    private val lag: KafkaLagReader,
    private val ai: AiGateway,
    private val processors: ProcessorRegistry,
    private val client: ResilientProcessorClient,
    private val simulation: SimulationControl,
    private val clock: Clock,
) {
    /** One read-only view for the System Health page. A failing dependency degrades its own section, never the whole call. */
    @GetMapping("/status")
    fun status(): Map<String, Any?> {
        val database =
            probe {
                jdbc.sql("SELECT 1").query(Int::class.java).single()
                ComponentStatus("UP")
            }
        val cache =
            if (!props.redis.enabled) {
                ComponentStatus("DISABLED", "Redis is optional: used for rate limiting and caching only")
            } else {
                probe {
                    redis.ifAvailable
                        ?.connectionFactory
                        ?.connection
                        ?.use { it.ping() }
                    ComponentStatus("UP")
                }
            }
        val aiStatus =
            try {
                val h = ai.health()
                ComponentStatus(if (h.path("status").asText() == "ok") "UP" else "DEGRADED", h.path("provider").asText(null))
            } catch (e: AiUnavailableException) {
                ComponentStatus("DOWN", e.category)
            }
        val kafkaLag = lag.read()
        return mapOf(
            "generatedAt" to clock.instant(),
            "backend" to
                mapOf(
                    "status" to "UP",
                    "environment" to props.environment,
                    "startedAt" to Instant.ofEpochMilli(ManagementFactory.getRuntimeMXBean().startTime),
                    "version" to "0.1.0",
                ),
            "database" to database,
            "redis" to cache,
            "ai" to aiStatus,
            "events" to
                mapOf(
                    "transport" to props.events.transport,
                    "outbox" to safe { stats.outbox() },
                    "deadLetters" to safe { stats.deadLetters() },
                    "consumerLag" to (kafkaLag?.totalLag),
                    "consumerLagAvailable" to (kafkaLag != null),
                ),
            "processors" to processors.names.map { mapOf("name" to it, "circuit" to client.circuitState(it).name) },
            "simulation" to mapOf("enabled" to simulation.enabled, "realDelay" to simulation.realDelay),
        )
    }

    private fun probe(block: () -> ComponentStatus): ComponentStatus =
        try {
            block()
        } catch (e: Exception) {
            ComponentStatus("DOWN", e.javaClass.simpleName)
        }

    private fun <T> safe(block: () -> T): Any? =
        try {
            block()
        } catch (e: Exception) {
            mapOf("error" to e.javaClass.simpleName)
        }
}
