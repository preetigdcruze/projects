package com.paysense.reconciliation

import java.math.BigDecimal

enum class DiscrepancyType {
    MISSING_FROM_REPORT,
    MISSING_INTERNALLY,
    AMOUNT_MISMATCH,
    CURRENCY_MISMATCH,
    DUPLICATE_SETTLEMENT,
    UNEXPECTED_STATE,
}

/** What our own ledger says should have settled. */
data class InternalLine(
    val reference: String,
    val operation: String,
    val amount: BigDecimal,
    val currency: String,
    val paymentStatus: String?,
)

/** One line of the processor's settlement report. */
data class ReportLine(
    val lineNumber: Int,
    val processorTxnId: String,
    val reference: String,
    val operation: String,
    val amount: BigDecimal,
    val currency: String,
)

data class Finding(
    val type: DiscrepancyType,
    val reference: String,
    val operation: String,
    val internal: InternalLine?,
    val report: ReportLine?,
    val details: Map<String, Any?>,
)

data class MatchResult(
    val matched: Int,
    val findings: List<Finding>,
)

/**
 * Pure matching logic, independent of persistence so it is easy to test exhaustively. It only *reports*; it never
 * changes financial records to make a difference disappear.
 */
object ReconciliationMatcher {
    fun match(
        internal: List<InternalLine>,
        report: List<ReportLine>,
        knownPaymentStatus: Map<String, String>,
    ): MatchResult {
        val findings = mutableListOf<Finding>()
        val internalByKey = internal.associateBy { it.reference to it.operation }
        val reportByKey = report.groupBy { it.reference to it.operation }
        var matched = 0

        for ((key, lines) in reportByKey) {
            val (reference, operation) = key
            val first = lines.first()
            val mine = internalByKey[key]
            var clean = true

            if (lines.size > 1) {
                clean = false
                findings +=
                    Finding(
                        DiscrepancyType.DUPLICATE_SETTLEMENT,
                        reference,
                        operation,
                        mine,
                        first,
                        mapOf(
                            "count" to lines.size,
                            "processorTxnIds" to lines.map { it.processorTxnId },
                            "lineNumbers" to lines.map { it.lineNumber },
                        ),
                    )
            }
            if (mine == null) {
                clean = false
                val status = knownPaymentStatus[reference]
                findings +=
                    if (status == null) {
                        Finding(
                            DiscrepancyType.MISSING_INTERNALLY,
                            reference,
                            operation,
                            null,
                            first,
                            mapOf("note" to "reference is unknown to the payment system"),
                        )
                    } else {
                        Finding(
                            DiscrepancyType.UNEXPECTED_STATE,
                            reference,
                            operation,
                            null,
                            first,
                            mapOf("paymentStatus" to status, "note" to "processor settled an operation our ledger has no posting for"),
                        )
                    }
            } else if (!mine.currency.equals(first.currency, ignoreCase = true)) {
                clean = false
                findings +=
                    Finding(
                        DiscrepancyType.CURRENCY_MISMATCH,
                        reference,
                        operation,
                        mine,
                        first,
                        mapOf("internalCurrency" to mine.currency, "reportCurrency" to first.currency),
                    )
            } else if (mine.amount.compareTo(first.amount) != 0) {
                clean = false
                findings +=
                    Finding(
                        DiscrepancyType.AMOUNT_MISMATCH,
                        reference,
                        operation,
                        mine,
                        first,
                        mapOf(
                            "internalAmount" to mine.amount.toPlainString(),
                            "reportAmount" to first.amount.toPlainString(),
                            "difference" to first.amount.subtract(mine.amount).toPlainString(),
                        ),
                    )
            }
            if (clean) matched++
        }

        for ((key, mine) in internalByKey) {
            if (key !in reportByKey) {
                findings +=
                    Finding(
                        DiscrepancyType.MISSING_FROM_REPORT,
                        key.first,
                        key.second,
                        mine,
                        null,
                        mapOf("note" to "ledger shows a settled ${key.second}, but the processor report has no such line"),
                    )
            }
        }
        return MatchResult(matched, findings.sortedWith(compareBy({ it.type }, { it.reference }, { it.operation })))
    }
}
