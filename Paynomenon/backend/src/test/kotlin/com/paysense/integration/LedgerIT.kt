package com.paysense.integration

import com.paysense.common.Money
import com.paysense.ledger.LedgerOperation
import com.paysense.ledger.LedgerService
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.transaction.support.TransactionTemplate
import java.math.BigDecimal
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class LedgerIT : IntegrationTestBase() {
    @Autowired lateinit var ledger: LedgerService

    @Autowired lateinit var tx: TransactionTemplate

    private fun capturedPayment(
        amount: String = "25.00",
        currency: String = "EUR",
    ): UUID {
        val id = newPaymentId(paymentBody(amount, currency))
        operate(id, "authorize")
        operate(id, "capture")
        return id
    }

    @Test
    fun `a posting is written once per payment and operation, even if attempted again`() {
        val id = capturedPayment()
        val again =
            tx.execute {
                ledger.post(
                    id,
                    LedgerOperation.CAPTURE,
                    Money.of(BigDecimal("25.00"), "EUR", setOf("EUR"), BigDecimal.TEN.pow(6)),
                    "corr-dup-0001",
                )
            }
        assertFalse(again!!, "second posting must be a no-op")
        assertEquals(1, count("SELECT COUNT(*) FROM ledger_transactions WHERE payment_id = '$id'"))
        assertEquals(2, count("SELECT COUNT(*) FROM ledger_entries"))
    }

    @Test
    fun `the database rejects an unbalanced transaction at commit`() {
        val id = newPaymentId()
        val txId = UUID.randomUUID()
        val failure =
            assertFailsWith<Exception> {
                tx.executeWithoutResult {
                    jdbc
                        .sql(
                            "INSERT INTO ledger_transactions (id, payment_id, operation, currency, amount, correlation_id, created_at) VALUES (:t, :p, 'CAPTURE', 'EUR', 10, 'c', now())",
                        ).param("t", txId)
                        .param("p", id)
                        .update()
                    jdbc
                        .sql(
                            "INSERT INTO ledger_entries (id, transaction_id, account, direction, amount, currency, created_at) VALUES (gen_random_uuid(), :t, 'PROCESSOR_RECEIVABLE', 'DEBIT', 10, 'EUR', now())",
                        ).param("t", txId)
                        .update()
                    jdbc
                        .sql(
                            "INSERT INTO ledger_entries (id, transaction_id, account, direction, amount, currency, created_at) VALUES (gen_random_uuid(), :t, 'MERCHANT_PAYABLE', 'CREDIT', 9, 'EUR', now())",
                        ).param("t", txId)
                        .update()
                }
            }
        assertTrue(failure.message!!.contains("unbalanced"), failure.message)
        assertEquals(0, count("SELECT COUNT(*) FROM ledger_transactions"))
    }

    @Test
    fun `a transaction without entries and a currency-mismatched entry are rejected`() {
        val id = newPaymentId()
        assertFailsWith<Exception> {
            tx.executeWithoutResult {
                jdbc
                    .sql(
                        "INSERT INTO ledger_transactions (id, payment_id, operation, currency, amount, correlation_id, created_at) VALUES (gen_random_uuid(), :p, 'CAPTURE', 'EUR', 10, 'c', now())",
                    ).param("p", id)
                    .update()
            }
        }
        val txId = UUID.randomUUID()
        assertFailsWith<Exception> {
            tx.executeWithoutResult {
                jdbc
                    .sql(
                        "INSERT INTO ledger_transactions (id, payment_id, operation, currency, amount, correlation_id, created_at) VALUES (:t, :p, 'CAPTURE', 'EUR', 10, 'c', now())",
                    ).param("t", txId)
                    .param("p", id)
                    .update()
                jdbc
                    .sql(
                        "INSERT INTO ledger_entries (id, transaction_id, account, direction, amount, currency, created_at) VALUES (gen_random_uuid(), :t, 'PROCESSOR_RECEIVABLE', 'DEBIT', 10, 'USD', now())",
                    ).param("t", txId)
                    .update()
            }
        }
        assertEquals(0, count("SELECT COUNT(*) FROM ledger_transactions"))
    }

    @Test
    fun `ledger history is immutable - corrections are made by reversal only`() {
        val id = capturedPayment()
        assertFailsWith<Exception> { jdbc.sql("UPDATE ledger_entries SET amount = 1").update() }
        assertFailsWith<Exception> { jdbc.sql("DELETE FROM ledger_entries").update() }
        assertFailsWith<Exception> { jdbc.sql("UPDATE ledger_transactions SET amount = 1").update() }
        assertFailsWith<Exception> { jdbc.sql("DELETE FROM ledger_transactions").update() }
        operate(id, "refund", admin)
        val rows =
            jdbc
                .sql(
                    "SELECT operation, reverses_transaction_id IS NOT NULL AS reversal FROM ledger_transactions ORDER BY created_at, operation",
                ).query {
                        rs,
                        _,
                    ->
                    rs.getString(1) to
                        rs.getBoolean(2)
                }.list()
        assertEquals(setOf("CAPTURE" to false, "REFUND" to true), rows.toSet())
    }

    @Test
    fun `balances are tracked per currency and net to zero after a refund`() {
        val eur = capturedPayment("10.00", "EUR")
        capturedPayment("20.00", "USD")
        operate(eur, "refund", admin)
        val balances = ledger.balances().groupBy { it.currency }
        assertEquals(setOf("EUR", "USD"), balances.keys)
        balances.getValue("EUR").forEach { assertEquals(0, it.debits.compareTo(it.credits)) }
        assertEquals(
            0,
            balances
                .getValue("EUR")
                .first { it.account == "MERCHANT_PAYABLE" }
                .credits
                .compareTo(BigDecimal("10")),
        )
        assertEquals(
            0,
            balances
                .getValue("USD")
                .first { it.account == "MERCHANT_PAYABLE" }
                .credits
                .compareTo(BigDecimal("20")),
        )
    }

    @Test
    fun `a refund cannot be posted for a payment that was never captured`() {
        val id = newPaymentId()
        assertFailsWith<Exception> {
            tx.execute {
                ledger.post(
                    id,
                    LedgerOperation.REFUND,
                    Money.of(BigDecimal("1.00"), "EUR", setOf("EUR"), BigDecimal.TEN.pow(6)),
                    "corr-ref-0001",
                )
            }
        }
    }
}
