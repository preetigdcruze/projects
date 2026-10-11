from prometheus_client import CollectorRegistry, Counter, Histogram

REGISTRY = CollectorRegistry()
REQUESTS = Counter("paysense_ai_requests_total", "AI requests by task and outcome", ["task", "status"], registry=REGISTRY)
LATENCY = Histogram(
    "paysense_ai_request_seconds",
    "End-to-end AI request latency",
    ["task"],
    registry=REGISTRY,
    buckets=(0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60),
)
PROVIDER_ERRORS = Counter("paysense_ai_provider_errors_total", "Provider errors by category", ["category"], registry=REGISTRY)
TOKENS = Counter("paysense_ai_tokens_total", "Tokens reported by the provider", ["provider", "type"], registry=REGISTRY)
REJECTED = Counter("paysense_ai_output_rejected_total", "Model outputs rejected by validation", ["category"], registry=REGISTRY)
ANOMALIES = Counter(
    "paysense_ai_anomalies_detected_total", "Anomalies found by the statistical detector", ["metric", "severity"], registry=REGISTRY
)
