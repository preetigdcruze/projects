-- PaySense core schema, part 4: reconciliation.

CREATE TABLE reconciliation_runs (
    id                uuid PRIMARY KEY,
    processor         varchar(32)  NOT NULL,
    window_from       timestamptz  NOT NULL,
    window_to         timestamptz  NOT NULL,
    scenario          varchar(32)  NOT NULL,
    report_id         uuid         NOT NULL,
    status            varchar(16)  NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
    internal_count    integer      NOT NULL DEFAULT 0,
    report_count      integer      NOT NULL DEFAULT 0,
    matched_count     integer      NOT NULL DEFAULT 0,
    discrepancy_count integer      NOT NULL DEFAULT 0,
    started_by        varchar(64)  NOT NULL,
    correlation_id    varchar(64)  NOT NULL,
    error             varchar(500),
    started_at        timestamptz  NOT NULL,
    completed_at      timestamptz
);
CREATE INDEX idx_recon_runs_started ON reconciliation_runs (started_at DESC);

CREATE TABLE processor_settlement_records (
    id                uuid PRIMARY KEY,
    report_id         uuid           NOT NULL,
    line_number       integer        NOT NULL,
    processor         varchar(32)    NOT NULL,
    processor_txn_id  varchar(100)   NOT NULL,
    payment_reference varchar(64)    NOT NULL,
    operation         varchar(16)    NOT NULL CHECK (operation IN ('CAPTURE', 'REFUND')),
    amount            numeric(19, 4) NOT NULL,
    currency          char(3)        NOT NULL,
    settled_at        timestamptz    NOT NULL,
    -- deliberately no uniqueness on the processor transaction id: duplicate lines are a detectable defect
    UNIQUE (report_id, line_number)
);
CREATE INDEX idx_settlement_reference ON processor_settlement_records (payment_reference);

CREATE TABLE reconciliation_discrepancies (
    id                uuid PRIMARY KEY,
    run_id            uuid         NOT NULL REFERENCES reconciliation_runs (id),
    type              varchar(32)  NOT NULL CHECK (type IN (
                          'MISSING_FROM_REPORT', 'MISSING_INTERNALLY', 'AMOUNT_MISMATCH',
                          'CURRENCY_MISMATCH', 'DUPLICATE_SETTLEMENT', 'UNEXPECTED_STATE')),
    payment_reference varchar(64)  NOT NULL,
    operation         varchar(16)  NOT NULL,
    internal_amount   numeric(19, 4),
    internal_currency char(3),
    report_amount     numeric(19, 4),
    report_currency   char(3),
    internal_status   varchar(16),
    details           jsonb        NOT NULL DEFAULT '{}'::jsonb,
    status            varchar(16)  NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACKNOWLEDGED')),
    explanation       varchar(2000),
    acknowledged_by   varchar(64),
    acknowledged_at   timestamptz,
    created_at        timestamptz  NOT NULL,
    -- re-detection within one run can never create a second row for the same finding
    UNIQUE (run_id, type, payment_reference, operation)
);
CREATE INDEX idx_discrepancies_status ON reconciliation_discrepancies (status, created_at DESC);
CREATE INDEX idx_discrepancies_reference ON reconciliation_discrepancies (payment_reference);
