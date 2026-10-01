package com.paysense.common

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.SerializationFeature
import jakarta.servlet.FilterChain
import jakarta.servlet.ReadListener
import jakarta.servlet.ServletInputStream
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletRequestWrapper
import jakarta.servlet.http.HttpServletResponse
import org.springframework.boot.autoconfigure.jackson.Jackson2ObjectMapperBuilderCustomizer
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.core.Ordered
import org.springframework.core.annotation.Order
import org.springframework.http.MediaType
import org.springframework.stereotype.Component
import org.springframework.web.filter.OncePerRequestFilter
import java.io.ByteArrayInputStream
import java.io.IOException

@Configuration
class JsonConfig {
    @Bean
    fun jsonCustomizer() =
        Jackson2ObjectMapperBuilderCustomizer { b ->
            b.featuresToDisable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
            b.simpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX")
        }
}

/**
 * Rejects oversized request bodies before they are parsed. Content-Length is checked up front and the stream
 * is counted so that chunked uploads cannot bypass the limit.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 1)
class RequestSizeLimitFilter(
    private val props: PaySenseProperties,
    private val mapper: ObjectMapper,
) : OncePerRequestFilter() {
    override fun doFilterInternal(
        request: HttpServletRequest,
        response: HttpServletResponse,
        chain: FilterChain,
    ) {
        val limit = props.security.maxRequestBytes
        if (request.contentLengthLong > limit) {
            reject(request, response)
            return
        }
        chain.doFilter(CountingRequest(request, limit), response)
    }

    private fun reject(
        request: HttpServletRequest,
        response: HttpServletResponse,
    ) {
        response.status = 413
        response.contentType = MediaType.APPLICATION_JSON_VALUE
        val body =
            ErrorResponse(
                "PAYLOAD_TOO_LARGE",
                "Request body exceeds the allowed size",
                413,
                java.time.Instant.now(),
                request.requestURI,
                CorrelationId.current(),
            )
        mapper.writeValue(response.outputStream, body)
    }

    private class CountingRequest(
        request: HttpServletRequest,
        private val limit: Long,
    ) : HttpServletRequestWrapper(request) {
        override fun getInputStream(): ServletInputStream {
            val delegate = super.getInputStream()
            return object : ServletInputStream() {
                private var count = 0L

                private fun check(n: Int): Int {
                    if (n > 0) {
                        count += n
                        if (count > limit) throw IOException("Request body exceeds $limit bytes")
                    }
                    return n
                }

                override fun read(): Int = delegate.read().also { if (it >= 0) check(1) }

                override fun read(
                    b: ByteArray,
                    off: Int,
                    len: Int,
                ): Int = check(delegate.read(b, off, len))

                override fun isFinished() = delegate.isFinished

                override fun isReady() = delegate.isReady

                override fun setReadListener(l: ReadListener?) = delegate.setReadListener(l)
            }
        }
    }
}
