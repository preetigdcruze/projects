---
id: rb-amount-mismatch
title: Runbook - Reconciliation amount or currency mismatch
version: 1
type: RUNBOOK
tags: reconciliation, amount mismatch, currency mismatch, settlement
---
# Amount or currency mismatch

The processor settlement report disagrees with the internal ledger for a payment.

## Diagnose
1. Open the discrepancy and compare internal and report amount and currency.
2. Check the payment's audit events: was there a refund or a partial capture? PaySense only supports full refunds, so a difference equal to a refund points elsewhere.
3. A currency mismatch with the same numeric amount usually indicates a processor-side mapping error.

## Resolve
- Never edit ledger entries. Corrections are made with reversing transactions approved through the finance process.
- Acknowledge the discrepancy with an explanation once the cause is understood. Acknowledging does not change any financial record.
- Raise the difference with the processor if their report is wrong.
