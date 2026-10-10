package com.paysense.unit

import com.paysense.common.ConflictException
import com.paysense.common.GlobalExceptionHandler
import org.junit.jupiter.api.Test
import org.springframework.dao.QueryTimeoutException
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import org.springframework.transaction.CannotCreateTransactionException
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@RestController
class Boom {
    @GetMapping("/pool")
    fun pool(): Nothing =
        throw CannotCreateTransactionException(
            "HikariPool-1 - Connection is not available, request timed out after 3000ms",
            RuntimeException("jdbc:postgresql://secret-host/db"),
        )

    @GetMapping("/query")
    fun query(): Nothing = throw QueryTimeoutException("select * from payments where secret = 1")

    @GetMapping("/bug")
    fun bug(): Nothing = throw IllegalStateException("internal detail that must not leak")

    @GetMapping("/conflict")
    fun conflict(): Nothing = throw ConflictException("X", "message for the client")
}

class GlobalExceptionHandlerTest {
    private val mvc = MockMvcBuilders.standaloneSetup(Boom()).setControllerAdvice(GlobalExceptionHandler()).build()

    @Test
    fun `an exhausted connection pool is a retryable 503, not a 500, and leaks nothing`() {
        val r = mvc.perform(get("/pool")).andReturn().response
        assertEquals(503, r.status)
        assertEquals("5", r.getHeader("Retry-After"))
        assertTrue(r.contentAsString.contains("DATABASE_UNAVAILABLE"))
        assertFalse(r.contentAsString.contains("Hikari") || r.contentAsString.contains("secret-host"))
    }

    @Test
    fun `data access failures are 503 and never expose SQL`() {
        val r = mvc.perform(get("/query")).andReturn().response
        assertEquals(503, r.status)
        assertFalse(r.contentAsString.contains("select"))
    }

    @Test
    fun `unexpected bugs are 500 without internal messages, and domain conflicts keep their message`() {
        val bug = mvc.perform(get("/bug")).andReturn().response
        assertEquals(500, bug.status)
        assertFalse(bug.contentAsString.contains("internal detail"))
        val conflict = mvc.perform(get("/conflict")).andReturn().response
        assertEquals(409, conflict.status)
        assertTrue(conflict.contentAsString.contains("message for the client"))
    }
}
