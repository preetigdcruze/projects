---
id: rb-processor-timeouts
title: Runbook - Processor timeouts and UNCERTAIN payments
version: 1
type: RUNBOOK
tags: timeout, uncertain, processor, ambiguous
---
# Processor timeouts and UNCERTAIN payments

A timeout does not prove the processor failed to execute the request. PaySense therefore moves the payment to UNCERTAIN and never retries the charge blindly.

## Diagnose
1. Find payments in UNCERTAIN: Payments page, filter status = UNCERTAIN.
2. Check the payment's attempts: an attempt with status TIMEOUT and failure category TIMEOUT confirms the cause.
3. Check whether a ProcessorTimeout event was published and whether the `uncertain-payment-resolver` consumer processed it (System Health, dead-letter count).
4. Check processor latency percentiles: a rising p95 usually precedes timeouts.

## Resolve
- The resolver performs a read-only lookup by the original processor request id. APPROVED means the operation executed; NOT_FOUND means it did not.
- If the event is dead-lettered, an ADMIN can replay it from the dead-letter list once the processor is reachable.
- Never create a second payment for the same purchase until the first is resolved; it can double charge.

## Escalate
If more than 5 percent of attempts for one processor time out for 10 minutes, open an incident and contact the processor.
