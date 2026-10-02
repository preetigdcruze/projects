package com.paysense.security

import com.nimbusds.jose.jwk.source.ImmutableSecret
import com.paysense.common.PaySenseProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.security.oauth2.jose.jws.MacAlgorithm
import org.springframework.security.oauth2.jwt.JwsHeader
import org.springframework.security.oauth2.jwt.JwtClaimsSet
import org.springframework.security.oauth2.jwt.JwtDecoder
import org.springframework.security.oauth2.jwt.JwtEncoder
import org.springframework.security.oauth2.jwt.JwtEncoderParameters
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder
import org.springframework.security.oauth2.jwt.NimbusJwtEncoder
import org.springframework.stereotype.Service
import java.time.Clock
import java.time.Duration
import javax.crypto.spec.SecretKeySpec

@Configuration
class JwtConfig(
    private val props: PaySenseProperties,
) {
    private val key by lazy {
        val secret = props.security.jwtSecret.toByteArray()
        require(secret.size >= 32) { "paysense.security.jwt-secret must be at least 32 bytes" }
        if (props.isProduction) {
            require(!props.security.jwtSecret.startsWith("dev-only")) { "Refusing to start in production with the development JWT secret" }
        }
        SecretKeySpec(secret, "HmacSHA256")
    }

    @Bean
    fun jwtDecoder(): JwtDecoder = NimbusJwtDecoder.withSecretKey(key).macAlgorithm(MacAlgorithm.HS256).build()

    @Bean
    fun jwtEncoder(): JwtEncoder = NimbusJwtEncoder(ImmutableSecret(key))
}

data class IssuedToken(
    val token: String,
    val expiresInSeconds: Long,
)

@Service
class TokenService(
    private val encoder: JwtEncoder,
    private val props: PaySenseProperties,
    private val clock: Clock,
) {
    fun issue(user: UserAccount): IssuedToken {
        val now = clock.instant()
        val ttl = Duration.ofMinutes(props.security.jwtTtlMinutes)
        val claims =
            JwtClaimsSet
                .builder()
                .issuer("paysense")
                .subject(user.username)
                .issuedAt(now)
                .expiresAt(now.plus(ttl))
                .claim("role", user.role.name)
                .build()
        val header = JwsHeader.with(MacAlgorithm.HS256).build()
        return IssuedToken(encoder.encode(JwtEncoderParameters.from(header, claims)).tokenValue, ttl.seconds)
    }
}
