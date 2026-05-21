/**
 * Runtime + persistent cache for ChatGPT-generated images so we can serve
 * them via regular HTTP URLs instead of inlining megabytes of base64 into
 * SSE deltas.
 *
 * Why: chatgpt.com's image_asset_pointer resolves to a session-signed
 * estuary/content URL that 403s for any anonymous client. We download the
 * bytes server-side with the user's session, serve them from OmniRoute, and
 * persist the cache metadata + bytes to SQLite so cache_id based edits keep
 * working across container/app restarts until the configured TTL expires.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  cleanupExpiredChatGptImageCache,
  clearChatGptImageCacheRecords,
  deleteChatGptImageCacheRecord,
  enforceChatGptImageCacheByteLimit,
  findChatGptImageCacheRecordBySha256,
  getChatGptImageCacheRecord,
  upsertChatGptImageCacheRecord,
} from "../../src/lib/db/chatgptImageCache.ts";

export interface CachedImage {
  bytes: Buffer;
  mime: string;
  expiresAt: number;
  createdAt: number;
  context?: ChatGptImageConversationContext;
  /** sha256(bytes) — used by /v1/images/edits to correlate an uploaded
   *  image (Open WebUI re-uploads the bytes via multipart) back to the
   *  conversation context we cached when the image was first generated. */
  bytesSha256: string;
}

const cache = new Map<string, CachedImage>();
let cacheBytes = 0;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 200;
// Per-entry images cap at 8 MB (enforced upstream in the executor) so 256 MB
// keeps hot images in memory while SQLite remains the source of truth across
// restarts. Tune via OMNIROUTE_CGPT_WEB_IMAGE_CACHE_MAX_MB.
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_PERSISTENT_MAX_BYTES = 1024 * 1024 * 1024;

function configuredMaxBytes(): number {
  const raw = Number(process.env.OMNIROUTE_CGPT_WEB_IMAGE_CACHE_MAX_MB);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MAX_BYTES;
  return Math.floor(raw * 1024 * 1024);
}

function configuredPersistentMaxBytes(): number {
  const raw = Number(process.env.OMNIROUTE_CGPT_WEB_IMAGE_CACHE_DB_MAX_MB);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PERSISTENT_MAX_BYTES;
  return Math.floor(raw * 1024 * 1024);
}

function configuredDefaultTtlMs(): number {
  const raw = Number(process.env.OMNIROUTE_CGPT_WEB_IMAGE_CACHE_TTL_HOURS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TTL_MS;
  return Math.floor(raw * 60 * 60 * 1000);
}

export interface ChatGptImageConversationContext {
  conversationId: string;
  parentMessageId: string;
}

function deleteMemoryEntry(id: string): void {
  const entry = cache.get(id);
  if (!entry) return;
  cacheBytes -= entry.bytes.length;
  cache.delete(id);
}

function evictExpired(now = Date.now()): void {
  for (const [id, entry] of cache) {
    if (now >= entry.expiresAt) {
      deleteMemoryEntry(id);
      deletePersistentEntry(id);
    }
  }
  cleanupPersistentExpired(now);
}

function evictUntilWithinLimits(maxBytes: number, incomingBytes: number): void {
  // Drop oldest until both the entry-count and total-byte caps are satisfied.
  // Map iteration is insertion-ordered so the first key is the oldest entry.
  while ((cache.size >= MAX_ENTRIES || cacheBytes + incomingBytes > maxBytes) && cache.size > 0) {
    const firstKey = cache.keys().next().value;
    if (!firstKey) break;
    deleteMemoryEntry(firstKey);
  }
}

function rememberMemoryEntry(id: string, entry: CachedImage): void {
  deleteMemoryEntry(id);
  evictExpired();
  evictUntilWithinLimits(configuredMaxBytes(), entry.bytes.length);
  cache.set(id, entry);
  cacheBytes += entry.bytes.length;
}

function persistEntry(id: string, entry: CachedImage): void {
  try {
    upsertChatGptImageCacheRecord({
      id,
      bytes: entry.bytes,
      mime: entry.mime,
      bytesSha256: entry.bytesSha256,
      bytesLength: entry.bytes.length,
      conversationId: entry.context?.conversationId ?? null,
      parentMessageId: entry.context?.parentMessageId ?? null,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
    });
    enforceChatGptImageCacheByteLimit(configuredPersistentMaxBytes());
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[ChatGPT Web Image Cache] Failed to persist image cache entry: " + message);
  }
}

function deletePersistentEntry(id: string): void {
  try {
    deleteChatGptImageCacheRecord(id);
  } catch {
    // Best-effort cleanup; the next DB cleanup pass removes expired rows.
  }
}

function cleanupPersistentExpired(now = Date.now()): void {
  try {
    cleanupExpiredChatGptImageCache(now);
  } catch {
    // Best-effort cleanup only.
  }
}

function fromPersistentRecord(
  record: NonNullable<ReturnType<typeof getChatGptImageCacheRecord>>
): CachedImage {
  const context =
    record.conversationId && record.parentMessageId
      ? { conversationId: record.conversationId, parentMessageId: record.parentMessageId }
      : undefined;
  return {
    bytes: record.bytes,
    mime: record.mime,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    context,
    bytesSha256: record.bytesSha256,
  };
}

function loadPersistentEntry(id: string): { id: string; entry: CachedImage } | null {
  try {
    const record = getChatGptImageCacheRecord(id);
    if (!record) return null;
    const entry = fromPersistentRecord(record);
    rememberMemoryEntry(id, entry);
    return { id, entry };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      "[ChatGPT Web Image Cache] Failed to load persistent image " + id + ": " + message
    );
    return null;
  }
}

