package com.paysense.admin

import io.swagger.v3.oas.annotations.tags.Tag
import jakarta.validation.constraints.Min
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import java.time.Instant

data class SeedRequest(
    @field:Min(0) val seed: Long = 42,
    val anchor: Instant? = null,
    val replace: Boolean = false,
)

@RestController
@RequestMapping("/api/v1/admin")
@Tag(name = "Admin (development data)")
class AdminController(
    private val seeds: SeedService,
) {
    /** Generates reproducible synthetic data. Disabled when simulation is off or in production. ADMIN only. */
    @PostMapping("/seed")
    fun seed(
        @RequestBody(required = false) req: SeedRequest?,
    ): SeedSummary {
        val r = req ?: SeedRequest()
        return seeds.seed(r.seed, r.anchor, r.replace)
    }

    @PostMapping("/reset")
    fun reset(): Map<String, String> {
        seeds.reset()
        return mapOf("status" to "reset")
    }
}
