package com.paysense.ai

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.paysense.common.CorrelationId
import com.paysense.common.PaySenseProperties
import com.paysense.common.resilience.CircuitBreaker
import com.paysense.common.resilience.CircuitBreakerConfig
import com.paysense.common.resilience.CircuitOpenException
import com.paysense.observability.PaySenseMetrics
import org.slf4j.LoggerFactory
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.http.client.JdkClientHttpRequestFactory
import org.springframework.stereotype.Component
import org.springframework.web.client.HttpStatusCodeException
import org.springframework.web.client.ResourceAccessException
import org.springframework.web.client.RestClient
import org.springframework.web.context.request.RequestContextHolder
import org.springframework.web.context.request.ServletRequestAttributes
import java.net.http.HttpClient
import java.time.Clock
import java.time.Duration
import java.util.UUID

/** The AI service could not be used. Core payment processing is never affected by this. */
class AiUnavailableException(
    val category: String,
    message: String,
) : RuntimeException(message)

/**
 * The only way the backend talks to the AI service. The AI service is optional: every failure is mapped to
 * [AiUnavailableException] (or a degraded result) and callers decide how to present it. The caller's own bearer token
 * is forwarded so the AI tools can read exactly what that user may read, and nothing more.
 */
@Component
class AiGateway(
    private val props: PaySenseProperties,
    private val mapper: ObjectMapper,
    private val metrics: PaySenseMetrics,
) {
    private val log = LoggerFactory.getLogger(javaClass)
    private val breaker = CircuitBreaker("ai-service", CircuitBreakerConfig(10, 5, 0.8, Duration.ofSeconds(20), 1), Clock.systemUTC())
    private val client: RestClient =
        RestClient
            .builder()
            .baseUrl(props.ai.baseUrl)
            .requestFactory(
                JdkClientHttpRequestFactory(
                    HttpClient
                        .newBuilder()
                        .version(HttpClient.Version.HTTP_1_1)
                        .connectTimeout(props.ai.connectTimeout)
                        .build(),
                ).apply {
                    setReadTimeout(props.ai.readTimeout)
                },
            ).build()

    fun investigate(
        investigationId: UUID,
        subjectType: String,
        subjectId: UUID,
        question: String,
    ): JsonNode =
        post(
            "/v1/investigations",
            mapOf(
                "investigationId" to investigationId,
                "subjectType" to subjectType,
                "subjectId" to subjectId,
                "question" to question,
            ),
        )

    fun analyticsQuery(question: String): JsonNode = post("/v1/analytics-queries", mapOf("question" to question))

    fun runbookQuestion(question: String): JsonNode = post("/v1/runbooks/ask", mapOf("question" to question))

    fun summarizeIncident(incidentId: UUID): JsonNode = post("/v1/incidents/$incidentId/summary", emptyMap<String, Any>())

    fun detectAnomalies(body: Map<String, Any?>): JsonNode = post("/v1/anomalies/detect", body)

    fun providerStatus(): JsonNode = get("/v1/provider-status", Duration.ofSeconds(3))

    fun health(): JsonNode = get("/health", Duration.ofSeconds(2))

    private fun post(
        path: String,
        body: Any,
    ): JsonNode =
        call("POST", path) {
            client
                .post()
                .uri(path)
                .contentType(MediaType.APPLICATION_JSON)
                .headers(::headers)
                .body(body)
                .retrieve()
                .body(String::class.java)
        }

    private fun get(
        path: String,
        timeout: Duration,
    ): JsonNode =
        call("GET", path) {
            val probe =
                RestClient
                    .builder()
                    .baseUrl(props.ai.baseUrl)
                    .requestFactory(
                        JdkClientHttpRequestFactory(
                            HttpClient
                                .newBuilder()
                                .version(HttpClient.Version.HTTP_1_1)
                                .connectTimeout(timeout)
                                .build(),
                        ).apply {
                            setReadTimeout(timeout)
                        },
                    ).build()
            probe
                .get()
                .uri(path)
                .headers(::headers)
                .retrieve()
                .body(String::class.java)
        }

    private fun headers(h: HttpHeaders) {
        h.set("X-Internal-Token", props.ai.serviceToken)
        CorrelationId.current()?.let { h.set(CorrelationId.HEADER, it) }
        // Forward the caller's identity so AI data tools are authorised as that user, never as the service.
        (RequestContextHolder.getRequestAttributes() as? ServletRequestAttributes)?.request?.getHeader(HttpHeaders.AUTHORIZATION)?.let {
            h.set(HttpHeaders.AUTHORIZATION, it)
        }
    }

    private fun call(
        method: String,
        path: String,
        block: () -> String?,
    ): JsonNode {
        val started = System.nanoTime()
        try {
            breaker.acquire()
        } catch (e: CircuitOpenException) {
            metrics.aiCall("circuit_open", 0)
            throw AiUnavailableException("CIRCUIT_OPEN", "AI service is temporarily unavailable")
        }
        try {
            val raw = block() ?: throw AiUnavailableException("EMPTY_RESPONSE", "AI service returned an empty response")
            breaker.success()
            metrics.aiCall("ok", (System.nanoTime() - started) / 1_000_000)
            return mapper.readTree(raw)
        } catch (e: HttpStatusCodeException) {
            // 4xx means the AI service is up but refused the request; do not count against the breaker
            if (e.statusCode.is4xxClientError) breaker.success() else breaker.failure()
            metrics.aiCall("http_${e.statusCode.value()}", (System.nanoTime() - started) / 1_000_000)
            log.warn("AI service {} {} returned {}", method, path, e.statusCode.value())
            throw AiUnavailableException(
                if (e.statusCode.is4xxClientError) "REJECTED_${e.statusCode.value()}" else "UPSTREAM_ERROR",
                "AI service returned ${e.statusCode.value()}",
            )
        } catch (e: ResourceAccessException) {
            breaker.failure()
            val timeout = e.cause is java.net.http.HttpTimeoutException || e.cause is java.net.SocketTimeoutException
            metrics.aiCall(if (timeout) "timeout" else "unreachable", (System.nanoTime() - started) / 1_000_000)
            throw AiUnavailableException(
                if (timeout) "TIMEOUT" else "UNREACHABLE",
                if (timeout) "AI service timed out" else "AI service is unreachable",
            )
        } catch (e: AiUnavailableException) {
            throw e
        } catch (e: Exception) {
            breaker.failure()
            metrics.aiCall("error", (System.nanoTime() - started) / 1_000_000)
            throw AiUnavailableException("INVALID_RESPONSE", "AI service returned an unreadable response")
        }
    }
}
