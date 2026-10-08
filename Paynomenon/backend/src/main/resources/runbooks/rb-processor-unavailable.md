---
id: rb-processor-unavailable
title: Runbook - Processor unavailable and open circuit breaker
version: 1
type: RUNBOOK
tags: unavailable, 503, circuit breaker, outage, retry
---
# Processor unavailable / circuit open

HTTP 503 style failures are retryable because the processor did not execute the request. PaySense retries with exponential backoff and jitter, and opens a circuit breaker per processor when the failure rate is high.

## Diagnose
1. Look for attempts with status UNAVAILABLE and code PROCESSOR_UNAVAILABLE or PROCESSOR_REJECTED_CIRCUIT_OPEN.
2. Check the circuit state on System Health. OPEN means calls are rejected without being sent.
3. Compare the other processor: if only one processor fails, the problem is on that processor's side.

## Mitigate
- Payments return to CREATED when the processor was never reached, so clients can safely authorize again after recovery.
- The breaker moves to HALF_OPEN after the open duration and closes after successful probe calls. No manual action is needed for recovery.
- Do not disable the breaker during an outage.
