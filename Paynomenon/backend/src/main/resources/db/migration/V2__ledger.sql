-- PaySense core schema, part 2: immutable double-entry ledger (simulated environment only).

CREATE TABLE ledger_transactions (
    id                     uuid PRIMARY KEY,
    payment_id             uuid           NOT NULL REFERENCES payments (id),
    operation              varchar(16)    NOT NULL CHECK (operation IN ('CAPTURE', 'REFUND')),
    currency               char(3)        NOT NULL,
    amount                 numeric(19, 4) NOT NULL CHECK (amount > 0),
    -- a refund points at the capture it reverses; history is never edited, only reversed
    reverses_transaction_id uuid          REFERENCES ledger_transactions (id),
    correlation_id         varchar(64)    NOT NULL,
    created_at             timestamptz    NOT NULL,
    -- duplicate-posting guard: at most one posting per payment and operation
    UNIQUE (payment_id, operation),
    UNIQUE (id, currency),
    CHECK ((operation = 'REFUND') = (reverses_transaction_id IS NOT NULL))
);
CREATE INDEX idx_ledger_tx_created ON ledger_transactions (created_at DESC);

CREATE TABLE ledger_entries (
    id             uuid PRIMARY KEY,
    transaction_id uuid           NOT NULL,
    account        varchar(48)    NOT NULL CHECK (account IN ('PROCESSOR_RECEIVABLE', 'MERCHANT_PAYABLE')),
    direction      varchar(6)     NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
    amount         numeric(19, 4) NOT NULL CHECK (amount > 0),
    currency       char(3)        NOT NULL,
    created_at     timestamptz    NOT NULL,
    -- entries must carry the same currency as their transaction
    FOREIGN KEY (transaction_id, currency) REFERENCES ledger_transactions (id, currency),
    UNIQUE (transaction_id, account, direction)
);
CREATE INDEX idx_ledger_entries_tx ON ledger_entries (transaction_id);

CREATE TRIGGER ledger_transactions_immutable BEFORE UPDATE OR DELETE ON ledger_transactions
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Debits must equal credits for every transaction, checked at commit so entries can be inserted one by one.
CREATE FUNCTION check_ledger_balance() RETURNS trigger AS $$
DECLARE
    debits numeric;
    credits numeric;
    entry_count integer;
BEGIN
    SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0),
           COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0),
           COUNT(*)
      INTO debits, credits, entry_count
      FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
    IF debits <> credits OR entry_count < 2 THEN
        RAISE EXCEPTION 'ledger transaction % is unbalanced (debits %, credits %, entries %)',
            NEW.transaction_id, debits, credits, entry_count
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ledger_balance();

-- A transaction row without entries is also invalid.
CREATE FUNCTION check_ledger_tx_has_entries() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM ledger_entries WHERE transaction_id = NEW.id) THEN
        RAISE EXCEPTION 'ledger transaction % has no entries', NEW.id USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_tx_has_entries AFTER INSERT ON ledger_transactions
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ledger_tx_has_entries();
