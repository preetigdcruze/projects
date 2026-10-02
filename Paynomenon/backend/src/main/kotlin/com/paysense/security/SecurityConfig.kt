package com.paysense.security

import com.fasterxml.jackson.databind.ObjectMapper
import com.paysense.common.CorrelationId
import com.paysense.common.ErrorResponse
import com.paysense.common.PaySenseProperties
import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.boot.actuate.autoconfigure.security.servlet.EndpointRequest
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.core.annotation.Order
import org.springframework.http.HttpMethod
import org.springframework.http.MediaType
import org.springframework.security.access.hierarchicalroles.RoleHierarchy
import org.springframework.security.access.hierarchicalroles.RoleHierarchyImpl
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken
import org.springframework.security.config.annotation.web.builders.HttpSecurity
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer
import org.springframework.security.config.http.SessionCreationPolicy
import org.springframework.security.core.authority.SimpleGrantedAuthority
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.security.core.userdetails.User
import org.springframework.security.core.userdetails.UserDetailsService
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationConverter
import org.springframework.security.provisioning.InMemoryUserDetailsManager
import org.springframework.security.web.AuthenticationEntryPoint
import org.springframework.security.web.SecurityFilterChain
import org.springframework.security.web.access.AccessDeniedHandler
import org.springframework.security.web.authentication.preauth.PreAuthenticatedAuthenticationToken
import org.springframework.security.web.authentication.www.BasicAuthenticationFilter
import org.springframework.web.filter.OncePerRequestFilter
import java.security.MessageDigest
import java.time.Instant

/** Identity helpers used by controllers and services. */
object CurrentUser {
    fun name(): String = SecurityContextHolder.getContext().authentication?.name ?: "anonymous"

    fun hasRole(role: String): Boolean =
        SecurityContextHolder
            .getContext()
            .authentication
            ?.authorities
            ?.any { it.authority == "ROLE_$role" } == true
}

/** Authenticates trusted internal callers (the AI service) by shared token. Grants only ROLE_SERVICE. */
class ServiceTokenFilter(
    private val expected: String,
) : OncePerRequestFilter() {
    override fun doFilterInternal(
        request: HttpServletRequest,
        response: HttpServletResponse,
        chain: FilterChain,
    ) {
        val supplied = request.getHeader(HEADER)
        if (supplied != null && MessageDigest.isEqual(supplied.toByteArray(), expected.toByteArray())) {
            val auth = PreAuthenticatedAuthenticationToken("ai-service", null, listOf(SimpleGrantedAuthority("ROLE_SERVICE")))
            SecurityContextHolder.getContext().authentication = auth
        }
        chain.doFilter(request, response)
    }

    companion object {
        const val HEADER = "X-Service-Token"
    }
}

