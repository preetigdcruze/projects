package com.paysense.common

import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.slf4j.MDC
import org.springframework.core.Ordered
import org.springframework.core.annotation.Order
import org.springframework.stereotype.Component
import org.springframework.web.filter.OncePerRequestFilter
import java.util.UUID

object CorrelationId {
    const val HEADER = "X-Correlation-Id"
    const val MDC_KEY = "correlationId"
    private val SAFE = Regex("^[A-Za-z0-9._-]{8,64}$")

    fun current(): String? = MDC.get(MDC_KEY)

    fun generate(): String = UUID.randomUUID().toString()

    fun sanitize(candidate: String?): String = candidate?.takeIf { SAFE.matches(it) } ?: generate()

    /** Runs [block] with the correlation id bound to the logging context (used by consumers and jobs). */
    fun <T> with(
        id: String,
        block: () -> T,
    ): T {
        val previous = MDC.get(MDC_KEY)
        MDC.put(MDC_KEY, id)
        try {
            return block()
        } finally {
            if (previous == null) MDC.remove(MDC_KEY) else MDC.put(MDC_KEY, previous)
        }
    }

    fun currentOrNew(): String = current() ?: generate()
}

/** Accepts a well-formed inbound correlation id or mints one, binds it to the logs and echoes it back. */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
class CorrelationIdFilter : OncePerRequestFilter() {
    override fun doFilterInternal(
        request: HttpServletRequest,
        response: HttpServletResponse,
        chain: FilterChain,
    ) {
        val id = CorrelationId.sanitize(request.getHeader(CorrelationId.HEADER))
        response.setHeader(CorrelationId.HEADER, id)
        CorrelationId.with(id) { chain.doFilter(request, response) }
    }
}
