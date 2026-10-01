-- PaySense core schema, part 3: transactional outbox, consumer dedup, dead letters, simulated processor state.

CREATE TABLE outbox_events (
    id              uuid PRIMARY KEY,           -- doubles as the event id carried to consumers
    aggregate_type  varchar(32)  NOT NULL,
    aggregate_id    uuid         NOT NULL,
    event_type      varchar(64)  NOT NULL,
    schema_version  integer      NOT NULL DEFAULT 1,
    payload         jsonb        NOT NULL,
    correlation_id  varchar(64)  NOT NULL,
    status          varchar(16)  NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PUBLISHED', 'FAILED')),
    attempts        integer      NOT NULL DEFAULT 0,
    next_attempt_at timestamptz  NOT NULL,
    last_error      varchar(500),
    created_at      timestamptz  NOT NULL,
    published_at    timestamptz
);
-- the publisher only scans pending rows
CREATE INDEX idx_outbox_pending ON outbox_events (created_at) WHERE status = 'PENDING';
CREATE INDEX idx_outbox_aggregate ON outbox_events (aggregate_id, created_at);
CREATE INDEX idx_outbox_published ON outbox_events (published_at) WHERE status = 'PUBLISHED';

-- Durable consumer-side deduplication; written in the same transaction as the handler's side effects.
CREATE TABLE processed_events (
    consumer     varchar(64) NOT NULL,
    event_id     uuid        NOT NULL,
    processed_at timestamptz NOT NULL,
    PRIMARY KEY (consumer, event_id)
);
CREATE INDEX idx_processed_events_at ON processed_events (processed_at);

CREATE TABLE dead_letter_events (
    id              uuid PRIMARY KEY,
    consumer        varchar(64)  NOT NULL,
    event_id        uuid,
    event_type      varchar(64),
    topic           varchar(128),
    kafka_partition integer,
    kafka_offset    bigint,
    payload         text         NOT NULL,       -- raw message; may be unparseable
    error_class     varchar(200) NOT NULL,
    error_message   varchar(1000),
    attempts        integer      NOT NULL,
    status          varchar(16)  NOT NULL DEFAULT 'DEAD' CHECK (status IN ('DEAD', 'REPLAYED')),
    replay_count    integer      NOT NULL DEFAULT 0,
    replayed_by     varchar(64),
    replay_reason   varchar(500),
    replayed_at     timestamptz,
    failed_at       timestamptz  NOT NULL
);
CREATE INDEX idx_dead_letter_status ON dead_letter_events (status, failed_at DESC);
-- the same message can be dead-lettered only once per consumer
CREATE UNIQUE INDEX uq_dead_letter_event ON dead_letter_events (consumer, event_id) WHERE event_id IS NOT NULL;

-- State kept "on the processor side" of the simulation. Also the source for synthetic settlement reports.
CREATE TABLE mock_processor_transactions (
    id                   uuid PRIMARY KEY,
    processor            varchar(32)    NOT NULL,
    request_id           varchar(100)   NOT NULL,
    operation            varchar(16)    NOT NULL,
    payment_reference    varchar(64)    NOT NULL,
    amount               numeric(19, 4) NOT NULL,
    currency             char(3)        NOT NULL,
    status               varchar(16)    NOT NULL CHECK (status IN ('APPROVED', 'DECLINED')),
    response_code        varchar(64)    NOT NULL,
    executed_at          timestamptz    NOT NULL,
    -- processor-level idempotency: the same request id always yields the same stored result
    UNIQUE (processor, request_id)
);
CREATE INDEX idx_mock_proc_tx_executed ON mock_processor_transactions (processor, executed_at);

CREATE TABLE processor_callbacks (
    id          uuid PRIMARY KEY,
    processor   varchar(32)  NOT NULL,
    callback_id varchar(100) NOT NULL,
    payment_id  uuid         REFERENCES payments (id),
    event_type  varchar(48)  NOT NULL,
    applied     boolean      NOT NULL,
    received_at timestamptz  NOT NULL,
    UNIQUE (processor, callback_id)
);
