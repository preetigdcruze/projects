package com.paysense.ledger

import com.paysense.common.Money
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Service
import java.math.BigDecimal
import java.time.Clock
import java.util.UUID

enum class LedgerOperation { CAPTURE, REFUND }

enum class Account { PROCESSOR_RECEIVABLE, MERCHANT_PAYABLE }

enum class Direction { DEBIT, CREDIT }

data class Posting(
    val account: Account,
    val direction: Direction,
    val amount: BigDecimal,
)

class UnbalancedPostingException(
    message: String,
) : IllegalArgumentException(message)

/**
 * Pure double-entry rules for the simulated environment (not a certified accounting system):
 *  - CAPTURE:  debit PROCESSOR_RECEIVABLE, credit MERCHANT_PAYABLE (money owed to the merchant)
 *  - REFUND:   the exact reverse of the capture; history is corrected by reversal, never by editing entries
 * Authorization is a hold and produces no financial movement.
 */
object LedgerRules {
    fun postingsFor(
        operation: LedgerOperation,
        money: Money,
    ): List<Posting> {
        val amount = money.toStorage()
        return when (operation) {
            LedgerOperation.CAPTURE ->
                listOf(
                    Posting(Account.PROCESSOR_RECEIVABLE, Direction.DEBIT, amount),
                    Posting(Account.MERCHANT_PAYABLE, Direction.CREDIT, amount),
                )
            LedgerOperation.REFUND ->
                listOf(
                    Posting(Account.MERCHANT_PAYABLE, Direction.DEBIT, amount),
                    Posting(Account.PROCESSOR_RECEIVABLE, Direction.CREDIT, amount),
                )
        }
    }

    fun requireBalanced(postings: List<Posting>) {
        if (postings.size < 2) throw UnbalancedPostingException("a ledger transaction needs at least two entries")
        if (postings.any { it.amount.signum() <= 0 }) throw UnbalancedPostingException("entry amounts must be positive")
        val debits = postings.filter { it.direction == Direction.DEBIT }.sumOf { it.amount }
        val credits = postings.filter { it.direction == Direction.CREDIT }.sumOf { it.amount }
        if (debits.compareTo(credits) != 0) throw UnbalancedPostingException("debits $debits do not equal credits $credits")
    }
}

data class LedgerBalance(
    val account: String,
    val currency: String,
    val debits: BigDecimal,
    val credits: BigDecimal,
)

@Service
class LedgerService(
    private val jdbc: JdbcClient,
    private val clock: Clock,
) {
    /**
     * Posts a transaction for the payment inside the caller's transaction. Idempotent per (payment, operation):
     * a second posting attempt is a no-op because of the unique constraint, so duplicates are impossible even when
     * a handler is delivered twice. Returns true if a new posting was written.
     */
    fun post(
        paymentId: UUID,
        operation: LedgerOperation,
        money: Money,
        correlationId: String,
    ): Boolean {
        val postings = LedgerRules.postingsFor(operation, money)
        LedgerRules.requireBalanced(postings)
        val txId = UUID.randomUUID()
        val now = java.sql.Timestamp.from(clock.instant())
        val reverses: UUID? =
            if (operation == LedgerOperation.REFUND) {
                jdbc
                    .sql("SELECT id FROM ledger_transactions WHERE payment_id = :pid AND operation = 'CAPTURE'")
                    .param("pid", paymentId)
                    .query(UUID::class.java)
                    .optional()
                    .orElseThrow { UnbalancedPostingException("cannot refund payment $paymentId: no captured posting to reverse") }
            } else {
                null
            }
        val inserted =
            jdbc
                .sql(
                    """
            INSERT INTO ledger_transactions (id, payment_id, operation, currency, amount, reverses_transaction_id, correlation_id, created_at)
            VALUES (:id, :pid, :op, :cur, :amount, :rev, :corr, :now)
            ON CONFLICT (payment_id, operation) DO NOTHING
            """,
                ).param("id", txId)
                .param("pid", paymentId)
                .param("op", operation.name)
                .param("cur", money.currency)
                .param("amount", money.toStorage())
                .param("rev", reverses)
                .param("corr", correlationId)
                .param("now", now)
                .update()
        if (inserted == 0) return false
        postings.forEach { p ->
            jdbc
                .sql(
                    "INSERT INTO ledger_entries (id, transaction_id, account, direction, amount, currency, created_at) VALUES (:id, :tx, :acc, :dir, :amt, :cur, :now)",
                ).param("id", UUID.randomUUID())
                .param("tx", txId)
                .param("acc", p.account.name)
                .param("dir", p.direction.name)
                .param("amt", p.amount)
                .param("cur", money.currency)
                .param("now", now)
                .update()
        }
        return true
    }

    /** Net position per account and currency. Different currencies are never summed together. */
    fun balances(): List<LedgerBalance> =
        jdbc
            .sql(
                """
        SELECT account, currency,
               COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0) AS debits,
               COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0) AS credits
          FROM ledger_entries GROUP BY account, currency ORDER BY currency, account
        """,
            ).query {
                    rs,
                    _,
                ->
                LedgerBalance(rs.getString("account"), rs.getString("currency"), rs.getBigDecimal("debits"), rs.getBigDecimal("credits"))
            }.list()
}
