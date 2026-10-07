package com.paysense.reconciliation

import com.paysense.common.PageResponse
import com.paysense.security.CurrentUser
import io.swagger.v3.oas.annotations.tags.Tag
import jakarta.validation.Valid
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController
import java.time.Instant
import java.util.UUID

data class StartReconciliationRequest(
    @field:NotBlank @field:Size(max = 32) val processor: String?,
    val from: Instant? = null,
    val to: Instant? = null,
    val scenario: ReportScenario = ReportScenario.CLEAN,
)

data class AcknowledgeRequest(
    @field:NotBlank @field:Size(min = 10, max = 2000, message = "explanation must be 10-2000 characters") val explanation: String?,
)

@RestController
@RequestMapping("/api/v1/reconciliations")
@Tag(name = "Reconciliation")
class ReconciliationController(
    private val service: ReconciliationService,
) {
    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    fun start(
        @Valid @RequestBody req: StartReconciliationRequest,
    ): RunView = service.start(req.processor, req.from, req.to, req.scenario, CurrentUser.name())

    @GetMapping
    fun list(
        @RequestParam(defaultValue = "0") page: Int,
        @RequestParam(defaultValue = "20") size: Int,
    ): PageResponse<RunView> = service.listRuns(page, size)

    @GetMapping("/{id}")
    fun get(
        @PathVariable id: UUID,
    ): RunView = service.getRun(id)

    @GetMapping("/{id}/discrepancies")
    fun discrepanciesOfRun(
        @PathVariable id: UUID,
        @RequestParam(required = false) type: String?,
        @RequestParam(required = false) status: String?,
        @RequestParam(defaultValue = "0") page: Int,
        @RequestParam(defaultValue = "50") size: Int,
    ) = service.discrepancies(id, type, status, null, page, size)

    @GetMapping("/discrepancies")
    fun discrepancies(
        @RequestParam(required = false) type: String?,
        @RequestParam(required = false) status: String?,
        @RequestParam(required = false) paymentReference: String?,
        @RequestParam(defaultValue = "0") page: Int,
        @RequestParam(defaultValue = "50") size: Int,
    ) = service.discrepancies(null, type, status, paymentReference, page, size)

    @GetMapping("/discrepancies/{id}")
    fun discrepancy(
        @PathVariable id: UUID,
    ) = service.getDiscrepancy(id)

    @PostMapping("/discrepancies/{id}/acknowledge")
    fun acknowledge(
        @PathVariable id: UUID,
        @Valid @RequestBody req: AcknowledgeRequest,
    ) = service.acknowledge(id, req.explanation!!.trim(), CurrentUser.name())
}
