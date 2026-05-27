-- Migration 074: Add image count to call_logs
-- Tracks generated/edited image units separately from text tokens.
ALTER TABLE call_logs ADD COLUMN images_count INTEGER DEFAULT NULL;
