package com.paysense.unit

import com.paysense.common.ValidationException
import com.paysense.idempotency.IdempotencyKeys
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNull

class IdempotencyKeysTest {
    @Test
    fun `fingerprint is stable and sensitive to every field`() {
        val a = IdempotencyKeys.fingerprint("POST /payments", "10.0000", "EUR", "m", "P", "d")
        assertEquals(a, IdempotencyKeys.fingerprint("POST /payments", "10.0000", "EUR", "m", "P", "d"))
        assertEquals(64, a.length)
        assertNotEquals(a, IdempotencyKeys.fingerprint("POST /payments", "10.0001", "EUR", "m", "P", "d"))
        assertNotEquals(a, IdempotencyKeys.fingerprint("POST /payments", "10.0000", "USD", "m", "P", "d"))
        assertNotEquals(a, IdempotencyKeys.fingerprint("POST /payments/1/capture", "10.0000", "EUR", "m", "P", "d"))
        assertNotEquals(
            IdempotencyKeys.fingerprint("op", "ab", "c"),
            IdempotencyKeys.fingerprint("op", "a", "bc"),
            "field boundaries must matter",
        )
    }

    @Test
    fun `key validation`() {
        assertNull(IdempotencyKeys.validate(null))
        assertEquals("abc-123_XYZ", IdempotencyKeys.validate("abc-123_XYZ"))
        listOf("", "has space", "a".repeat(256), "new\nline", "ünïcode").forEach { bad ->
            assertThrows<ValidationException>("'$bad'") { IdempotencyKeys.validate(bad) }
        }
    }
}
