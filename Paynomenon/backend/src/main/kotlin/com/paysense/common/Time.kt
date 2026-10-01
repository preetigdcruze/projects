package com.paysense.common

import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import java.time.Clock
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset

/**
 * UTC clock whose reading can be pinned per thread. Only the synthetic-data seeder pins it, to generate
 * historical records through the real domain code. Production code paths never set an override.
 */
class OverridableClock(
    private val base: Clock = Clock.systemUTC(),
) : Clock() {
    private val override = ThreadLocal<Instant?>()

    override fun getZone(): ZoneId = ZoneOffset.UTC

    override fun withZone(zone: ZoneId?): Clock = this

    override fun instant(): Instant = override.get() ?: base.instant()

    fun <T> at(
        instant: Instant,
        block: () -> T,
    ): T {
        val previous = override.get()
        override.set(instant)
        try {
            return block()
        } finally {
            if (previous == null) override.remove() else override.set(previous)
        }
    }
}

@Configuration
class TimeConfig {
    @Bean
    fun overridableClock() = OverridableClock()

    @Bean
    fun clock(overridable: OverridableClock): Clock = overridable
}
