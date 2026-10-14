# Security

PaySense is a **portfolio simulation**: no real money, cards or bank credentials. The controls below are real and tested, but this is not a security-certified system (see "Limits").

## Authentication and authorization

* **Local JWT authentication** (Spring Security resource server, HS256). `POST /api/v1/auth/login` verifies bcrypt hashes and issues a 60-minute token. Replace with an OIDC provider by swapping `JwtConfig` for `spring.security.oauth2.resourceserver.jwt.issuer-uri`; the role claim mapping is in `SecurityConfig.jwtConverter`.
* Login is rate limited (20/min/IP; Redis-backed when available, per-process otherwise) and does not reveal whether a username exists (constant-work path and identical error).
* **Roles** (hierarchy `ADMIN > INVESTIGATOR > VIEWER`), all enforced centrally in `SecurityConfig` with a default of *deny*:

| Capability | VIEWER | INVESTIGATOR | ADMIN |
|---|---|---|---|
| Read payments, analytics, reconciliation, incidents, system status | ✔ | ✔ | ✔ |
| Natural-language analytics questions, runbook Q&A | ✔ | ✔ | ✔ |
| Create / authorize / capture / cancel payments, start reconciliation, acknowledge discrepancies, create/resolve incidents, run AI investigations and summaries, detect anomalies, read operational logs | | ✔ | ✔ |
| Refund, replay dead letters, requeue outbox, seed/reset data, simulation controls | | | ✔ |

* The **AI service** has no user accounts. The backend forwards the caller's own JWT, so every data tool is authorized as that user: a VIEWER-initiated analytics question cannot read logs, and an investigation never sees more than its requester could. Anomaly persistence uses a separate `ROLE_SERVICE` credential (`X-Service-Token`) that can only call `/api/v1/internal/**` and read analytics/runbooks.
* Service tokens are compared in constant time and are never accepted for user endpoints.

## Demo accounts

`viewer`, `investigator`, `admin` are created **only when** `PAYSENSE_DEMO_USERS_ENABLED=true` and the environment is not `production` (startup fails otherwise). Passwords come from environment variables (`PAYSENSE_DEMO_*_PASSWORD`); `.env.example` documents the development defaults. They are for local use only; never expose a development instance publicly.

## Secrets

* No secret is committed; `.env.example` holds placeholders and `make setup` generates random values into the git-ignored `.env`.
* The backend refuses to start in production with the development JWT secret, and requires ≥ 32 bytes.
* LLM API keys exist only in the AI service's environment (`SecretStr`, redacted from repr/logs). They are never sent to the browser, the backend, or any log. The browser bundle contains no keys or service URLs (nginx proxies `/api`).
* Docker images contain no secrets; compose passes them as environment variables and fails to start if required ones are missing.

## API hardening

* Request size limit (64 KiB, counted on the stream so chunked bodies cannot bypass it), validation on every input, allow-listed sort fields, bounded date ranges and page sizes.
* Errors never contain stack traces, SQL or internal messages (`GlobalExceptionHandler`); every error has a `code`, `correlationId` and optional field issues.
* Correlation ids from clients are validated (`[A-Za-z0-9._-]{8,64}`) to prevent log injection.
* Callback webhooks require an HMAC-SHA256 signature over the raw body (constant-time compare); callbacks cannot overwrite settled states and are deduplicated.
* Actuator: only `health` is public. `/actuator/prometheus` and other endpoints require HTTP Basic credentials with a dedicated metrics user. Swagger UI/OpenAPI are disabled in production.
* **Simulation controls** (`/api/v1/dev/**`, magic `[sim:...]` description markers, seeding, `WITH_DISCREPANCIES` reports) exist only when `paysense.simulation.enabled=true` and are refused/absent in production configuration.
* nginx sets a strict Content-Security-Policy (`default-src 'self'`), `nosniff`, `X-Frame-Options: DENY`, and does not proxy `/actuator`.

## Frontend

* Token stored in `sessionStorage` (cleared on tab close, 401 triggers sign-out). This is a trade-off: XSS could read it. The CSP and the rule below limit that risk; production should use an OIDC flow with `HttpOnly` cookies or a BFF.
* **All AI, log, processor and description text is rendered as React text nodes.** `dangerouslySetInnerHTML` is banned by lint (`no-restricted-syntax`), and a unit test renders `<script>`/`<img onerror>` payloads to prove they stay inert.

## AI security (summary; details in [ai-design.md](ai-design.md))

Untrusted text is normalised, scanned for instruction-like content (and withheld if it matches), and redacted; prompts carry instructions only in the system message; the model has no tools beyond read-only evidence retrieval; outputs must pass strict schemas, citation checks, grounding checks and an action-claim filter; every AI endpoint is rate limited and size limited; interaction metadata (not prompts) is stored for 30 days.

## Limits (be honest about them)

* HS256 with a shared secret and a local user table is a stand-in for a real identity provider; there is no MFA, lockout policy, token revocation list or refresh flow.
* Rate limiting is per-IP/per-user fixed window, not a WAF. No TLS termination is configured in compose (put a TLS proxy in front).
* Prompt-injection defences reduce risk but cannot prove absence of manipulation; the architectural defence (read-only tools, no mutation path) is what bounds the impact.
* The scanner patterns are English-centric heuristics.
* No dependency vulnerability scanning is wired into CI; `npm audit` reports for dev dependencies were not triaged.
