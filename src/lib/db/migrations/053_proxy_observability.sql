-- 053_proxy_observability.sql
-- Track request-time 1proxy traffic metrics and immutable proxy events.

ALTER TABLE proxy_registry ADD COLUMN request_count INTEGER DEFAULT 0;
ALTER TABLE proxy_registry ADD COLUMN runtime_success_count INTEGER DEFAULT 0;
ALTER TABLE proxy_registry ADD COLUMN runtime_failure_count INTEGER DEFAULT 0;
ALTER TABLE proxy_registry ADD COLUMN avg_latency_ms INTEGER;
ALTER TABLE proxy_registry ADD COLUMN last_success_at TEXT;
ALTER TABLE proxy_registry ADD COLUMN last_failure_at TEXT;

CREATE TABLE IF NOT EXISTS oneproxy_events (
  id TEXT PRIMARY KEY,
  proxy_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  host TEXT,
  port INTEGER,
  latency_ms INTEGER,
  error_type TEXT,
  error_message TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (proxy_id) REFERENCES proxy_registry(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_oneproxy_events_proxy_created
  ON oneproxy_events(proxy_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oneproxy_events_type_created
  ON oneproxy_events(event_type, created_at DESC);
