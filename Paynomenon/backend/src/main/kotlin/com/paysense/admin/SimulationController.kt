package com.paysense.admin

import com.paysense.processors.ProcessorRegistry
import com.paysense.processors.ResilientProcessorClient
import com.paysense.processors.SimOutcome
import com.paysense.processors.SimulationControl
import com.paysense.processors.SimulationSettings
import com.paysense.processors.SimulationStatus
import io.swagger.v3.oas.annotations.tags.Tag
import jakarta.validation.Valid
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

data class ForceOutcomeRequest(
    val outcome: SimOutcome,
    @field:Min(1) @field:Max(1000) val times: Int = 1,
)

/**
 * Development-only controls for the simulated processors. The bean does not exist when
 * paysense.simulation.enabled=false, so production configuration exposes no such endpoints (they return 404).
 */
@RestController
@RequestMapping("/api/v1/dev/simulation")
@ConditionalOnProperty("paysense.simulation.enabled", havingValue = "true")
@Tag(name = "Simulation (development only)")
class SimulationController(
    private val control: SimulationControl,
    private val registry: ProcessorRegistry,
    private val client: ResilientProcessorClient,
) {
    @GetMapping
    fun status(): SimulationStatus = control.status(registry.names)

    @PutMapping("/{processor}")
    fun update(
        @PathVariable processor: String,
        @Valid @RequestBody settings: SimulationSettings,
    ): SimulationStatus {
        registry.require(processor)
        control.update(processor, settings)
        return status()
    }

    @PostMapping("/{processor}/force")
    fun force(
        @PathVariable processor: String,
        @Valid @RequestBody req: ForceOutcomeRequest,
    ): SimulationStatus {
        registry.require(processor)
        control.forceNext(processor, req.outcome, req.times)
        return status()
    }

    @PostMapping("/reset")
    fun reset(): SimulationStatus {
        control.reset()
        return status()
    }

    @GetMapping("/circuits")
    fun circuits() = client.circuitStates()
}
