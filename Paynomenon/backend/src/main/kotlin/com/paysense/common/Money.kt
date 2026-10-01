package com.paysense.common

import java.math.BigDecimal
import java.math.RoundingMode
import java.util.Currency

/**
 * Fixed-precision money. Amounts are never doubles; scale is dictated by the ISO-4217 minor unit of the currency
 * (EUR 2, JPY 0). Values with more precision than the currency allows are rejected, never silently rounded.
 */
data class Money private constructor(
    val amount: BigDecimal,
    val currency: String,
) {
    init {
        require(amount.signum() > 0) { "amount must be positive" }
    }

    /** Canonical representation stored in numeric(19,4) columns. */
    fun toStorage(): BigDecimal = amount.setScale(STORAGE_SCALE, RoundingMode.UNNECESSARY)

    override fun toString() = "${amount.toPlainString()} $currency"

    companion object {
        const val STORAGE_SCALE = 4
        private val MAX_DIGITS = 15

        fun of(
            amount: BigDecimal?,
            currencyCode: String?,
            supported: Set<String>,
            max: BigDecimal,
        ): Money {
            val issues = mutableListOf<FieldIssue>()
            val code = currencyCode?.trim()?.uppercase()
            if (code.isNullOrEmpty()) {
                issues += FieldIssue("currency", "currency is required")
            } else if (code !in supported) {
                issues += FieldIssue("currency", "unsupported currency '$code'; supported: ${supported.sorted()}")
            }
            if (amount == null) {
                issues += FieldIssue("amount", "amount is required")
            } else if (amount.signum() <= 0) {
                issues += FieldIssue("amount", "amount must be greater than zero")
            } else if (amount.precision() - amount.scale() > MAX_DIGITS) {
                issues += FieldIssue("amount", "amount is too large")
            } else if (amount > max) {
                issues += FieldIssue("amount", "amount exceeds the maximum of ${max.toPlainString()}")
            }
            if (issues.isEmpty()) {
                val digits = Currency.getInstance(code!!).defaultFractionDigits.coerceAtLeast(0)
                val stripped = amount!!.stripTrailingZeros()
                if (stripped.scale() > digits) {
                    issues += FieldIssue("amount", "$code supports at most $digits decimal places")
                } else {
                    return Money(amount.setScale(digits, RoundingMode.UNNECESSARY), code)
                }
            }
            throw ValidationException("Invalid monetary amount", issues)
        }

        /** Rehydrates a stored value without re-validating business limits. */
        fun fromStorage(
            amount: BigDecimal,
            currency: String,
        ): Money {
            val digits = Currency.getInstance(currency).defaultFractionDigits.coerceAtLeast(0)
            return Money(amount.setScale(digits, RoundingMode.UNNECESSARY), currency)
        }
    }
}
