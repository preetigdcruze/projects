# ADR 0003: Isolate AI from payment execution

* Status: accepted
* Date: 2026-10

## Context
LLM output is non-deterministic, can be wrong, and can be steered by attacker-controlled text that ends up in logs, descriptions and processor messages (prompt injection). Payment operations must stay deterministic, authorized and auditable. The AI layer should help engineers understand failures without ever becoming a path to move money.

## Decision
* The AI layer is a **separate process** with **no code path that can authorize, capture, refund or cancel**. Its backend client has only `GET`, restricted to an allow-list of read endpoints, using the **caller's own token**, so it can read exactly what the requesting user can read.
* The only AI-side write is persisting anomalies found by the **statistical** detector, through an internal endpoint with a dedicated service credential that has no payment access.
* The model never chooses tools or arguments freely: the service decides what to retrieve; analytics questions map to a closed set of validated, parameterised operations; numbers come from queries, never from the model.
* Model output is **untrusted data**: strictly parsed, citations checked against retrieved evidence, grounded, filtered for action names and unverifiable "I fixed it" claims, and rendered as inert text, always labelled as interpretation next to verified facts.
* Core workflows never depend on the AI layer; unavailability yields an explicit degraded state, not a fabricated answer.
* Humans perform actions through the normal, role-protected, idempotent payment APIs.

## Consequences
* ✔ Prompt injection can at worst produce a misleading explanation (which validation and UI labelling mitigate), never a payment mutation.
* ✔ AI can be disabled, replaced, rate-limited or rolled back independently; tests assert that no route exists that could mutate payments.
* ✘ The assistant cannot "just fix it"; every remediation is a human decision (intended).
* ✘ Forwarding the caller's JWT couples the AI service to the backend's token format and means long-running AI jobs cannot outlive the token (acceptable: calls are synchronous and short).

## Alternatives considered
Giving the AI service write tools behind a confirmation step (rejected: expands the attack surface for little value in an investigation tool); embedding the AI client in the backend with a shared database account (rejected: removes the process and credential boundary).
