---
id: rb-latency-degradation
title: Runbook - Processor latency degradation
version: 1
type: RUNBOOK
tags: latency, p95, slow, degradation
---
# Processor latency degradation

Rising p95 or p99 response time for a processor, often followed by timeouts.

## Diagnose
1. Compare latency percentiles per processor on the Overview page.
2. A latency anomaly is detected with a rolling median and MAD baseline. Check its observed value, baseline and sample size.
3. Check whether concurrency limits are being hit (rejected calls with reason bulkhead_full).

## Mitigate
Reduce load if the bulkhead is saturated. Otherwise wait for the processor to recover and monitor the timeout rate; do not increase retries, which amplifies load.
