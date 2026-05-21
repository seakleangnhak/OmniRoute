-- Migration 059: Persist ChatGPT Web generated image cache
CREATE TABLE IF NOT EXISTS chatgpt_image_cache (
  id TEXT PRIMARY KEY,
  bytes BLOB NOT NULL,
  mime TEXT NOT NULL,
  bytes_sha256 TEXT NOT NULL,
  bytes_length INTEGER NOT NULL,
  conversation_id TEXT,
  parent_message_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chatgpt_image_cache_sha256
  ON chatgpt_image_cache(bytes_sha256);

CREATE INDEX IF NOT EXISTS idx_chatgpt_image_cache_expires
  ON chatgpt_image_cache(expires_at);

CREATE INDEX IF NOT EXISTS idx_chatgpt_image_cache_created
  ON chatgpt_image_cache(created_at);
