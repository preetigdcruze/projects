---
id: rb-duplicate-settlement
title: Runbook - Duplicate settlement records
version: 1
type: RUNBOOK
tags: reconciliation, duplicate, settlement
---
# Duplicate settlement records

The same settlement line appears more than once in a processor report.

## Diagnose
1. Open the discrepancy details: the transaction ids and line numbers show whether the lines are exact copies.
2. Confirm the ledger has exactly one posting for the payment; the database constraint on payment and operation prevents duplicates internally.

## Resolve
Ask the processor to confirm whether money moved twice. Until confirmed, treat the duplicate as a reporting defect only. Do not post compensating entries without confirmation.
