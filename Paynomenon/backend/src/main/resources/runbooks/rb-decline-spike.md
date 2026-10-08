---
id: rb-decline-spike
title: Runbook - Spike in declines (insufficient funds)
version: 1
type: RUNBOOK
tags: declines, insufficient funds, failure rate
---
# Spike in declines

Declines such as INSUFFICIENT_FUNDS are valid business outcomes, not infrastructure failures. A spike is usually caused by a promotion, a batch of recurring charges or a synthetic test run.

## Diagnose
1. Open failure reasons for the time range. If INSUFFICIENT_FUNDS dominates and latency and timeouts are normal, the platform is healthy.
2. Check whether synthetic or test traffic is present (payments labelled synthetic).
3. Check one merchant: a single merchant causing most declines points to a campaign, not a platform fault.

## Act
No remediation is needed on the platform. Inform the merchant if their decline rate is unusually high.
