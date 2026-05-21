import { getDbInstance, rowToCamel } from "./core";

export interface ChatGptImageCacheRecord {
  id: string;
  bytes: Buffer;
  mime: string;
  bytesSha256: string;
  bytesLength: number;
  conversationId?: string | null;
  parentMessageId?: string | null;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
}

const CHATGPT_IMAGE_CACHE_COLUMNS =
  "id, bytes, mime, bytes_sha256, bytes_length, conversation_id, parent_message_id, created_at, expires_at, updated_at";

function toRecord(row: unknown): ChatGptImageCacheRecord | null {
  const mapped = rowToCamel(row) as Record<string, unknown> | null;
  if (!mapped) return null;
  const bytesValue = mapped.bytes;
  const bytes = Buffer.isBuffer(bytesValue)
    ? bytesValue
    : bytesValue instanceof Uint8Array
      ? Buffer.from(bytesValue)
      : Buffer.alloc(0);

  return {
    id: String(mapped.id || ""),
    bytes,
    mime: String(mapped.mime || "application/octet-stream"),
    bytesSha256: String(mapped.bytesSha256 || ""),
    bytesLength: Number(mapped.bytesLength || bytes.length),
    conversationId: typeof mapped.conversationId === "string" ? mapped.conversationId : null,
    parentMessageId: typeof mapped.parentMessageId === "string" ? mapped.parentMessageId : null,
    createdAt: Number(mapped.createdAt || 0),
    expiresAt: Number(mapped.expiresAt || 0),
    updatedAt: Number(mapped.updatedAt || 0),
  };
}

export function upsertChatGptImageCacheRecord(
  record: Omit<ChatGptImageCacheRecord, "updatedAt"> & { updatedAt?: number }
): void {
  const db = getDbInstance();
  const updatedAt = record.updatedAt ?? Date.now();
  db.prepare(
    "INSERT INTO chatgpt_image_cache (" +
      "id, bytes, mime, bytes_sha256, bytes_length, conversation_id, parent_message_id, " +
      "created_at, expires_at, updated_at" +
      ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET " +
      "bytes = excluded.bytes, " +
      "mime = excluded.mime, " +
      "bytes_sha256 = excluded.bytes_sha256, " +
      "bytes_length = excluded.bytes_length, " +
      "conversation_id = excluded.conversation_id, " +
      "parent_message_id = excluded.parent_message_id, " +
      "created_at = excluded.created_at, " +
      "expires_at = excluded.expires_at, " +
      "updated_at = excluded.updated_at"
  ).run(
    record.id,
    record.bytes,
    record.mime,
    record.bytesSha256,
    record.bytesLength,
    record.conversationId ?? null,
    record.parentMessageId ?? null,
    record.createdAt,
    record.expiresAt,
    updatedAt
  );
}

export function getChatGptImageCacheRecord(
  id: string,
  now = Date.now()
): ChatGptImageCacheRecord | null {
  cleanupExpiredChatGptImageCache(now);
  const row = dbGet(
    "SELECT " +
      CHATGPT_IMAGE_CACHE_COLUMNS +
      " FROM chatgpt_image_cache WHERE id = ? AND expires_at > ?",
    id,
    now
  );
  return toRecord(row);
}

export function findChatGptImageCacheRecordBySha256(
  hash: string,
  now = Date.now()
): ChatGptImageCacheRecord | null {
  cleanupExpiredChatGptImageCache(now);
  const row = dbGet(
    "SELECT " +
      CHATGPT_IMAGE_CACHE_COLUMNS +
      " FROM chatgpt_image_cache WHERE bytes_sha256 = ? AND expires_at > ? " +
      "ORDER BY created_at DESC LIMIT 1",
    hash.toLowerCase(),
    now
  );
  return toRecord(row);
}

export function deleteChatGptImageCacheRecord(id: string): boolean {
  const result = getDbInstance().prepare("DELETE FROM chatgpt_image_cache WHERE id = ?").run(id);
  return result.changes > 0;
}

export function cleanupExpiredChatGptImageCache(now = Date.now()): number {
  const result = getDbInstance()
    .prepare("DELETE FROM chatgpt_image_cache WHERE expires_at <= ?")
    .run(now);
  return result.changes;
}

export function enforceChatGptImageCacheByteLimit(maxBytes: number, now = Date.now()): number {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return 0;
  cleanupExpiredChatGptImageCache(now);
  const db = getDbInstance();
  const totalRow = db
    .prepare("SELECT COALESCE(SUM(bytes_length), 0) AS total FROM chatgpt_image_cache")
    .get() as { total?: number } | undefined;
  let overflow = Number(totalRow?.total || 0) - maxBytes;
  if (overflow <= 0) return 0;

  const rows = db
    .prepare("SELECT id, bytes_length FROM chatgpt_image_cache ORDER BY created_at ASC, id ASC")
    .all() as Array<{ id?: string; bytes_length?: number }>;
  const deleteStmt = db.prepare("DELETE FROM chatgpt_image_cache WHERE id = ?");
  let deleted = 0;
  for (const row of rows) {
    if (overflow <= 0) break;
    const id = String(row.id || "");
    if (!id) continue;
    const bytesLength = Number(row.bytes_length || 0);
    const result = deleteStmt.run(id);
    if (result.changes > 0) {
      deleted += result.changes;
      overflow -= bytesLength;
    }
  }
  return deleted;
}

export function clearChatGptImageCacheRecords(): void {
  getDbInstance().prepare("DELETE FROM chatgpt_image_cache").run();
}

export function getChatGptImageCacheStats(now = Date.now()): {
  count: number;
  bytes: number;
  expired: number;
} {
  const row = getDbInstance()
    .prepare(
      "SELECT COUNT(*) AS count, " +
        "COALESCE(SUM(bytes_length), 0) AS bytes, " +
        "COALESCE(SUM(CASE WHEN expires_at <= ? THEN 1 ELSE 0 END), 0) AS expired " +
        "FROM chatgpt_image_cache"
    )
    .get(now) as { count?: number; bytes?: number; expired?: number } | undefined;
  return {
    count: Number(row?.count || 0),
    bytes: Number(row?.bytes || 0),
    expired: Number(row?.expired || 0),
  };
}

function dbGet(sql: string, ...params: unknown[]): unknown {
  return getDbInstance()
    .prepare(sql)
    .get(...params);
}
