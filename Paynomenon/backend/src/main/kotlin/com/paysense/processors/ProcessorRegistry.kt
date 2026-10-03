package com.paysense.processors

import com.paysense.common.FieldIssue
import com.paysense.common.PaySenseProperties
import com.paysense.common.ValidationException
import org.springframework.stereotype.Component
import java.time.Clock

@Component
class ProcessorRegistry(
    props: PaySenseProperties,
    control: SimulationControl,
    ledger: MockProcessorLedger,
    callbacks: ProcessorCallbackSink,
    clock: Clock,
) {
    private val processors: Map<String, PaymentProcessor> =
        props.processors.names.associateWith { MockPaymentProcessor(it, control, ledger, callbacks, clock) }

    val names: List<String> get() = processors.keys.toList()

    fun find(name: String): PaymentProcessor? = processors[name]

    fun require(name: String?): PaymentProcessor =
        processors[name]
            ?: throw ValidationException(
                "Unknown processor",
                listOf(FieldIssue("processor", "unknown processor '$name'; available: $names")),
            )
}
