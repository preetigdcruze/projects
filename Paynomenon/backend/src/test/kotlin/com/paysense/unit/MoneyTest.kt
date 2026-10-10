package com.paysense.unit

import com.paysense.common.Money
import com.paysense.common.ValidationException
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.math.BigDecimal
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class MoneyTest {
    private val supported = setOf("EUR", "USD", "JPY")
    private val max = BigDecimal("1000000")

    private fun of(
        amount: String?,
        currency: String?,
    ) = Money.of(amount?.let(::BigDecimal), currency, supported, max)

    @Test
    fun `normalises to the currency's minor unit and the storage scale`() {
        val m = of("49.9", "eur")
        assertEquals("49.90", m.amount.toPlainString())
        assertEquals("EUR", m.currency)
        assertEquals("49.9000", m.toStorage().toPlainString())
        assertEquals("1500", of("1500", "JPY").amount.toPlainString())
    }

    @Test
    fun `trailing zeros beyond precision are accepted but real excess precision is rejected`() {
        assertEquals("10.00", of("10.0000", "EUR").amount.toPlainString())
        val e = assertThrows<ValidationException> { of("10.001", "EUR") }
        assertTrue(e.details.any { it.field == "amount" && "2 decimal" in it.message })
        assertThrows<ValidationException> { of("10.5", "JPY") }
    }

    @Test
    fun `binary floating point artefacts cannot sneak in`() {
        // 0.1 + 0.2 in doubles is 0.30000000000000004; as a decimal literal it must be exact
        assertEquals("0.30", of("0.30", "EUR").amount.toPlainString())
        assertEquals(BigDecimal("0.30"), BigDecimal("0.1").add(BigDecimal("0.2")).setScale(2))
    }

    @Test
    fun `rejects non-positive, missing, oversized and unsupported input and reports every problem`() {
        assertThrows<ValidationException> { of("0", "EUR") }
        assertThrows<ValidationException> { of("-1", "EUR") }
        assertThrows<ValidationException> { of("1000000.01", "EUR") }
        assertThrows<ValidationException> { of("1" + "0".repeat(30), "EUR") }
        val e = assertThrows<ValidationException> { of(null, "XXX") }
        assertEquals(setOf("amount", "currency"), e.details.map { it.field }.toSet())
    }
}
