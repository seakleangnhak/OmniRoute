-- Add normalized USD cost to call log summaries for external billing sync.
ALTER TABLE call_logs ADD COLUMN cost_usd REAL DEFAULT NULL;
