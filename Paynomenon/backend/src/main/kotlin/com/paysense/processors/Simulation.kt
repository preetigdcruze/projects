package com.paysense.processors

import com.paysense.common.PaySenseProperties
import org.springframework.stereotype.Component
import java.util.Random
import java.util.concurrent.ConcurrentHashMap

enum class SimOutcome {
    APPROVE,
    INSUFFICIENT_FUNDS,
    TIMEOUT_NOT_EXECUTED,
    TIMEOUT_EXECUTED,
    UNAVAILABLE,
    INVALID_REQUEST,
    DELAYED,
    DUPLICATE_CALLBACK,
}

/** Probabilities are independent draws evaluated in a fixed order; all must be within [0, 1]. */
data class SimulationSettings(
    val insufficientFundsRate: Double = 0.0,
    val timeoutRate: Double = 0.0,
    /** Fraction of timeouts where the processor actually executed the request (the dangerous, ambiguous case). */
    val timeoutExecutedRatio: Double = 0.5,
    val unavailableRate: Double = 0.0,
    val invalidRequestRate: Double = 0.0,
    val delayedRate: Double = 0.0,
    val delayMs: Int = 3000,
    val duplicateCallbackRate: Double = 0.0,
    val baseLatencyMs: Int = 80,
    val jitterMs: Int = 40,
) {
    init {
        listOf(
            insufficientFundsRate,
            timeoutRate,
            timeoutExecutedRatio,
            unavailableRate,
            invalidRequestRate,
            delayedRate,
            duplicateCallbackRate,
        ).forEach { require(it in 0.0..1.0) { "rates must be within [0,1]" } }
        require(delayMs in 0..60_000 && baseLatencyMs in 0..60_000 && jitterMs in 0..60_000) { "latencies out of range" }
    }
}

data class SimulationStatus(
    val enabled: Boolean,
    val realDelay: Boolean,
    val settings: Map<String, SimulationSettings>,
    val forcedQueued: Map<String, Int>,
)

/**
 * Runtime controls for the simulated processors. Rates and forced outcomes can be changed through the ADMIN-only
 * development endpoint. When paysense.simulation.enabled=false (production) none of this has any effect: the
 * controller is not registered and the mock processors never fail artificially.
 */
@Component
class SimulationControl(
    private val props: PaySenseProperties,
) {
    val enabled: Boolean = props.simulation.enabled

    @Volatile
    var realDelay: Boolean = props.simulation.realDelay

    private val settings = ConcurrentHashMap<String, SimulationSettings>()
    private val forced = ConcurrentHashMap<String, ArrayDeque<SimOutcome>>()
    private val rngs = ConcurrentHashMap<String, Random>()

    fun settingsFor(processor: String): SimulationSettings = settings[processor] ?: SimulationSettings()

    fun update(
        processor: String,
        new: SimulationSettings,
    ) {
        check(enabled) { "simulation is disabled in this environment" }
        settings[processor] = new
    }

    fun forceNext(
        processor: String,
        outcome: SimOutcome,
        times: Int,
    ) {
        check(enabled) { "simulation is disabled in this environment" }
        require(times in 1..1000)
        val q = forced.computeIfAbsent(processor) { ArrayDeque() }
        synchronized(q) { repeat(times) { q.addLast(outcome) } }
    }

    fun reset(seedOverride: Long? = null) {
        settings.clear()
        forced.clear()
        rngs.clear()
        seedOverride?.let { seed = it }
    }

    @Volatile
    private var seed: Long = props.simulation.seed

    fun status(names: Collection<String>) =
        SimulationStatus(
            enabled,
            realDelay,
            names.associateWith { settingsFor(it) },
            forced.mapValues { synchronized(it.value) { it.value.size } }.filterValues { it > 0 },
        )

    /** Order of precedence: forced queue, then [sim:...] marker in the description, then seeded random draws. */
    fun nextOutcome(
        processor: String,
        description: String?,
    ): Pair<SimOutcome, SimulationSettings> {
        val s = settingsFor(processor)
        if (!enabled) return SimOutcome.APPROVE to s
        forced[processor]?.let { q -> synchronized(q) { q.removeFirstOrNull() }?.let { return it to s } }
        description?.let { magic(it) }?.let { return it to s }
        val rng = rngs.computeIfAbsent(processor) { Random(seed xor processor.hashCode().toLong()) }
        synchronized(rng) {
            fun hit(rate: Double) = rate > 0.0 && rng.nextDouble() < rate
            return when {
                hit(s.unavailableRate) -> SimOutcome.UNAVAILABLE
                hit(s.timeoutRate) ->
                    if (rng.nextDouble() <
                        s.timeoutExecutedRatio
                    ) {
                        SimOutcome.TIMEOUT_EXECUTED
                    } else {
                        SimOutcome.TIMEOUT_NOT_EXECUTED
                    }
                hit(s.invalidRequestRate) -> SimOutcome.INVALID_REQUEST
                hit(s.insufficientFundsRate) -> SimOutcome.INSUFFICIENT_FUNDS
                hit(s.delayedRate) -> SimOutcome.DELAYED
                hit(s.duplicateCallbackRate) -> SimOutcome.DUPLICATE_CALLBACK
                else -> SimOutcome.APPROVE
            } to s
        }
    }

    fun latency(
        processor: String,
        s: SimulationSettings,
        extra: Int = 0,
    ): Int {
        val rng = rngs.computeIfAbsent(processor) { Random(seed xor processor.hashCode().toLong()) }
        val jitter = if (s.jitterMs > 0) synchronized(rng) { rng.nextInt(s.jitterMs + 1) } else 0
        return s.baseLatencyMs + jitter + extra
    }

    private fun magic(description: String): SimOutcome? {
        val m = MAGIC.find(description) ?: return null
        return when (m.groupValues[1].lowercase()) {
            "insufficient_funds" -> SimOutcome.INSUFFICIENT_FUNDS
            "timeout" -> SimOutcome.TIMEOUT_EXECUTED
            "timeout_not_executed" -> SimOutcome.TIMEOUT_NOT_EXECUTED
            "unavailable" -> SimOutcome.UNAVAILABLE
            "invalid" -> SimOutcome.INVALID_REQUEST
            "delayed" -> SimOutcome.DELAYED
            "duplicate_callback" -> SimOutcome.DUPLICATE_CALLBACK
            else -> null
        }
    }

    companion object {
        private val MAGIC = Regex("\\[sim:([a-z_]+)]")
    }
}
