-- PaySense core schema, part 1: identities, payments, attempts, audit events.
-- All timestamps are timestamptz and are written/read as UTC.

CREATE TABLE users (
    id            uuid PRIMARY KEY,
    username      varchar(64)  NOT NULL UNIQUE,
    password_hash varchar(100) NOT NULL,
    role          varchar(16)  NOT NULL CHECK (role IN ('VIEWER', 'INVESTIGATOR', 'ADMIN')),
    enabled       boolean      NOT NULL DEFAULT true,
    created_at    timestamptz  NOT NULL
);

-- Generic guard used by append-only tables. TRUNCATE (test cleanup, retention by partition drop) is not blocked.
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION '% on % is not allowed: the table is append-only', TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TABLE payments (
    id                uuid PRIMARY KEY,
    merchant_id       varchar(64)    NOT NULL,
    amount            numeric(19, 4) NOT NULL CHECK (amount > 0),
    currency          char(3)        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    processor         varchar(32)    NOT NULL,
    description       varchar(255),
    status            varchar(16)    NOT NULL CHECK (status IN (
                          'CREATED', 'PROCESSING', 'AUTHORIZED', 'CAPTURING', 'CAPTURED',
                          'REFUNDING', 'REFUNDED', 'FAILED', 'CANCELLED', 'UNCERTAIN')),
    -- the operation that is in flight or whose outcome is unknown; NULL when the payment is at rest
    pending_operation varchar(16)    CHECK (pending_operation IN ('AUTHORIZE', 'CAPTURE', 'REFUND')),
    failure_code      varchar(64),
    failure_category  varchar(24),
    correlation_id    varchar(64)    NOT NULL,
    created_by        varchar(64)    NOT NULL,
    synthetic         boolean        NOT NULL DEFAULT false,
    version           bigint         NOT NULL DEFAULT 0,
    created_at        timestamptz    NOT NULL,
    updated_at        timestamptz    NOT NULL,
    authorized_at     timestamptz,
    captured_at       timestamptz,
    refunded_at       timestamptz,
    failed_at         timestamptz
);
CREATE INDEX idx_payments_created ON payments (created_at DESC);
CREATE INDEX idx_payments_status_created ON payments (status, created_at DESC);
CREATE INDEX idx_payments_merchant_created ON payments (merchant_id, created_at DESC);
CREATE INDEX idx_payments_processor_created ON payments (processor, created_at DESC);
CREATE INDEX idx_payments_correlation ON payments (correlation_id);
-- sweeper for operations stuck in flight (worker crash) only needs to see non-resting rows
CREATE INDEX idx_payments_in_flight ON payments (updated_at) WHERE status IN ('PROCESSING', 'CAPTURING', 'REFUNDING');
CREATE INDEX idx_payments_uncertain ON payments (updated_at) WHERE status = 'UNCERTAIN';

CREATE TABLE payment_attempts (
    id                   uuid PRIMARY KEY,
    payment_id           uuid         NOT NULL REFERENCES payments (id),
    operation            varchar(16)  NOT NULL CHECK (operation IN ('AUTHORIZE', 'CAPTURE', 'REFUND', 'LOOKUP')),
    attempt_number       int          NOT NULL,
    processor            varchar(32)  NOT NULL,
    -- sent to the processor as its idempotency key; stable across retries of the same logical attempt
    processor_request_id varchar(100) NOT NULL,
    status               varchar(16)  NOT NULL CHECK (status IN ('STARTED', 'APPROVED', 'DECLINED', 'INVALID', 'UNAVAILABLE', 'TIMEOUT', 'ERROR')),
    response_code        varchar(64),
    failure_category     varchar(24),
    response_time_ms     integer,
    sanitized_response   jsonb,
    correlation_id       varchar(64)  NOT NULL,
    started_at           timestamptz  NOT NULL,
    completed_at         timestamptz,
    UNIQUE (payment_id, operation, attempt_number)
);
CREATE INDEX idx_attempts_processor_started ON payment_attempts (processor, started_at DESC);
CREATE INDEX idx_attempts_started ON payment_attempts (started_at DESC);
CREATE INDEX idx_attempts_request_id ON payment_attempts (processor_request_id);

-- Append-only audit trail of everything that happened to a payment.
CREATE TABLE payment_events (
    id             uuid PRIMARY KEY,
    payment_id     uuid         NOT NULL REFERENCES payments (id),
    sequence       integer      NOT NULL,
    event_type     varchar(48)  NOT NULL,
    from_status    varchar(16),
    to_status      varchar(16),
    source         varchar(32)  NOT NULL,
    actor          varchar(64)  NOT NULL,
    correlation_id varchar(64)  NOT NULL,
    metadata       jsonb        NOT NULL DEFAULT '{}'::jsonb,
    occurred_at    timestamptz  NOT NULL,
    UNIQUE (payment_id, sequence)
);
CREATE INDEX idx_payment_events_occurred ON payment_events (occurred_at DESC);
CREATE TRIGGER payment_events_immutable BEFORE UPDATE OR DELETE ON payment_events
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE idempotency_records (
    id                  uuid PRIMARY KEY,
    principal           varchar(64)  NOT NULL,
    idempotency_key     varchar(255) NOT NULL,
    operation           varchar(64)  NOT NULL,
    request_fingerprint char(64)     NOT NULL,
    status              varchar(16)  NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
    response_status     integer,
    response_body       jsonb,
    resource_type       varchar(32),
    resource_id         uuid,
    created_at          timestamptz  NOT NULL,
    updated_at          timestamptz  NOT NULL,
    expires_at          timestamptz  NOT NULL,
    -- the invariant that makes concurrent duplicates safe: one record per (principal, key)
    UNIQUE (principal, idempotency_key)
);
CREATE INDEX idx_idempotency_expires ON idempotency_records (expires_at);
