# ADR 0002: Transactional outbox with idempotent consumers

* Status: accepted
* Date: 2026-10

## Context
A payment state change must be announced to other components (e.g. to resolve uncertain payments, to open incidents). Publishing to Kafka directly from the request path creates the dual-write problem: if the process crashes between the database commit and the publish, the event is lost; if it publishes first and the commit fails, a phantom event exists. Kafka also redelivers (rebalances, retries, crashes before offset commit), and exactly-once semantics do not extend to the database and external side effects.

## Decision
1. Write each event to an **`outbox_events` table in the same transaction** as the business change.
2. A **publisher** polls pending rows (`FOR UPDATE SKIP LOCKED`), sends to Kafka, waits for the broker acknowledgement, then marks the row published; failures back off exponentially with jitter and are visible (`FAILED` after the budget, admin requeue).
3. Design for **at-least-once delivery**. Every consumer deduplicates durably with `processed_events(consumer, event_id)` written in the same transaction as the handler's database effects; handlers with external side effects (processor lookup) are themselves idempotent.
4. Retries are bounded; failures end in a **dead-letter table** with an audited, capped, admin-only replay.
5. Offsets are acknowledged only after processing or durable dead-lettering.

## Consequences
* ✔ No lost and no phantom events; recovery after broker, publisher or consumer failure needs no operator action in the common case.
* ✔ Handlers can be tested by delivering the same event twice.
* ✘ Added latency (poll interval, 500 ms by default) and a hot table that needs retention.
* ✘ Not exactly-once end to end; ordering is per aggregate only on the happy path. Consumers must be written to be idempotent and order-tolerant (ours act on current state, not on event sequence).
* ✘ A change-data-capture publisher (Debezium) would remove polling at the cost of more infrastructure; not warranted here.

## Alternatives considered
Kafka transactions across DB and broker (not possible with a relational store); publish-then-commit or commit-then-publish (lossy/phantom); synchronous calls between modules (no need for a broker, but loses the demonstration of failure isolation and replay).
