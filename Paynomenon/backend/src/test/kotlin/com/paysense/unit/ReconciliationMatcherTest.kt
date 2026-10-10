package com.paysense.unit

import com.paysense.reconciliation.DiscrepancyType
import com.paysense.reconciliation.InternalLine
import com.paysense.reconciliation.ReconciliationMatcher
import com.paysense.reconciliation.ReportLine
import org.junit.jupiter.api.Test
import java.math.BigDecimal
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ReconciliationMatcherTest {
    private fun internal(
        ref: String,
        amount: String = "10.00",
        cur: String = "EUR",
        op: String = "CAPTURE",
    ) = InternalLine(ref, op, BigDecimal(amount), cur, "CAPTURED")

    private fun report(
        ref: String,
        amount: String = "10.00",
        cur: String = "EUR",
        op: String = "CAPTURE",
        line: Int = 1,
        txn: String = "t-$ref",
    ) = ReportLine(line, txn, ref, op, BigDecimal(amount), cur)

    @Test
    fun `identical sets match cleanly and numeric scale does not matter`() {
        val r =
            ReconciliationMatcher.match(
                listOf(internal("a", "10.00"), internal("b", "5.5")),
                listOf(report("a", "10.0000"), report("b", "5.50")),
                emptyMap(),
            )
        assertEquals(2, r.matched)
        assertTrue(r.findings.isEmpty())
    }

    @Test
    fun `detects every discrepancy type`() {
        val internalLines = listOf(internal("ok"), internal("missing-in-report"), internal("amt"), internal("cur"), internal("dup"))
        val reportLines =
            listOf(
                report("ok", line = 1),
                report("amt", "11.00", line = 2),
                report("cur", cur = "USD", line = 3),
                report("dup", line = 4),
                report("dup", line = 5),
                report("phantom", line = 6),
                report("failed-payment", line = 7),
            )
        val r = ReconciliationMatcher.match(internalLines, reportLines, mapOf("failed-payment" to "FAILED", "ok" to "CAPTURED"))
        val byType = r.findings.groupBy { it.type }
        assertEquals(
            setOf(
                DiscrepancyType.MISSING_FROM_REPORT,
                DiscrepancyType.MISSING_INTERNALLY,
                DiscrepancyType.AMOUNT_MISMATCH,
                DiscrepancyType.CURRENCY_MISMATCH,
                DiscrepancyType.DUPLICATE_SETTLEMENT,
                DiscrepancyType.UNEXPECTED_STATE,
            ),
            byType.keys,
        )
        assertEquals("missing-in-report", byType.getValue(DiscrepancyType.MISSING_FROM_REPORT).single().reference)
        assertEquals("phantom", byType.getValue(DiscrepancyType.MISSING_INTERNALLY).single().reference)
        assertEquals("FAILED", byType.getValue(DiscrepancyType.UNEXPECTED_STATE).single().details["paymentStatus"])
        assertEquals("1.00", byType.getValue(DiscrepancyType.AMOUNT_MISMATCH).single().details["difference"])
        assertEquals(2, byType.getValue(DiscrepancyType.DUPLICATE_SETTLEMENT).single().details["count"])
        assertEquals(1, r.matched, "only 'ok' is a clean match")
    }

    @Test
    fun `capture and refund of the same payment are matched independently`() {
        val r =
            ReconciliationMatcher.match(
                listOf(internal("p", op = "CAPTURE"), internal("p", op = "REFUND")),
                listOf(report("p", op = "CAPTURE"), report("p", "9.00", op = "REFUND", line = 2)),
                emptyMap(),
            )
        assertEquals(1, r.matched)
        assertEquals(DiscrepancyType.AMOUNT_MISMATCH, r.findings.single().type)
        assertEquals("REFUND", r.findings.single().operation)
    }

    @Test
    fun `a duplicate that also disagrees on amount reports both problems`() {
        val r =
            ReconciliationMatcher.match(
                listOf(internal("x")),
                listOf(report("x", "99.00", line = 1), report("x", "99.00", line = 2)),
                emptyMap(),
            )
        assertEquals(setOf(DiscrepancyType.DUPLICATE_SETTLEMENT, DiscrepancyType.AMOUNT_MISMATCH), r.findings.map { it.type }.toSet())
    }

    @Test
    fun `empty inputs produce no findings and ordering is deterministic`() {
        assertTrue(ReconciliationMatcher.match(emptyList(), emptyList(), emptyMap()).findings.isEmpty())
        val a = ReconciliationMatcher.match(listOf(internal("b"), internal("a")), emptyList(), emptyMap()).findings.map { it.reference }
        assertEquals(listOf("a", "b"), a)
    }
}
