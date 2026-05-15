-- 052_proxy_quarantine_metadata.sql
-- Track runtime proxy quarantine, recovery, and recent success/failure signals.

ALTER TABLE proxy_registry ADD COLUMN quarantined_until TEXT;
ALTER TABLE proxy_registry ADD COLUMN last_error TEXT;
ALTER TABLE proxy_registry ADD COLUMN last_error_type TEXT;
ALTER TABLE proxy_registry ADD COLUMN last_error_at TEXT;
ALTER TABLE proxy_registry ADD COLUMN success_count INTEGER DEFAULT 0;
ALTER TABLE proxy_registry ADD COLUMN failure_streak INTEGER DEFAULT 0;
ALTER TABLE proxy_registry ADD COLUMN ewma_latency_ms INTEGER;

CREATE INDEX IF NOT EXISTS idx_proxy_registry_quarantined_until
  ON proxy_registry(quarantined_until);
CREATE INDEX IF NOT EXISTS idx_proxy_registry_failure_streak
  ON proxy_registry(failure_streak);
