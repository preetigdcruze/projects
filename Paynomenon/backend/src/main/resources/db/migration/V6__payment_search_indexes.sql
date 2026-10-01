-- Free-text search on the payments page uses lower(...) LIKE '%term%', which a B-tree index cannot serve and which
-- therefore scans the whole table. Trigram GIN indexes make those predicates index-assisted.
-- The expressions must match what PaymentQueryService generates (lower(coalesce(description, '')) and lower(merchant_id)).
-- pg_trgm is a trusted extension (PostgreSQL 13+), so the database owner may create it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_payments_description_trgm ON payments USING gin (lower(coalesce(description, '')) gin_trgm_ops);
CREATE INDEX idx_payments_merchant_trgm ON payments USING gin (lower(merchant_id) gin_trgm_ops);
