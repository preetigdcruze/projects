---
id: rb-dead-letter-events
title: Runbook - Dead-letter events
version: 1
type: RUNBOOK
tags: dead letter, kafka, consumer, replay, outbox
---
# Dead-letter events

An event is dead-lettered when a consumer failed it after the configured number of retries, or the failure can never succeed.

## Diagnose
1. Read the error class and message on the dead-letter record and the related operational log lines.
2. Transient causes (database or processor outage) resolve themselves; replay once the dependency is healthy.
3. Permanent causes (bad payload) need a code or data fix first.

## Replay (ADMIN only)
Replay requires a written reason, is limited to three attempts per event and goes through durable deduplication, so an event that actually succeeded earlier cannot take effect twice.

## Outbox
Events stuck as FAILED in the outbox can be requeued by an ADMIN once Kafka is reachable.
