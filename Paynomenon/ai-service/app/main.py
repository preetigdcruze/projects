from __future__ import annotations

import hashlib
import hmac
import logging
import time
import uuid
from collections import defaultdict
from collections.abc import Callable
from typing import Any

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from . import __version__, metrics
from .analytics_agent import OPERATIONS, AnalyticsAgent
from .anomaly import AnomalyRunner
from .backend_client import AnomalySink, BackendClient, BackendError, BackendReader
from .config import Settings, get_settings
from .incident_summary import IncidentSummarizer
from .investigator import Investigator
from .logging_setup import configure_logging, correlation_id
from .models import AnalyticsRequest, DetectRequest, InvestigationRequest, RunbookAskRequest
from .providers import LLMProvider, ProviderStats, build_provider
from .runbook_qa import ask_runbooks

log = logging.getLogger("paysense.ai")


class _Window:
    """Tiny fixed-window limiter, keyed by caller. Defence in depth: the backend rate-limits first."""

    def __init__(self, limit: int):
        self.limit, self.hits = limit, defaultdict(list)

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        recent = [t for t in self.hits[key] if now - t < 60]
        self.hits[key] = recent
        if len(recent) >= self.limit:
            return False
        recent.append(now)
        return True


def create_app(
    settings: Settings | None = None,
    provider: LLMProvider | None = None,
    http_client: httpx.Client | None = None,
    reader_factory: Callable[[str | None, str | None], BackendReader] | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    configure_logging()
    stats = ProviderStats()
    http = http_client or httpx.Client(timeout=httpx.Timeout(settings.backend_timeout_seconds, connect=2.0))
    llm = provider or build_provider(settings, stats, http_client if http_client else None)
    app = FastAPI(
        title="PaySense AI Intelligence Service",
        version=__version__,
        description="Read-only investigation, analytics, anomaly detection and runbook retrieval. It cannot authorize, capture, refund or otherwise mutate payments.",
        docs_url=None if settings.is_production else "/docs",
        redoc_url=None,
        openapi_url=None if settings.is_production else "/openapi.json",
    )
    app.state.settings, app.state.provider, app.state.stats = settings, llm, stats
    limiter = _Window(settings.rate_limit_per_minute)
    token_bytes = settings.internal_token.get_secret_value().encode()

    def reader_for(authorization: str | None, corr: str | None) -> BackendReader:
        if reader_factory:
            return reader_factory(authorization, corr)
        return BackendClient(settings.backend_url, authorization, http, corr)

    # ---- middleware -------------------------------------------------------------------------------------------
    @app.middleware("http")
    async def guard(request: Request, call_next):
        cid = request.headers.get("x-correlation-id") or uuid.uuid4().hex
        correlation_id.set(cid)
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > settings.max_request_bytes:
            return JSONResponse(
                {"code": "PAYLOAD_TOO_LARGE", "message": "request body too large"}, status_code=413, headers={"X-Correlation-Id": cid}
            )
        response = await call_next(request)
        response.headers["X-Correlation-Id"] = cid
        return response

    def internal_only(x_internal_token: str | None = Header(default=None), authorization: str | None = Header(default=None)) -> str | None:
        if not x_internal_token or not hmac.compare_digest(x_internal_token.encode(), token_bytes):
            raise HTTPException(status_code=401, detail={"code": "UNAUTHENTICATED", "message": "missing or invalid internal token"})
        key = hashlib.sha256((authorization or "service").encode()).hexdigest()[:16]
        if not limiter.allow(key):
            raise HTTPException(status_code=429, detail={"code": "RATE_LIMITED", "message": "too many requests"})
        return authorization

    @app.exception_handler(BackendError)
    async def backend_error(_: Request, e: BackendError):
        status = {"not_found": 404, "denied": 403, "invalid": 400}.get(e.kind, 502)
        return JSONResponse({"code": f"BACKEND_{e.kind.upper()}", "message": str(e)}, status_code=status)

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, e: HTTPException):
        body = e.detail if isinstance(e.detail, dict) else {"code": "ERROR", "message": str(e.detail)}
        return JSONResponse(body, status_code=e.status_code)

    @app.exception_handler(Exception)
    async def unexpected(_: Request, e: Exception):
        log.error("unhandled error: %s", type(e).__name__)
        return JSONResponse({"code": "INTERNAL_ERROR", "message": "unexpected error"}, status_code=500)

    def tracked(task: str, fn: Callable[[], Any]) -> Any:
        started = time.monotonic()
        try:
            result = fn()
        except Exception:
            metrics.REQUESTS.labels(task, "error").inc()
            raise
        finally:
            metrics.LATENCY.labels(task).observe(time.monotonic() - started)
        status = getattr(result, "status", None) or (result.get("status") if isinstance(result, dict) else "ok")
        metrics.REQUESTS.labels(task, str(status)).inc()
        category = getattr(result, "errorCategory", None)
        if category:
            (metrics.PROVIDER_ERRORS if category.startswith("PROVIDER_") else metrics.REJECTED).labels(category).inc()
        usage = getattr(result, "usage", None)
        if usage and getattr(result, "provider", None):
            metrics.TOKENS.labels(result.provider, "prompt").inc(usage.promptTokens or 0)
            metrics.TOKENS.labels(result.provider, "completion").inc(usage.completionTokens or 0)
        return result

    # ---- routes -----------------------------------------------------------------------------------------------
    @app.get("/health")
    def health():
        return {"status": "ok", "version": __version__, "provider": llm.name, "model": llm.model, "providerConfigured": llm.configured()}

    @app.get("/metrics", include_in_schema=False)
    def prometheus():
        return Response(generate_latest(metrics.REGISTRY), media_type=CONTENT_TYPE_LATEST)

    @app.get("/v1/provider-status")
    def provider_status(_: str | None = Depends(internal_only)):
        snap = stats.snapshot()
        recent = snap["recentErrorCategories"]
        status = "UNCONFIGURED" if not llm.configured() else "DEGRADED" if recent and snap["successes"] == 0 else "OK"
        return {
            "status": status,
            "provider": llm.name,
            "model": llm.model,
            "configured": llm.configured(),
            **snap,
            "supportedOperations": sorted(OPERATIONS),
            "limits": {"maxOutputTokens": settings.max_output_tokens, "maxContextChars": settings.max_context_chars},
        }

    @app.post("/v1/investigations")
    def investigate(req: InvestigationRequest, request: Request, authorization: str | None = Depends(internal_only)):
        reader = reader_for(authorization, correlation_id.get())
        return tracked("investigation", lambda: Investigator(llm, settings).run(req, reader))

    @app.post("/v1/analytics-queries")
    def analytics(req: AnalyticsRequest, authorization: str | None = Depends(internal_only)):
        reader = reader_for(authorization, correlation_id.get())
        return tracked("analytics", lambda: AnalyticsAgent(llm, settings).run(req.question, reader))

    @app.post("/v1/incidents/{incident_id}/summary")
    def incident_summary(incident_id: uuid.UUID, authorization: str | None = Depends(internal_only)):
        reader = reader_for(authorization, correlation_id.get())
        return tracked("incident_summary", lambda: IncidentSummarizer(llm, settings).run(str(incident_id), reader))

    @app.post("/v1/runbooks/ask")
    def runbooks(req: RunbookAskRequest, authorization: str | None = Depends(internal_only)):
        reader = reader_for(authorization, correlation_id.get())
        return tracked("runbook", lambda: ask_runbooks(llm, settings, reader, req.question))

    @app.post("/v1/anomalies/detect")
    def detect(req: DetectRequest, authorization: str | None = Depends(internal_only)):
        reader = reader_for(authorization, correlation_id.get())
        sink = AnomalySink(settings.backend_url, settings.backend_service_token.get_secret_value(), http) if req.persist else None
        result = tracked(
            "anomaly_detection",
            lambda: AnomalyRunner().run(reader, sink, req.bucket, req.metrics, req.processors, req.evaluate_last, req.to, req.persist),
        )
        for a in result["anomalies"]:
            metrics.ANOMALIES.labels(a["metric"], a["severity"]).inc()
        return result

    return app


def app_factory() -> FastAPI:  # uvicorn --factory app.main:app_factory
    return create_app()
