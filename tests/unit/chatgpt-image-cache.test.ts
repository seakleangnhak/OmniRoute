import test from "node:test";
import assert from "node:assert/strict";

const mod = await import("../../open-sse/services/chatgptImageCache.ts");
const {
  storeChatGptImage,
  getChatGptImage,
  __resetChatGptImageCacheForTesting,
  __getChatGptImageCacheBytesForTesting,
  __hasChatGptImageMemoryEntryForTesting,
} = mod;

// ── Constants ──

test("the hot cache keeps 200 entries", async () => {
  __resetChatGptImageCacheForTesting();
  const ids: string[] = [];
  for (let i = 0; i < 201; i++) {
    ids.push(storeChatGptImage(Buffer.from(`img-${i}`), "image/png", 60_000));
  }

  assert.equal(__hasChatGptImageMemoryEntryForTesting(ids[0]), false);
  assert.equal(__hasChatGptImageMemoryEntryForTesting(ids[1]), true);
  assert.equal(__hasChatGptImageMemoryEntryForTesting(ids[200]), true);
  assert.ok(getChatGptImage(ids[0]), "an entry evicted from memory should survive in SQLite");
  __resetChatGptImageCacheForTesting();
});

test("the configured byte cap evicts hot entries but keeps persistent entries", async () => {
  const originalMaxMb = process.env.OMNIROUTE_CGPT_WEB_IMAGE_CACHE_MAX_MB;
  process.env.OMNIROUTE_CGPT_WEB_IMAGE_CACHE_MAX_MB = "0.001";
  __resetChatGptImageCacheForTesting();

  try {
    const firstId = storeChatGptImage(Buffer.alloc(700, 0x41), "image/png", 60_000);
    const secondId = storeChatGptImage(Buffer.alloc(700, 0x42), "image/png", 60_000);

    assert.equal(__hasChatGptImageMemoryEntryForTesting(firstId), false);
    assert.equal(__hasChatGptImageMemoryEntryForTesting(secondId), true);
    assert.equal(__getChatGptImageCacheBytesForTesting(), 700);
    assert.ok(getChatGptImage(firstId), "byte-cap eviction should not delete the SQLite record");
  } finally {
    if (originalMaxMb === undefined) {
      delete process.env.OMNIROUTE_CGPT_WEB_IMAGE_CACHE_MAX_MB;
    } else {
      process.env.OMNIROUTE_CGPT_WEB_IMAGE_CACHE_MAX_MB = originalMaxMb;
    }
    __resetChatGptImageCacheForTesting();
  }
});

// ── Store & Retrieve (hit) ──

test("store then retrieve returns the cached entry (cache hit)", async () => {
  __resetChatGptImageCacheForTesting();
  const payload = Buffer.from("hello-image-data");
  const id = storeChatGptImage(payload, "image/jpeg", 60_000);
  const entry = getChatGptImage(id);
  assert.ok(entry, "entry should exist");
  assert.deepEqual(entry!.bytes, payload);
  assert.equal(entry!.mime, "image/jpeg");
  assert.ok(typeof entry!.bytesSha256 === "string" && entry!.bytesSha256.length === 64);
  __resetChatGptImageCacheForTesting();
});

// ── TTL expiry ──

test("entry expires after TTL (mocked Date.now)", async () => {
  __resetChatGptImageCacheForTesting();
  const originalNow = Date.now;
  let fakeNow = 1_000_000;
  Date.now = () => fakeNow;

  const id = storeChatGptImage(Buffer.from("ttl-test"), "image/png", 5000);
  assert.ok(getChatGptImage(id), "should hit before TTL");

  // Advance past TTL
  fakeNow += 5001;
  assert.equal(getChatGptImage(id), null, "should miss after TTL expires");

  Date.now = originalNow;
  __resetChatGptImageCacheForTesting();
});
