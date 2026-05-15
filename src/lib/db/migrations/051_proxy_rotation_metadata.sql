-- 051_proxy_rotation_metadata.sql
-- Track per-proxy rotation usage and failures for request-time rotating proxy selection.

ALTER TABLE proxy_registry ADD COLUMN last_used_at TEXT;
ALTER TABLE proxy_registry ADD COLUMN failure_count INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_proxy_registry_last_used ON proxy_registry(last_used_at);
CREATE INDEX IF NOT EXISTS idx_proxy_registry_failures ON proxy_registry(failure_count);
