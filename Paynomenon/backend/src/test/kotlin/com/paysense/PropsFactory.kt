package com.paysense

import com.paysense.common.PaySenseProperties
import java.math.BigDecimal
import java.time.Duration

/** Builds a PaySenseProperties instance for unit tests without starting Spring. */
object PropsFactory {
    fun props(
        simulationEnabled: Boolean = true,
        simulationSeed: Long = 42,
        environment: String = "development",
    ) = PaySenseProperties(
        environment,
        false,
        PaySenseProperties.Security(
            "test-secret-test-secret-test-secret-1234",
            60,
            "svc",
            "prom",
            "prom-pass",
            "cb-secret",
            true,
            "v",
            "i",
            "a",
            65536,
        ),
        PaySenseProperties.Payments(
            listOf("EUR", "USD", "GBP", "JPY"),
            BigDecimal("1000000"),
            Duration.ofMinutes(2),
            Duration.ofSeconds(30),
            Duration.ofHours(24),
            Duration.ofSeconds(60),
        ),
        PaySenseProperties.Processors(
            listOf("MOCK_PROCESSOR", "MOCK_PROCESSOR_EU"),
            Duration.ofSeconds(2),
            PaySenseProperties.Retry(3, Duration.ofMillis(10), Duration.ofMillis(50), 2.0, Duration.ofSeconds(5)),
            PaySenseProperties.CircuitBreaker(20, 10, 0.5, Duration.ofSeconds(15), 3),
            50,
        ),
        PaySenseProperties.Simulation(simulationEnabled, false, simulationSeed),
        PaySenseProperties.Events(
            "in-process",
            "paysense.events.v1",
            3,
            "paysense-event-handlers",
            PaySenseProperties.Outbox(50, Duration.ofMillis(500), 5, Duration.ofMillis(10), Duration.ofMillis(100), Duration.ofDays(7)),
            PaySenseProperties.ConsumerRetry(3, Duration.ofMillis(5), Duration.ofMillis(20), 2.0, Duration.ofSeconds(5)),
        ),
        PaySenseProperties.UncertainResolution(5),
        PaySenseProperties.Redis(false),
        PaySenseProperties.RateLimit(20, 20),
        PaySenseProperties.Analytics(Duration.ofDays(31), Duration.ofHours(24), 20, Duration.ofSeconds(10)),
        PaySenseProperties.Ai("http://localhost:1", "tok", Duration.ofMillis(200), Duration.ofSeconds(1), Duration.ofDays(30)),
        PaySenseProperties.Retention(Duration.ofDays(7), Duration.ofDays(14)),
        PaySenseProperties.Seed(false),
        PaySenseProperties.Runbooks(false),
    )
}
