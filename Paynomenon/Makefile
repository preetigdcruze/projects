# PaySense developer commands.   `make help` lists them.
SHELL := /bin/bash
BACKEND_URL ?= http://localhost:8080
AI_VENV := ai-service/.venv
ADMIN_PASSWORD ?= admin-demo-pass

.DEFAULT_GOAL := help
.PHONY: help setup up down logs migrate seed reset-data demo test test-unit test-integration test-ai test-frontend e2e lint format eval load-test \
        dev-backend dev-ai dev-frontend local-db clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# ---- setup & stack --------------------------------------------------------------------------------------------------
setup: ## Create .env with random secrets, install Python and frontend dependencies
	@test -f .env || { cp .env.example .env; \
	  for k in POSTGRES_PASSWORD PAYSENSE_JWT_SECRET PAYSENSE_SERVICE_TOKEN PAYSENSE_CALLBACK_SECRET PAYSENSE_METRICS_PASSWORD AI_INTERNAL_TOKEN GRAFANA_ADMIN_PASSWORD; do \
	    sed -i "s|^$$k=.*|$$k=$$(head -c 36 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)|" .env; done; \
	  echo "Created .env with generated secrets (demo account passwords are the documented defaults)."; }
	python3 -m venv $(AI_VENV) && $(AI_VENV)/bin/pip install -q -r ai-service/requirements-dev.txt
	cd frontend && npm ci

up: ## Start the full stack with Docker Compose (add PROFILES=observability for Prometheus+Grafana)
	docker compose $(if $(PROFILES),--profile $(PROFILES)) up -d --build
	@echo "UI: http://localhost:$${FRONTEND_PORT:-3000}   API docs: $(BACKEND_URL)/swagger-ui.html"

down: ## Stop the stack (keeps data; add VOLUMES=1 to delete it)
	docker compose --profile observability down $(if $(VOLUMES),-v)

logs: ## Tail container logs
	docker compose logs -f --tail=100

migrate: ## Apply database migrations and exit (uses the environment/.env database settings)
	cd backend && ./gradlew -q bootRun --args='--paysense.migrate-only=true --spring.main.web-application-type=none'

seed: ## Load reproducible synthetic data into a running backend (seed 42); REPLACE=1 wipes first
	@TOKEN=$$(curl -sf -X POST $(BACKEND_URL)/api/v1/auth/login -H 'content-type: application/json' -d '{"username":"admin","password":"$(ADMIN_PASSWORD)"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])') && \
	curl -sf -X POST $(BACKEND_URL)/api/v1/admin/seed -H "Authorization: Bearer $$TOKEN" -H 'content-type: application/json' -d '{"seed":42,"replace":$(if $(REPLACE),true,false)}' | python3 -m json.tool | head -30
	@echo "Next: make demo, or run anomaly detection from System Health / POST /api/v1/ai/anomalies/detect"

demo: ## Walk through three complete workflows against a running stack
	python3 scripts/demo.py --base-url $(BACKEND_URL) --admin-password $(ADMIN_PASSWORD)

# ---- tests -----------------------------------------------------------------------------------------------------------------
test: test-unit test-ai test-frontend ## Primary suite: backend unit + AI service + frontend unit tests (no external services needed)

test-unit: ## Backend unit tests
	cd backend && ./gradlew test

test-integration: ## Backend integration tests (needs PostgreSQL: Docker via Testcontainers, or TEST_DATABASE_URL)
	cd backend && ./gradlew integrationTest

test-ai: ## AI service tests (pytest) and deterministic evaluation
	cd ai-service && . .venv/bin/activate && python -m pytest && python -m eval.run --robustness

test-frontend: ## Frontend type-check, lint and unit tests
	cd frontend && npm run typecheck && npm run lint && npm test

e2e: ## Playwright end-to-end tests against a running stack (E2E_BASE_URL, default dev server on :5173)
	cd frontend && npx playwright test

lint: ## Formatting and static checks for all components
	cd backend && ./gradlew ktlintCheck
	cd ai-service && . .venv/bin/activate && ruff check . && ruff format --check .
	cd frontend && npm run lint && npm run format:check

format: ## Auto-format all components
	cd backend && ./gradlew ktlintFormat
	cd ai-service && . .venv/bin/activate && ruff check --fix . && ruff format .
	cd frontend && npm run format

eval: ## AI evaluation (deterministic mode, includes robustness scenarios)
	cd ai-service && . .venv/bin/activate && python -m eval.run --robustness

load-test: ## k6 throughput test (see docs/performance.md for the other scenarios)
	k6 run -e SCENARIO=throughput -e RATE=40 -e DURATION=60s -e BASE_URL=$(BACKEND_URL) loadtest/payments.js

# ---- running without Docker ----------------------------------------------------------------------------------------------
local-db: ## Create the local PostgreSQL role/databases used by the no-Docker workflow (needs a local server and psql)
	psql -h localhost -U postgres -c "CREATE ROLE paysense LOGIN PASSWORD 'paysense'" -c "CREATE DATABASE paysense OWNER paysense" -c "CREATE DATABASE paysense_test OWNER paysense"

dev-backend: ## Backend on :8080 against local PostgreSQL, in-process event transport
	cd backend && ./gradlew bootRun

dev-ai: ## AI service on :8090 (mock provider unless AI_PROVIDER is set)
	cd ai-service && . .venv/bin/activate && uvicorn app.main:app_factory --factory --port 8090 --reload

dev-frontend: ## Vite dev server on :5173 (proxies /api to the backend)
	cd frontend && npm run dev

clean: ## Remove build outputs
	rm -rf backend/build frontend/dist ai-service/.pytest_cache loadtest/results/*.json
