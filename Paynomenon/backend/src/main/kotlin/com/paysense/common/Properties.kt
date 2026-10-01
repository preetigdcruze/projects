package com.paysense.common

import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.boot.context.properties.bind.DefaultValue
import java.time.Duration

@ConfigurationProperties("paysense")
data class PaySenseProperties(
    @DefaultValue("development") val environment: String,
    @DefaultValue("true") val schedulingEnabled: Boolean,
    val security: Security,
    val payments: Payments,
    val processors: Processors,
    val simulation: Simulation,
    val events: Events,
    val uncertainResolution: UncertainResolution,
    val redis: Redis,
    val rateLimit: RateLimit,
    val analytics: Analytics,
    val ai: Ai,
    val retention: Retention,
    val seed: Seed,
    val runbooks: Runbooks,
) {
    val isProduction: Boolean get() = environment.equals("production", ignoreCase = true)

    data class Security(
        val jwtSecret: String,
        @DefaultValue("60") val jwtTtlMinutes: Long,
        val serviceToken: String,
        val metricsUser: String,
        val metricsPassword: String,
        val callbackSecret: String,
        @DefaultValue("false") val demoUsersEnabled: Boolean,
        val demoPasswordViewer: String,
        val demoPasswordInvestigator: String,
        val demoPasswordAdmin: String,
        @DefaultValue("65536") val maxRequestBytes: Long,
    )

    data class Payments(
        val supportedCurrencies: List<String>,
        val maxAmount: java.math.BigDecimal,
        val inFlightTimeout: Duration,
        val recoveryInterval: Duration,
        val idempotencyTtl: Duration,
        val idempotencyInProgressTimeout: Duration,
    )

    data class Processors(
        val names: List<String>,
        val callTimeout: Duration,
        val retry: Retry,
        val circuitBreaker: CircuitBreaker,
        @DefaultValue("50") val maxConcurrentCalls: Int,
    )

    data class Retry(
        val maxAttempts: Int,
        val initialBackoff: Duration,
        val maxBackoff: Duration,
        @DefaultValue("2.0") val multiplier: Double,
        val maxElapsed: Duration,
    )

    data class CircuitBreaker(
        val windowSize: Int,
        val minCalls: Int,
        val failureRateThreshold: Double,
        val openDuration: Duration,
        val halfOpenCalls: Int,
    )

    data class Simulation(
        @DefaultValue("false") val enabled: Boolean,
        @DefaultValue("false") val realDelay: Boolean,
        @DefaultValue("42") val seed: Long,
    )

    data class Events(
        @DefaultValue("in-process") val transport: String,
        val topic: String,
        @DefaultValue("3") val partitions: Int,
        val consumerGroup: String,
        val outbox: Outbox,
        val consumer: ConsumerRetry,
    )

    data class Outbox(
        val batchSize: Int,
        val pollInterval: Duration,
        val maxAttempts: Int,
        val initialBackoff: Duration,
        val maxBackoff: Duration,
        val retention: Duration,
    )

    data class ConsumerRetry(
        val maxAttempts: Int,
        val initialBackoff: Duration,
        val maxBackoff: Duration,
        @DefaultValue("2.0") val multiplier: Double,
        val maxElapsed: Duration,
    )

    data class UncertainResolution(
        val maxLookups: Int,
    )

    data class Redis(
        @DefaultValue("false") val enabled: Boolean,
    )

    data class RateLimit(
        val aiPerMinute: Int,
        val loginPerMinute: Int,
    )

    data class Analytics(
        val maxWindow: Duration,
        val defaultWindow: Duration,
        val minLatencySample: Int,
        val cacheTtl: Duration,
    )

    data class Ai(
        val baseUrl: String,
        val serviceToken: String,
        val connectTimeout: Duration,
        val readTimeout: Duration,
        val retention: Duration,
    )

    data class Retention(
        val operationalLogs: Duration,
        val processedEvents: Duration,
    )

    data class Seed(
        @DefaultValue("false") val onStart: Boolean,
    )

    data class Runbooks(
        @DefaultValue("true") val loadOnStart: Boolean,
    )
}
