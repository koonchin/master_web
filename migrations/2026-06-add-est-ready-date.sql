-- Issue 2: factory's estimated production-finish date (before shipping)
-- Adds a nullable DATE column to production_orders. Safe & reversible.
-- Rollback:  ALTER TABLE production_orders DROP COLUMN est_ready_date;
--
-- NOTE: run via `node migrations/run.js` which guards against re-adding the
-- column if it already exists (MySQL has no portable ADD COLUMN IF NOT EXISTS).
ALTER TABLE production_orders ADD COLUMN est_ready_date DATE NULL AFTER due_date;