@Configuration
class SecurityConfig(
    private val props: PaySenseProperties,
    private val mapper: ObjectMapper,
) {
    @Bean
    fun passwordEncoder(): PasswordEncoder = BCryptPasswordEncoder(10)

    @Bean
    fun roleHierarchy(): RoleHierarchy =
        RoleHierarchyImpl
            .withDefaultRolePrefix()
            .role("ADMIN")
            .implies("INVESTIGATOR")
            .role("INVESTIGATOR")
            .implies("VIEWER")
            .build()

    /** Operational endpoints (Prometheus, metrics) are protected with HTTP Basic; only health probes are open. */
    @Bean
    @Order(1)
    fun actuatorChain(
        http: HttpSecurity,
        encoder: PasswordEncoder,
    ): SecurityFilterChain {
        val metrics =
            InMemoryUserDetailsManager(
                User
                    .withUsername(props.security.metricsUser)
                    .password(encoder.encode(props.security.metricsPassword))
                    .roles("METRICS")
                    .build(),
            )
        http
            .securityMatcher(EndpointRequest.toAnyEndpoint())
            .userDetailsService(metrics as UserDetailsService)
            .authorizeHttpRequests {
                it.requestMatchers(EndpointRequest.to("health")).permitAll()
                it.anyRequest().hasAnyRole("METRICS", "ADMIN")
            }.httpBasic { }
            .csrf { it.disable() }
            .sessionManagement { it.sessionCreationPolicy(SessionCreationPolicy.STATELESS) }
        return http.build()
    }

    @Bean
    @Order(2)
    fun apiChain(http: HttpSecurity): SecurityFilterChain {
        http
            .csrf(AbstractHttpConfigurer<*, *>::disable) // stateless bearer-token API: no cookies, no CSRF surface
            .sessionManagement { it.sessionCreationPolicy(SessionCreationPolicy.STATELESS) }
            .addFilterBefore(ServiceTokenFilter(props.security.serviceToken), BasicAuthenticationFilter::class.java)
            .oauth2ResourceServer { rs ->
                rs.jwt { it.jwtAuthenticationConverter(jwtConverter()) }
                rs.authenticationEntryPoint(entryPoint())
                rs.accessDeniedHandler(deniedHandler())
            }.exceptionHandling {
                it.authenticationEntryPoint(entryPoint())
                it.accessDeniedHandler(deniedHandler())
            }.authorizeHttpRequests { a ->
                a.requestMatchers("/error", "/api/v1/auth/login").permitAll()
                a.requestMatchers("/api/v1/processors/callbacks").permitAll() // HMAC-verified in the controller
                a
                    .requestMatchers("/swagger-ui/**", "/swagger-ui.html", "/v3/api-docs/**")
                    .let { if (props.isProduction) it.denyAll() else it.permitAll() }

                // service-to-service (AI layer): persistence of detected anomalies, read-only metrics/runbooks
                a.requestMatchers("/api/v1/internal/**").hasRole("SERVICE")
                a.requestMatchers(HttpMethod.GET, "/api/v1/analytics/**", "/api/v1/runbooks/**").hasAnyRole("VIEWER", "SERVICE")
                a.requestMatchers(HttpMethod.GET, "/api/v1/operational-logs").hasRole("INVESTIGATOR")

                a.requestMatchers("/api/v1/admin/**", "/api/v1/dev/**").hasRole("ADMIN")
                a.requestMatchers(HttpMethod.POST, "/api/v1/payments/*/refund").hasRole("ADMIN")
                a
                    .requestMatchers(
                        HttpMethod.POST,
                        "/api/v1/payments",
                        "/api/v1/payments/*/authorize",
                        "/api/v1/payments/*/capture",
                        "/api/v1/payments/*/cancel",
                    ).hasRole("INVESTIGATOR")
                a.requestMatchers(HttpMethod.POST, "/api/v1/ai/analytics-queries", "/api/v1/ai/runbook-questions").hasRole("VIEWER")
                a
                    .requestMatchers(HttpMethod.POST, "/api/v1/reconciliations", "/api/v1/reconciliations/discrepancies/*/acknowledge")
                    .hasRole("INVESTIGATOR")
                a
                    .requestMatchers(
                        HttpMethod.POST,
                        "/api/v1/ai/**",
                        "/api/v1/incidents",
                        "/api/v1/incidents/*/summarize",
                        "/api/v1/incidents/*/resolve",
                    ).hasRole("INVESTIGATOR")
                a.requestMatchers(HttpMethod.GET, "/api/v1/**").hasRole("VIEWER")
                a.anyRequest().denyAll()
            }
        return http.build()
    }

    private fun jwtConverter() =
        JwtAuthenticationConverter().apply {
            setJwtGrantedAuthoritiesConverter { jwt ->
                listOfNotNull(jwt.getClaimAsString("role")?.let { SimpleGrantedAuthority("ROLE_$it") })
            }
        }

    private fun entryPoint() =
        AuthenticationEntryPoint { req, res, _ -> writeError(req, res, 401, "UNAUTHENTICATED", "Authentication is required") }

    private fun deniedHandler() =
        AccessDeniedHandler { req, res, _ -> writeError(req, res, 403, "FORBIDDEN", "You do not have permission to perform this action") }

    private fun writeError(
        req: HttpServletRequest,
        res: HttpServletResponse,
        status: Int,
        code: String,
        message: String,
    ) {
        res.status = status
        res.contentType = MediaType.APPLICATION_JSON_VALUE
        if (status == 401) res.setHeader("WWW-Authenticate", "Bearer")
        mapper.writeValue(res.outputStream, ErrorResponse(code, message, status, Instant.now(), req.requestURI, CorrelationId.current()))
    }
}
