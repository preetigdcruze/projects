package com.paysense.observability

import com.paysense.common.resilience.CircuitState
import io.micrometer.core.instrument.Counter
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.Timer
import org.springframework.stereotype.Component
import java.time.Duration
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Central place for domain metrics. Labels are low-cardinality on purpose: operation, outcome, processor name,
 * handler name. Payment ids, correlation ids and exception messages are never used as label values.
 */
@Component
class PaySenseMetrics(
    private val registry: MeterRegistry,
) {
    private val circuitGauges = ConcurrentHashMap<String, AtomicInteger>()

    fun paymentOutcome(
        operation: String,
        outcome: String,
        processor: String,
    ) = Counter
        .builder("paysense.payment.outcomes")
        .tag("operation", operation)
        .tag("outcome", outcome)
        .tag("processor", processor)
        .register(registry)
        .increment()

    fun processorLatency(
        processor: String,
        operation: String,
        millis: Long,
    ) = Timer
        .builder("paysense.processor.latency")
        .tag("processor", processor)
        .tag("operation", operation)
        .publishPercentileHistogram()
        .register(registry)
        .record(Duration.ofMillis(millis))

    fun processorRetry(processor: String) =
        Counter
            .builder("paysense.processor.retries")
            .tag("processor", processor)
            .register(registry)
            .increment()

    fun processorRejected(
        processor: String,
        reason: String,
    ) = Counter
        .builder("paysense.processor.rejected")
        .tag("processor", processor)
        .tag("reason", reason)
        .register(registry)
        .increment()

    fun circuitState(
        processor: String,
        state: CircuitState,
    ) {
        circuitGauges
            .computeIfAbsent(processor) {
                AtomicInteger(0).also { g ->
                    registry.gauge(
                        "paysense.circuit.state",
                        listOf(
                            io.micrometer.core.instrument.Tag
                                .of("processor", processor),
                        ),
                        g,
                    )
                }
            }.set(state.ordinal)
    }

    fun circuitTransition(
        processor: String,
        to: CircuitState,
    ) = Counter
        .builder("paysense.circuit.transitions")
        .tag("processor", processor)
        .tag("to", to.name)
        .register(registry)
        .increment()

    fun eventPublished(result: String) =
        Counter
            .builder("paysense.outbox.publish")
            .tag("result", result)
            .register(registry)
            .increment()

    fun eventHandled(
        handler: String,
        result: String,
    ) = Counter
        .builder("paysense.events.handled")
        .tag("handler", handler)
        .tag("result", result)
        .register(registry)
        .increment()

    fun deadLettered(handler: String) =
        Counter
            .builder("paysense.events.dead_lettered")
            .tag("handler", handler)
            .register(registry)
            .increment()

    fun aiCall(
        outcome: String,
        millis: Long,
    ) {
        Counter
            .builder("paysense.ai.requests")
            .tag("outcome", outcome)
            .register(registry)
            .increment()
        Timer.builder("paysense.ai.latency").register(registry).record(Duration.ofMillis(millis))
    }
}
