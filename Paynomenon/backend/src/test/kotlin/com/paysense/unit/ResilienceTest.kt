package com.paysense.unit

import com.paysense.common.resilience.Bulkhead
import com.paysense.common.resilience.BulkheadFullException
import com.paysense.common.resilience.CircuitBreaker
import com.paysense.common.resilience.CircuitBreakerConfig
import com.paysense.common.resilience.CircuitOpenException
import com.paysense.common.resilience.CircuitState
import com.paysense.common.resilience.ErrorClassifier
import com.paysense.common.resilience.RetryExecutor
import com.paysense.common.resilience.RetryExhaustedException
import com.paysense.common.resilience.RetryPolicy
import com.paysense.common.resilience.Retryability
import com.paysense.common.resilience.Sleeper
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private class Retryable : RuntimeException("temporary")

private class Permanent : RuntimeException("permanent")

private class Ambiguous : RuntimeException("timeout")

private val classifier =
    ErrorClassifier {
        when (it) {
            is Retryable -> Retryability.RETRYABLE
            is Ambiguous -> Retryability.AMBIGUOUS
            else -> Retryability.NON_RETRYABLE
        }
    }

class RetryTest {
    private val policy = RetryPolicy(4, Duration.ofMillis(100), Duration.ofMillis(800), 2.0, Duration.ofSeconds(30))
    private val slept = mutableListOf<Duration>()
    private val executor = RetryExecutor(sleeper = Sleeper { slept += it }, random = { 0.5 })

    @Test
    fun `retries a retryable failure until it succeeds`() {
        var calls = 0
        val result =
            executor.execute(policy, classifier) { attempt ->
                calls++
                if (attempt < 3) throw Retryable() else "ok"
            }
        assertEquals("ok", result)
        assertEquals(3, calls)
        assertEquals(2, slept.size)
    }

    @Test
    fun `permanent errors are never retried`() {
        var calls = 0
        assertThrows<Permanent> {
            executor.execute(policy, classifier) {
                calls++
                throw Permanent()
            }
        }
        assertEquals(1, calls)
        assertTrue(slept.isEmpty())
    }

    @Test
    fun `ambiguous outcomes are never retried blindly`() {
        var calls = 0
        assertThrows<Ambiguous> {
            executor.execute(policy, classifier) {
                calls++
                throw Ambiguous()
            }
        }
        assertEquals(1, calls)
    }

    @Test
    fun `gives up after max attempts and reports the cause`() {
        var calls = 0
        val e =
            assertThrows<RetryExhaustedException> {
                executor.execute(policy, classifier) {
                    calls++
                    throw Retryable()
                }
            }
        assertEquals(4, calls)
        assertEquals(4, e.attempts)
        assertTrue(e.cause is Retryable)
    }

    @Test
    fun `backoff grows exponentially, is capped and jitter stays within bounds`() {
        assertEquals(100, policy.ceilingFor(1).toMillis())
        assertEquals(200, policy.ceilingFor(2).toMillis())
        assertEquals(800, policy.ceilingFor(4).toMillis())
        assertEquals(800, policy.ceilingFor(10).toMillis())
        repeat(1000) {
            val d = policy.delayFor(3).toMillis()
            assertTrue(d in 200..400, "delay $d outside [ceiling/2, ceiling]")
        }
        assertEquals(200, policy.delayFor(3) { 0.0 }.toMillis())
        assertEquals(400, policy.delayFor(3) { 1.0 }.toMillis())
    }

    @Test
    fun `stops when the elapsed-time budget would be exceeded`() {
        var now = 0L
        val timed = RetryExecutor(sleeper = Sleeper { now += it.toNanos() }, nanoTime = { now }, random = { 1.0 })
        val tight = RetryPolicy(10, Duration.ofSeconds(1), Duration.ofSeconds(8), 2.0, Duration.ofSeconds(5))
        var calls = 0
        assertThrows<RetryExhaustedException> {
            timed.execute(tight, classifier) {
                calls++
                throw Retryable()
            }
        }
        assertTrue(calls < 10, "elapsed budget must cut retries short (calls=$calls)")
    }
}

