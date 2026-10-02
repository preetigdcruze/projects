package com.paysense.security

import com.paysense.common.ApiException
import com.paysense.common.PaySenseProperties
import io.swagger.v3.oas.annotations.tags.Tag
import jakarta.validation.Valid
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
import org.slf4j.LoggerFactory
import org.springframework.boot.ApplicationArguments
import org.springframework.boot.ApplicationRunner
import org.springframework.http.HttpStatus
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.stereotype.Component
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import java.time.Clock

data class LoginRequest(
    @field:NotBlank @field:Size(max = 64) val username: String?,
    @field:NotBlank @field:Size(max = 128) val password: String?,
)

data class LoginResponse(
    val accessToken: String,
    val tokenType: String,
    val expiresInSeconds: Long,
    val username: String,
    val role: Role,
)

data class MeResponse(
    val username: String,
    val role: String,
)

@RestController
@RequestMapping("/api/v1/auth")
@Tag(name = "Auth")
class AuthController(
    private val users: UserRepository,
    private val encoder: PasswordEncoder,
    private val tokens: TokenService,
) {
    // A precomputed hash keeps response time similar for unknown usernames (no user enumeration by timing).
    private val dummyHash = encoder.encode("not-a-real-password")

    @PostMapping("/login")
    fun login(
        @Valid @RequestBody req: LoginRequest,
    ): LoginResponse {
        val user = users.findByUsername(req.username!!)
        val ok =
            if (user != null &&
                user.enabled
            ) {
                encoder.matches(req.password, user.passwordHash)
            } else {
                encoder.matches(req.password, dummyHash).and(false)
            }
        if (!ok || user == null) throw ApiException(HttpStatus.UNAUTHORIZED, "INVALID_CREDENTIALS", "Invalid username or password")
        val token = tokens.issue(user)
        return LoginResponse(token.token, "Bearer", token.expiresInSeconds, user.username, user.role)
    }

    @GetMapping("/me")
    fun me() = MeResponse(CurrentUser.name(), listOf("ADMIN", "INVESTIGATOR", "VIEWER").firstOrNull { CurrentUser.hasRole(it) } ?: "NONE")
}

/** Creates the documented development accounts. Disabled unless paysense.security.demo-users-enabled=true. */
@Component
class DemoUserSeeder(
    private val users: UserRepository,
    private val encoder: PasswordEncoder,
    private val props: PaySenseProperties,
    private val clock: Clock,
) : ApplicationRunner {
    private val log = LoggerFactory.getLogger(javaClass)

    override fun run(args: ApplicationArguments) {
        if (!props.security.demoUsersEnabled) return
        check(!props.isProduction) { "Demo users must not be enabled in production" }
        mapOf(
            "viewer" to (Role.VIEWER to props.security.demoPasswordViewer),
            "investigator" to (Role.INVESTIGATOR to props.security.demoPasswordInvestigator),
            "admin" to (Role.ADMIN to props.security.demoPasswordAdmin),
        ).forEach { (name, spec) ->
            if (users.findByUsername(name) == null) {
                users.save(
                    UserAccount(
                        username = name,
                        passwordHash = encoder.encode(spec.second),
                        role = spec.first,
                        createdAt = clock.instant(),
                    ),
                )
                log.info("Created development account '{}' with role {}", name, spec.first)
            }
        }
    }
}
