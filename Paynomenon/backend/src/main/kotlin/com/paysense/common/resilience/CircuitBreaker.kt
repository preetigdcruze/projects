package com.paysense.common.resilience

import java.time.Clock
import java.time.Duration
import java.time.Instant

enum class CircuitState { CLOSED, OPEN, HALF_OPEN }

class CircuitOpenException(
    val name: String,
    val retryAfter: Duration,
) : RuntimeException("Circuit '$name' is open; calls are rejected without being attempted")

data class CircuitBreakerConfig(
    val windowSize: Int,
    val minCalls: Int,
    val failureRateThreshold: Double,
    val openDuration: Duration,
    val halfOpenCalls: Int,
)

/**
 * Count-based circuit breaker. CLOSED: outcomes fill a sliding window; once at least [minCalls] are recorded and
 * the failure rate reaches the threshold the breaker OPENs. OPEN: calls fail fast until [openDuration] elapsed,
 * then HALF_OPEN lets [halfOpenCalls] probes through: all must succeed to close; any failure re-opens.
 */
class CircuitBreaker(
    val name: String,
    private val config: CircuitBreakerConfig,
    private val clock: Clock = Clock.systemUTC(),
    private val onTransition: (from: CircuitState, to: CircuitState) -> Unit = { _, _ -> },
) {
    private val lock = Any()
    private val window = BooleanArray(config.windowSize)
    private var filled = 0
    private var cursor = 0
    private var state = CircuitState.CLOSED
    private var openedAt: Instant = Instant.EPOCH
    private var probesStarted = 0
    private var probesSucceeded = 0

    fun state(): CircuitState =
        synchronized(lock) {
            refresh()
            state
        }

    /** Throws [CircuitOpenException] when the call must not be attempted. Must be paired with success()/failure(). */
    fun acquire() =
        synchronized(lock) {
            refresh()
            when (state) {
                CircuitState.CLOSED -> Unit
                CircuitState.OPEN -> throw CircuitOpenException(name, retryAfter())
                CircuitState.HALF_OPEN -> {
                    if (probesStarted >= config.halfOpenCalls) throw CircuitOpenException(name, Duration.ofSeconds(1))
                    probesStarted++
                }
            }
        }

    fun success() =
        synchronized(lock) {
            when (state) {
                CircuitState.CLOSED -> record(true)
                CircuitState.HALF_OPEN -> {
                    probesSucceeded++
                    if (probesSucceeded >= config.halfOpenCalls) transition(CircuitState.CLOSED)
                }
                CircuitState.OPEN -> Unit
            }
        }

    fun failure() =
        synchronized(lock) {
            when (state) {
                CircuitState.CLOSED -> {
                    record(false)
                    if (filled >= config.minCalls && failureRate() >= config.failureRateThreshold) transition(CircuitState.OPEN)
                }
                CircuitState.HALF_OPEN -> transition(CircuitState.OPEN)
                CircuitState.OPEN -> Unit
            }
        }

    private fun refresh() {
        if (state == CircuitState.OPEN && Duration.between(openedAt, clock.instant()) >= config.openDuration) {
            transition(CircuitState.HALF_OPEN)
        }
    }

    private fun retryAfter(): Duration =
        (config.openDuration - Duration.between(openedAt, clock.instant())).coerceAtLeast(Duration.ofSeconds(1))

    private fun record(ok: Boolean) {
        window[cursor] = ok
        cursor = (cursor + 1) % window.size
        if (filled < window.size) filled++
    }

    private fun failureRate(): Double = if (filled == 0) 0.0 else window.take(filled).count { !it }.toDouble() / filled

    private fun transition(to: CircuitState) {
        val from = state
        state = to
        when (to) {
            CircuitState.OPEN -> openedAt = clock.instant()
            CircuitState.HALF_OPEN -> {
                probesStarted = 0
                probesSucceeded = 0
            }
            CircuitState.CLOSED -> {
                filled = 0
                cursor = 0
            }
        }
        onTransition(from, to)
    }
}

private fun Duration.coerceAtLeast(min: Duration) = if (this < min) min else this
