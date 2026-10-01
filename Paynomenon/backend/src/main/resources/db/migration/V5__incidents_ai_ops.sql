-- PaySense core schema, part 5: incidents, anomalies, AI interaction metadata, operational logs, runbooks.

CREATE TABLE incidents (
    id            uuid PRIMARY KEY,
    title         varchar(200) NOT NULL,
    status        varchar(16)  NOT NULL CHECK (status IN ('OPEN', 'RESOLVED')),
    severity      varchar(8)   NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH')),
    source        varchar(16)  NOT NULL CHECK (source IN ('MANUAL', 'ANOMALY', 'DISCREPANCY', 'SEED')),
    components    jsonb        NOT NULL DEFAULT '[]'::jsonb,
    description   varchar(2000),
    started_at    timestamptz  NOT NULL,
    resolved_at   timestamptz,
    ai_report     jsonb,
    ai_report_at  timestamptz,
    created_by    varchar(64)  NOT NULL,
    created_at    timestamptz  NOT NULL,
    updated_at    timestamptz  NOT NULL
);
CREATE INDEX idx_incidents_status_started ON incidents (status, started_at DESC);

CREATE TABLE incident_links (
    incident_id uuid        NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
    link_type   varchar(16) NOT NULL CHECK (link_type IN ('PAYMENT', 'ANOMALY', 'DISCREPANCY', 'DEAD_LETTER')),
    ref_id      uuid        NOT NULL,
    linked_at   timestamptz NOT NULL,
    PRIMARY KEY (incident_id, link_type, ref_id)
);
CREATE INDEX idx_incident_links_ref ON incident_links (link_type, ref_id);

CREATE TABLE anomaly_events (
    id           uuid PRIMARY KEY,
    metric       varchar(48)    NOT NULL,
    dimension    varchar(64)    NOT NULL DEFAULT 'ALL',   -- e.g. a processor name
    window_start timestamptz    NOT NULL,
    window_end   timestamptz    NOT NULL,
    observed     numeric(18, 6) NOT NULL,
    baseline     numeric(18, 6) NOT NULL,
    threshold    numeric(18, 6) NOT NULL,
    score        numeric(18, 6) NOT NULL,
    direction    varchar(8)     NOT NULL CHECK (direction IN ('HIGH', 'LOW')),
    severity     varchar(8)     NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH')),
    method       varchar(16)    NOT NULL,
    sample_size  integer        NOT NULL,
    details      jsonb          NOT NULL DEFAULT '{}'::jsonb,
    detected_at  timestamptz    NOT NULL,
    -- re-running detection over the same window is idempotent
    UNIQUE (metric, dimension, window_start, window_end)
);
CREATE INDEX idx_anomalies_detected ON anomaly_events (detected_at DESC);

CREATE TABLE ai_investigations (
    id                uuid PRIMARY KEY,
    requested_by      varchar(64)  NOT NULL,
    subject_type      varchar(16)  NOT NULL CHECK (subject_type IN ('PAYMENT', 'INCIDENT', 'ANOMALY')),
    subject_id        uuid         NOT NULL,
    question          varchar(1000) NOT NULL,
    status            varchar(16)  NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'DEGRADED', 'UNAVAILABLE', 'FAILED')),
    result            jsonb,
    provider          varchar(32),
    model             varchar(64),
    prompt_tokens     integer,
    completion_tokens integer,
    latency_ms        integer,
    error_category    varchar(32),
    created_at        timestamptz  NOT NULL,
    completed_at      timestamptz,
    -- retention: investigations are deleted after this instant by the retention job
    expires_at        timestamptz  NOT NULL
);
CREATE INDEX idx_ai_investigations_subject ON ai_investigations (subject_type, subject_id, created_at DESC);
CREATE INDEX idx_ai_investigations_expires ON ai_investigations (expires_at);

-- Curated operational log lines (processor errors, retries, breaker transitions, consumer failures).
-- These are untrusted text from the AI layer's point of view.
CREATE TABLE operational_logs (
    id             bigserial PRIMARY KEY,
    occurred_at    timestamptz  NOT NULL,
    level          varchar(8)   NOT NULL,
    component      varchar(32)  NOT NULL,
    message        varchar(1000) NOT NULL,
    correlation_id varchar(64),
    payment_id     uuid,
    attributes     jsonb        NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_oplogs_payment ON operational_logs (payment_id, occurred_at) WHERE payment_id IS NOT NULL;
CREATE INDEX idx_oplogs_correlation ON operational_logs (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX idx_oplogs_occurred ON operational_logs (occurred_at DESC);

CREATE TABLE runbook_documents (
    id          uuid PRIMARY KEY,
    doc_key     varchar(64)  NOT NULL,
    version     integer      NOT NULL,
    doc_type    varchar(16)  NOT NULL CHECK (doc_type IN ('RUNBOOK', 'INCIDENT_REPORT')),
    title       varchar(200) NOT NULL,
    tags        text[]       NOT NULL DEFAULT '{}',
    body        text         NOT NULL,
    created_at  timestamptz  NOT NULL,
    search      tsvector,
    UNIQUE (doc_key, version)
);
CREATE INDEX idx_runbooks_search ON runbook_documents USING gin (search);

-- array_to_string is not immutable, so the search vector is maintained by a trigger rather than a generated column
CREATE FUNCTION runbook_search_update() RETURNS trigger AS $$
BEGIN
    NEW.search := setweight(to_tsvector('english', NEW.title), 'A') ||
                  setweight(to_tsvector('english', coalesce(array_to_string(NEW.tags, ' '), '')), 'B') ||
                  setweight(to_tsvector('english', NEW.body), 'C');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER runbook_search_trg BEFORE INSERT OR UPDATE ON runbook_documents
    FOR EACH ROW EXECUTE FUNCTION runbook_search_update();
