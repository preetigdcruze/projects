package com.paysense.unit

import com.paysense.common.CorrelationId
import com.paysense.common.Paging
import com.paysense.common.TimeRange
import com.paysense.common.ValidationException
import com.paysense.observability.OperationalLogService
import com.paysense.processors.SimOutcome
import com.paysense.processors.SimulationControl
import com.paysense.processors.SimulationSettings
import com.paysense.security.InMemoryRateLimiter
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.springframework.data.domain.Sort
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class MiscUnitTest {
    @Test
    fun `time range defaults and limits`() {
        val now = Instant.parse("2026-03-01T12:00:00Z")
        val r = TimeRange.resolve(null, null, now, Duration.ofHours(24), Duration.ofDays(31))
        assertEquals(now.minus(Duration.ofHours(24)), r.from)
        assertThrows<ValidationException> { TimeRange.resolve(now, now.minusSeconds(1), now, Duration.ofHours(1), Duration.ofDays(1)) }
        assertThrows<ValidationException> {
            TimeRange.resolve(
                now.minus(Duration.ofDays(40)),
                now,
                now,
                Duration.ofHours(1),
                Duration.ofDays(31),
            )
        }
    }

    @Test
    fun `sorting is restricted to an allow-list`() {
        val allowed = mapOf("createdAt" to "createdAt")
        val p = Paging.pageRequest(0, 10, "createdAt,asc", allowed, Sort.unsorted())
        assertEquals(Sort.Direction.ASC, p.sort.getOrderFor("createdAt")!!.direction)
        assertThrows<ValidationException> { Paging.pageRequest(0, 10, "password_hash,asc", allowed, Sort.unsorted()) }
        assertThrows<ValidationException> { Paging.pageRequest(0, 101, null, allowed, Sort.unsorted()) }
        assertThrows<ValidationException> { Paging.pageRequest(-1, 10, null, allowed, Sort.unsorted()) }
    }

    @Test
    fun `correlation ids from clients are validated`() {
        assertEquals("abcdef123456", CorrelationId.sanitize("abcdef123456"))
        assertTrue(CorrelationId.sanitize("short").length >= 32, "too short -> regenerated")
        assertTrue(CorrelationId.sanitize("bad id with spaces\nand newline").length >= 32, "log-injection attempt -> regenerated")
        assertTrue(CorrelationId.sanitize(null).isNotBlank())
    }

    @Test
    fun `operational log text is stripped of control characters and bounded`() {
        val s = OperationalLogService.sanitize("line1\nline2\u0000\u001b[31m" + "x".repeat(2000))
        assertFalse(s.contains('\n') || s.contains('\u0000') || s.contains('\u001b'))
        assertEquals(1000, s.length)
    }

    @Test
    fun `in-memory rate limiter enforces the window and resets`() {
        var now = Instant.parse("2026-01-01T00:00:00Z")
        val clock =
            object : Clock() {
                override fun getZone() = ZoneOffset.UTC

                override fun withZone(zone: java.time.ZoneId?) = this

                override fun instant() = now
            }
        val limiter = InMemoryRateLimiter(clock)
        repeat(3) { assertEquals(0, limiter.acquire("k", 3, Duration.ofMinutes(1))) }
        assertTrue(limiter.acquire("k", 3, Duration.ofMinutes(1)) > 0)
        assertEquals(0, limiter.acquire("other", 3, Duration.ofMinutes(1)), "buckets are independent")
        now = now.plusSeconds(61)
        assertEquals(0, limiter.acquire("k", 3, Duration.ofMinutes(1)))
    }

    @Test
    fun `simulation is deterministic for a given seed and honours forced outcomes`() {
        fun control(seed: Long): SimulationControl {
            val props = com.paysense.PropsFactory.props(simulationSeed = seed)
            return SimulationControl(props)
        }
        val settings = SimulationSettings(insufficientFundsRate = 0.3, timeoutRate = 0.2, unavailableRate = 0.2)

        fun draw(c: SimulationControl) = (1..50).map { c.nextOutcome("P", null).first }
        val a = control(7).also { it.update("P", settings) }
        val b = control(7).also { it.update("P", settings) }
        assertEquals(draw(a), draw(b))
        assertTrue(draw(control(7).also { it.update("P", settings) }).toSet().size > 1)

        val c = control(1)
        c.forceNext("P", SimOutcome.UNAVAILABLE, 2)
        assertEquals(SimOutcome.UNAVAILABLE, c.nextOutcome("P", "x").first)
        assertEquals(SimOutcome.UNAVAILABLE, c.nextOutcome("P", "x").first)
        assertEquals(SimOutcome.APPROVE, c.nextOutcome("P", "x").first)
        assertEquals(SimOutcome.INSUFFICIENT_FUNDS, c.nextOutcome("P", "buy [sim:insufficient_funds]").first)
    }

    @Test
    fun `simulation controls are inert when disabled`() {
        val c = SimulationControl(com.paysense.PropsFactory.props(simulationEnabled = false))
        assertThrows<IllegalStateException> { c.forceNext("P", SimOutcome.TIMEOUT_EXECUTED, 1) }
        assertThrows<IllegalStateException> { c.update("P", SimulationSettings(timeoutRate = 1.0)) }
        assertEquals(
            SimOutcome.APPROVE,
            c.nextOutcome("P", "[sim:timeout]").first,
            "magic markers must not work in production configuration",
        )
    }

    @Test
    fun `simulation rejects invalid rates`() {
        assertThrows<IllegalArgumentException> { SimulationSettings(timeoutRate = 1.5) }
        assertThrows<IllegalArgumentException> { SimulationSettings(delayMs = -1) }
    }
}