function findPersistentEntryBySha256(hash: string): { id: string; entry: CachedImage } | null {
  try {
    const record = findChatGptImageCacheRecordBySha256(hash);
    if (!record) return null;
    const entry = fromPersistentRecord(record);
    rememberMemoryEntry(record.id, entry);
    return { id: record.id, entry };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[ChatGPT Web Image Cache] Failed to query persistent image hash: " + message);
    return null;
  }
}

export function storeChatGptImage(
  bytes: Buffer,
  mime: string,
  ttlMs = configuredDefaultTtlMs(),
  context?: ChatGptImageConversationContext
): string {
  evictExpired();
  const id = randomUUID().replace(/-/g, "");
  const bytesSha256 = createHash("sha256").update(bytes).digest("hex");
  const now = Date.now();
  const entry: CachedImage = {
    bytes,
    mime,
    expiresAt: now + ttlMs,
    createdAt: now,
    context,
    bytesSha256,
  };
  rememberMemoryEntry(id, entry);
  persistEntry(id, entry);
  return id;
}

export function getChatGptImage(id: string): CachedImage | null {
  evictExpired();
  const entry = cache.get(id);
  if (entry) {
    if (Date.now() >= entry.expiresAt) {
      deleteMemoryEntry(id);
      deletePersistentEntry(id);
      return null;
    }
    return entry;
  }
  return loadPersistentEntry(id)?.entry ?? null;
}

export function getChatGptImageConversationContext(
  id: string
): ChatGptImageConversationContext | null {
  return getChatGptImage(id)?.context ?? null;
}

/**
 * Look up a cached entry by sha256(bytes). Used by /v1/images/edits to
 * correlate Open WebUI's re-uploaded image back to the conversation
 * context we cached at generation time, so the executor can continue the
 * saved chatgpt.com conversation node and actually edit the image instead
 * of generating an unrelated one from scratch.
 */
export function findChatGptImageBySha256(hash: string): { id: string; entry: CachedImage } | null {
  evictExpired();
  const target = hash.toLowerCase();
  for (const [id, entry] of cache.entries()) {
    if (entry.bytesSha256 === target) {
      if (Date.now() < entry.expiresAt) return { id, entry };
      deleteMemoryEntry(id);
      deletePersistentEntry(id);
    }
  }
  return findPersistentEntryBySha256(target);
}

/** Test-only: clear the cache between tests. */
export function __resetChatGptImageCacheForTesting(options?: {
  preservePersistent?: boolean;
}): void {
  cache.clear();
  cacheBytes = 0;
  if (options?.preservePersistent) return;
  try {
    clearChatGptImageCacheRecords();
  } catch {
    // Some tests import this module before DB setup; memory reset is enough there.
  }
}

/** Test-only: peek at current resident-byte total. */
export function __getChatGptImageCacheBytesForTesting(): number {
  return cacheBytes;
}

/** Test-only: check hot memory residency without loading from SQLite. */
export function __hasChatGptImageMemoryEntryForTesting(id: string): boolean {
  return cache.has(id);
}
