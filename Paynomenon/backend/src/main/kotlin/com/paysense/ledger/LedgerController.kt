package com.paysense.ledger

import com.paysense.common.NotFoundException
import io.swagger.v3.oas.annotations.tags.Tag
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import java.math.BigDecimal
import java.time.Instant
import java.util.UUID

data class LedgerEntryView(
    val account: String,
    val direction: String,
    val amount: BigDecimal,
    val currency: String,
)

data class LedgerTransactionView(
    val id: UUID,
    val operation: String,
    val currency: String,
    val amount: BigDecimal,
    val reversesTransactionId: UUID?,
    val createdAt: Instant,
    val entries: List<LedgerEntryView>,
)

/** Read-only view of the immutable ledger. Corrections are new (reversing) transactions, never edits. */
@RestController
@RequestMapping("/api/v1")
@Tag(name = "Ledger")
class LedgerController(
    private val jdbc: JdbcClient,
    private val ledger: LedgerService,
) {
    @GetMapping("/payments/{id}/ledger")
    fun forPayment(
        @PathVariable id: UUID,
    ): List<LedgerTransactionView> {
        if (jdbc
                .sql(
                    "SELECT 1 FROM payments WHERE id = :id",
                ).param("id", id)
                .query(Int::class.java)
                .optional()
                .isEmpty
        ) {
            throw NotFoundException("Payment", id)
        }
        val txs =
            jdbc
                .sql(
                    "SELECT id, operation, currency, amount, reverses_transaction_id, created_at FROM ledger_transactions WHERE payment_id = :id ORDER BY created_at, operation",
                ).param("id", id)
                .query {
                        rs,
                        _,
                    ->
                    arrayOf(
                        rs.getObject("id", UUID::class.java),
                        rs.getString("operation"),
                        rs.getString("currency").trim(),
                        rs.getBigDecimal("amount"),
                        rs.getObject("reverses_transaction_id", UUID::class.java),
                        rs.getTimestamp("created_at").toInstant(),
                    )
                }.list()
        return txs.map { t ->
            val entries =
                jdbc
                    .sql(
                        "SELECT account, direction, amount, currency FROM ledger_entries WHERE transaction_id = :t ORDER BY direction DESC, account",
                    ).param("t", t[0])
                    .query {
                            rs,
                            _,
                        ->
                        LedgerEntryView(
                            rs.getString("account"),
                            rs.getString("direction"),
                            rs.getBigDecimal("amount"),
                            rs.getString("currency").trim(),
                        )
                    }.list()
            LedgerTransactionView(t[0] as UUID, t[1] as String, t[2] as String, t[3] as BigDecimal, t[4] as UUID?, t[5] as Instant, entries)
        }
    }

    @GetMapping("/ledger/balances")
    fun balances() = ledger.balances()
}
