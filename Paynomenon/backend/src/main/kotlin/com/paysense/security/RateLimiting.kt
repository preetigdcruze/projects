package com.paysense.security

import com.paysense.common.PaySenseProperties
import com.paysense.common.TooManyRequestsException
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.ObjectProvider
import org.springframework.context.annotation.Configuration
import org.springframework.data.redis.core.StringRedisTemplate
import org.springframework.stereotype.Component
import org.springframework.web.servlet.HandlerInterceptor
import org.springframework.web.servlet.config.annotation.InterceptorRegistry
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer
import java.time.Clock
import java.time.Duration
import java.util.concurrent.ConcurrentHashMap

interface RateLimiter {
    /** Returns 0 when the call is allowed, otherwise the number of seconds until the window resets. */
    fun acquire(
        key: String,
        limit: Int,
        window: Duration,
    ): Long
}

/** Fixed-window limiter, per process. Used when Redis is disabled or temporarily unreachable. */
class InMemoryRateLimiter(
    private val clock: Clock,
) : RateLimiter {
    private data class Window(
        val startedAtMillis: Long,
        var count: Int,
    )

    private val windows = ConcurrentHashMap<String, Window>()

    /** Clears all counters (used by tests). */
    fun reset() = windows.clear()

    override fun acquire(
        key: String,
        limit: Int,
        window: Duration,
    ): Long {
        val now = clock.millis()
        val w =
            windows.compute(key) { _, cur ->
                if (cur == null || now - cur.startedAtMillis >= window.toMillis()) Window(now, 1) else cur.also { it.count++ }
            }!!
        if (windows.size > 10_000) windows.entries.removeIf { now - it.value.startedAtMillis >= window.toMillis() }
        return if (w.count <= limit) 0 else ((window.toMillis() - (now - w.startedAtMillis)) / 1000).coerceAtLeast(1)
    }
}

/**
 * Redis-backed fixed-window limiter, so limits hold across several backend instances. Redis is used only for this
 * ephemeral counter; if it is unreachable we degrade to the per-process limiter rather than failing requests.
 */
class RedisRateLimiter(
    private val redis: StringRedisTemplate,
    private val fallback: RateLimiter,
) : RateLimiter {
    private val log = LoggerFactory.getLogger(javaClass)

    override fun acquire(
        key: String,
        limit: Int,
        window: Duration,
    ): Long =
        try {
            val redisKey = "paysense:rl:$key"
            val count = redis.opsForValue().increment(redisKey) ?: 1L
            if (count == 1L) redis.expire(redisKey, window)
            if (count <= limit) 0 else (redis.getExpire(redisKey).takeIf { it > 0 } ?: window.seconds)
        } catch (e: Exception) {
            log.warn("Redis rate limiter unavailable, using in-memory fallback: {}", e.javaClass.simpleName)
            fallback.acquire(key, limit, window)
        }
}

@Configuration
class RateLimitConfig(
    private val props: PaySenseProperties,
    private val clock: Clock,
) {
    @org.springframework.context.annotation.Bean
    fun rateLimiter(redis: ObjectProvider<StringRedisTemplate>): RateLimiter {
        val memory = InMemoryRateLimiter(clock)
        val template = redis.ifAvailable
        return if (props.redis.enabled && template != null) RedisRateLimiter(template, memory) else memory
    }
}

@Component
class RateLimitInterceptor(
    private val limiter: RateLimiter,
    private val props: PaySenseProperties,
) : HandlerInterceptor {
    override fun preHandle(
        request: HttpServletRequest,
        response: HttpServletResponse,
        handler: Any,
    ): Boolean {
        val path = request.requestURI
        val (bucket, limit) =
            when {
                path == "/api/v1/auth/login" -> "login:${request.remoteAddr}" to props.rateLimit.loginPerMinute
                path.startsWith("/api/v1/ai/") && request.method == "POST" -> "ai:${CurrentUser.name()}" to props.rateLimit.aiPerMinute
                else -> return true
            }
        val retryAfter = limiter.acquire(bucket, limit, Duration.ofMinutes(1))
        if (retryAfter > 0) throw TooManyRequestsException(retryAfter)
        return true
    }
}

@Configuration
class WebMvcRateLimitConfig(
    private val interceptor: RateLimitInterceptor,
) : WebMvcConfigurer {
    override fun addInterceptors(registry: InterceptorRegistry) {
        registry.addInterceptor(interceptor).addPathPatterns("/api/v1/auth/login", "/api/v1/ai/**")
    }
}