class CircuitBreakerTest {
    private class MutableClock(
        var now: Instant = Instant.parse("2026-01-01T00:00:00Z"),
    ) : Clock() {
        override fun getZone() = ZoneOffset.UTC

        override fun withZone(zone: java.time.ZoneId?) = this

        override fun instant() = now
    }

    private val clock = MutableClock()
    private val transitions = mutableListOf<Pair<CircuitState, CircuitState>>()
    private val breaker =
        CircuitBreaker("p", CircuitBreakerConfig(10, 5, 0.5, Duration.ofSeconds(30), 2), clock) { a, b ->
            transitions +=
                a to b
        }

    private fun fail(n: Int) =
        repeat(n) {
            breaker.acquire()
            breaker.failure()
        }

    private fun succeed(n: Int) =
        repeat(n) {
            breaker.acquire()
            breaker.success()
        }

    @Test
    fun `stays closed below the minimum number of calls`() {
        fail(4)
        assertEquals(CircuitState.CLOSED, breaker.state())
    }

    @Test
    fun `opens when the failure rate reaches the threshold and then fails fast`() {
        succeed(2)
        fail(3)
        assertEquals(CircuitState.OPEN, breaker.state())
        val e = assertThrows<CircuitOpenException> { breaker.acquire() }
        assertTrue(e.retryAfter.seconds in 1..30)
    }

    @Test
    fun `half-opens after the open duration and closes after successful probes`() {
        fail(5)
        assertEquals(CircuitState.OPEN, breaker.state())
        clock.now = clock.now.plusSeconds(31)
        assertEquals(CircuitState.HALF_OPEN, breaker.state())
        breaker.acquire()
        breaker.success()
        assertEquals(CircuitState.HALF_OPEN, breaker.state())
        breaker.acquire()
        breaker.success()
        assertEquals(CircuitState.CLOSED, breaker.state())
        assertEquals(
            listOf(
                CircuitState.CLOSED to CircuitState.OPEN,
                CircuitState.OPEN to CircuitState.HALF_OPEN,
                CircuitState.HALF_OPEN to CircuitState.CLOSED,
            ),
            transitions,
        )
    }

    @Test
    fun `a failed probe re-opens the breaker and limits concurrent probes`() {
        fail(5)
        clock.now = clock.now.plusSeconds(31)
        breaker.acquire()
        breaker.acquire()
        assertThrows<CircuitOpenException> { breaker.acquire() } // only 2 probes allowed
        breaker.failure()
        assertEquals(CircuitState.OPEN, breaker.state())
    }

    @Test
    fun `recovery restores a clean window`() {
        fail(5)
        clock.now = clock.now.plusSeconds(31)
        succeed(2)
        succeed(10)
        fail(2)
        assertEquals(CircuitState.CLOSED, breaker.state(), "old failures must not leak into the new window")
    }
}

class BulkheadTest {
    @Test
    fun `rejects calls beyond capacity instead of queueing forever`() {
        val bulkhead = Bulkhead("b", 2, Duration.ofMillis(50))
        val hold = CountDownLatch(1)
        val started = CountDownLatch(2)
        val pool = Executors.newFixedThreadPool(2)
        repeat(2) {
            pool.submit {
                bulkhead.run {
                    started.countDown()
                    hold.await(5, TimeUnit.SECONDS)
                }
            }
        }
        assertTrue(started.await(2, TimeUnit.SECONDS))
        assertThrows<BulkheadFullException> { bulkhead.run { "never" } }
        hold.countDown()
        pool.shutdown()
        pool.awaitTermination(2, TimeUnit.SECONDS)
        assertEquals(2, bulkhead.available())
        assertEquals("ok", bulkhead.run { "ok" })
    }
}
