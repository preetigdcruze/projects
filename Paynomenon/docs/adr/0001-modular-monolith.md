# ADR 0001: Start as a modular monolith

* Status: accepted
* Date: 2026-10

## Context
The system has a payment core (strongly consistent: state machine, idempotency, ledger, outbox) and supporting capabilities (analytics, reconciliation, incidents). It must be demonstrable with one `docker compose up`, testable with real PostgreSQL, and understandable in a portfolio review. The AI capability has a different runtime (Python), failure profile (optional, slow, non-deterministic) and security posture (read-only).

## Decision
Build the payment core as **one deployable Spring Boot application with enforced internal module boundaries** (packages with explicit interfaces such as `PaymentProcessor`, `EventHandler`, `ProcessorCallbackSink`). Run the **AI layer as a separate service** from day one. Use PostgreSQL transactions across modules inside the monolith.

## Consequences
* ✔ Payment state, ledger postings, audit events and outbox rows commit in **one local ACID transaction** — no distributed transaction or saga needed for correctness.
* ✔ Simple operation, debugging and testing (a single context, one database); refactors across modules are cheap.
* ✔ The Python AI service can fail, scale or be replaced independently, and cannot touch payment state because it only has read APIs.
* ✘ Modules share a database and a deployment; boundaries are enforced by convention and review, not by the network. A noisy module (analytics) can take pool capacity from payments (mitigated by bounded pools, timeouts and read-only queries; an obvious first split is a read replica for analytics).
* ✘ All instances run all scheduled jobs (safe because of row locks and `SKIP LOCKED`, but wasteful).

## Alternatives considered
* **Microservices (payments, ledger, reconciliation…):** would require distributed transactions or sagas for the very invariants this project wants to show as simple and testable; unjustified operational cost at this scale.
* **AI inside the monolith (JVM):** couples a fast-moving, optional, untrusted-output component to the payment core and removes the hard process boundary that guarantees "AI cannot mutate payments".

## Revisit when
Different scaling or availability needs appear per module, teams need independent release cadences, or analytics load threatens payment latency.
