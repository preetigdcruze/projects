package com.paysense.unit

import com.paysense.common.Money
import com.paysense.ledger.Account
import com.paysense.ledger.Direction
import com.paysense.ledger.LedgerOperation
import com.paysense.ledger.LedgerRules
import com.paysense.ledger.Posting
import com.paysense.ledger.UnbalancedPostingException
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.math.BigDecimal
import kotlin.test.assertEquals

class LedgerRulesTest {
    private val money = Money.of(BigDecimal("49.99"), "EUR", setOf("EUR"), BigDecimal("1000"))

    @Test
    fun `capture and refund postings balance exactly`() {
        LedgerOperation.entries.forEach { op ->
            val postings = LedgerRules.postingsFor(op, money)
            LedgerRules.requireBalanced(postings)
            assertEquals(2, postings.size)
            assertEquals(
                postings.filter { it.direction == Direction.DEBIT }.sumOf { it.amount },
                postings
                    .filter {
                        it.direction ==
                            Direction.CREDIT
                    }.sumOf { it.amount },
            )
        }
    }

    @Test
    fun `a refund is the exact reverse of the capture`() {
        val capture = LedgerRules.postingsFor(LedgerOperation.CAPTURE, money).associate { it.account to it.direction }
        val refund = LedgerRules.postingsFor(LedgerOperation.REFUND, money).associate { it.account to it.direction }
        assertEquals(Direction.DEBIT, capture[Account.PROCESSOR_RECEIVABLE])
        assertEquals(Direction.CREDIT, refund[Account.PROCESSOR_RECEIVABLE])
        assertEquals(Direction.CREDIT, capture[Account.MERCHANT_PAYABLE])
        assertEquals(Direction.DEBIT, refund[Account.MERCHANT_PAYABLE])
    }

    @Test
    fun `unbalanced, single-sided or non-positive postings are rejected`() {
        val ok = BigDecimal("10.0000")
        assertThrows<UnbalancedPostingException> {
            LedgerRules.requireBalanced(
                listOf(
                    Posting(Account.PROCESSOR_RECEIVABLE, Direction.DEBIT, ok),
                    Posting(Account.MERCHANT_PAYABLE, Direction.CREDIT, BigDecimal("9.9999")),
                ),
            )
        }
        assertThrows<UnbalancedPostingException> {
            LedgerRules.requireBalanced(
                listOf(Posting(Account.PROCESSOR_RECEIVABLE, Direction.DEBIT, ok)),
            )
        }
        assertThrows<UnbalancedPostingException> {
            LedgerRules.requireBalanced(
                listOf(
                    Posting(Account.PROCESSOR_RECEIVABLE, Direction.DEBIT, BigDecimal.ZERO),
                    Posting(Account.MERCHANT_PAYABLE, Direction.CREDIT, BigDecimal.ZERO),
                ),
            )
        }
    }

    @Test
    fun `comparison is numeric not textual so scale differences do not unbalance a transaction`() {
        LedgerRules.requireBalanced(
            listOf(
                Posting(Account.PROCESSOR_RECEIVABLE, Direction.DEBIT, BigDecimal("10.0")),
                Posting(Account.MERCHANT_PAYABLE, Direction.CREDIT, BigDecimal("10.0000")),
            ),
        )
    }
}
