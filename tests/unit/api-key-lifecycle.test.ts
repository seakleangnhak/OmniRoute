import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-apikey-lifecycle-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-secret";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");

const ORIGINAL_OMNIROUTE_API_KEY = process.env.OMNIROUTE_API_KEY;
const ORIGINAL_ROUTER_API_KEY = process.env.ROUTER_API_KEY;
const ORIGINAL_OMNIROUTE_MANAGEMENT_TOKEN = process.env.OMNIROUTE_MANAGEMENT_TOKEN;
const ORIGINAL_SLAI_API_BASE_URL = process.env.SLAI_API_BASE_URL;
const ORIGINAL_SLAI_API_URL = process.env.SLAI_API_URL;

function reset() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  delete process.env.OMNIROUTE_API_KEY;
  delete process.env.ROUTER_API_KEY;
  delete process.env.OMNIROUTE_MANAGEMENT_TOKEN;
  delete process.env.SLAI_API_BASE_URL;
  delete process.env.SLAI_API_URL;
}

test.beforeEach(() => {
  reset();
});

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  if (ORIGINAL_OMNIROUTE_API_KEY === undefined) delete process.env.OMNIROUTE_API_KEY;
  else process.env.OMNIROUTE_API_KEY = ORIGINAL_OMNIROUTE_API_KEY;
  if (ORIGINAL_ROUTER_API_KEY === undefined) delete process.env.ROUTER_API_KEY;
  else process.env.ROUTER_API_KEY = ORIGINAL_ROUTER_API_KEY;
  if (ORIGINAL_OMNIROUTE_MANAGEMENT_TOKEN === undefined)
    delete process.env.OMNIROUTE_MANAGEMENT_TOKEN;
  else process.env.OMNIROUTE_MANAGEMENT_TOKEN = ORIGINAL_OMNIROUTE_MANAGEMENT_TOKEN;
  if (ORIGINAL_SLAI_API_BASE_URL === undefined) delete process.env.SLAI_API_BASE_URL;
  else process.env.SLAI_API_BASE_URL = ORIGINAL_SLAI_API_BASE_URL;
  if (ORIGINAL_SLAI_API_URL === undefined) delete process.env.SLAI_API_URL;
  else process.env.SLAI_API_URL = ORIGINAL_SLAI_API_URL;
});

async function makeKey(name = "lifecycle-test", machineId = "machine-lifecycle") {
  const created = await apiKeysDb.createApiKey(name, machineId);
  assert.ok(created?.key, "createApiKey returned a key");
  return created;
}

test("validateApiKey returns true for a fresh active key", async () => {
  const created = await makeKey();
  assert.equal(await apiKeysDb.validateApiKey(created.key), true);
});

test("validateApiKey rejects revoked keys after revokeApiKey", async () => {
  const created = await makeKey();
  assert.equal(await apiKeysDb.validateApiKey(created.key), true);

  const ok = await apiKeysDb.revokeApiKey(created.id);
  assert.equal(ok, true);

  assert.equal(await apiKeysDb.validateApiKey(created.key), false);
});

test("validateApiKey rejects keys whose expires_at has passed", async () => {
  const created = await makeKey();
  const past = new Date(Date.now() - 60_000).toISOString();
  const ok = await apiKeysDb.setApiKeyExpiry(created.id, past);
  assert.equal(ok, true);
  assert.equal(await apiKeysDb.validateApiKey(created.key), false);
});

test("validateApiKey accepts keys with future expires_at", async () => {
  const created = await makeKey();
  const future = new Date(Date.now() + 60 * 60_000).toISOString();
  const ok = await apiKeysDb.setApiKeyExpiry(created.id, future);
  assert.equal(ok, true);
  assert.equal(await apiKeysDb.validateApiKey(created.key), true);
});

test("validateApiKey rejects deactivated keys (is_active=false)", async () => {
  const created = await makeKey();
  const ok = await apiKeysDb.updateApiKeyPermissions(created.id, { isActive: false });
  assert.equal(ok, true);
  assert.equal(await apiKeysDb.validateApiKey(created.key), false);
});

test("revokeApiKey is idempotent and returns false for missing id", async () => {
  const created = await makeKey();
  assert.equal(await apiKeysDb.revokeApiKey(created.id), true);
  assert.equal(await apiKeysDb.revokeApiKey(created.id), true);
  assert.equal(await apiKeysDb.revokeApiKey("00000000-0000-0000-0000-000000000000"), false);
});

test("getApiKeyMetadata exposes lifecycle and policy fields", async () => {
  const created = await makeKey();
  await apiKeysDb.setApiKeyExpiry(created.id, new Date(Date.now() + 86_400_000).toISOString());

  const md = await apiKeysDb.getApiKeyMetadata(created.key);
  assert.ok(md);
  assert.equal(md!.isActive, true);
  assert.equal(md!.revokedAt, null);
  assert.ok(md!.expiresAt && Date.parse(md!.expiresAt) > Date.now());
  assert.deepEqual(md!.ipAllowlist, []);
  assert.deepEqual(md!.scopes, []);
});

test("validateApiKey accepts configured environment API keys", async () => {
  process.env.OMNIROUTE_API_KEY = "sk-env-lifecycle-test";
  assert.equal(await apiKeysDb.validateApiKey("sk-env-lifecycle-test"), true);
});

test("validateApiKey updates last_used_at for persisted keys", async () => {
  const created = await makeKey();

  assert.equal(await apiKeysDb.validateApiKey(created.key), true);

  const db = core.getDbInstance() as {
    prepare(sql: string): { get(id: string): { last_used_at: string | null } | undefined };
  };
  const row = db.prepare("SELECT last_used_at FROM api_keys WHERE id = ?").get(created.id);

  assert.ok(row?.last_used_at, "last_used_at should be set on successful validation");
  assert.ok(Date.parse(row.last_used_at) > 0, "last_used_at should be an ISO timestamp");
});

test("validateApiKey imports a missing SLAI-managed key after SLAI confirms it", async () => {
  const rawKey = "sk_slai_legacy_key_abcdefghijklmnopqrstuvwxyz";
  process.env.OMNIROUTE_MANAGEMENT_TOKEN = "slai-management-token";
  const server = await new Promise<import("node:http").Server>((resolve) => {
    import("node:http").then(({ createServer }) => {
      const instance = createServer((request, response) => {
        assert.equal(request.url, "/v1/internal/omniroute/api-keys/provision");
        assert.equal(request.headers.authorization, "Bearer slai-management-token");
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          assert.equal(JSON.parse(body).raw_api_key, rawKey);
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              api_key: {
                slai_api_key_id: "slai-key-1",
                omniroute_key_id: "slai-slai-key-1",
                name: "Legacy SLAI Key",
                user_id: "user-1",
                user_email: "user@example.com",
                no_log: true,
              },
            })
          );
        });
      });
      instance.listen(0, () => resolve(instance));
    });
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    process.env.SLAI_API_BASE_URL = `http://127.0.0.1:${address.port}`;

    assert.equal(await apiKeysDb.validateApiKey(rawKey), true);

    const metadata = await apiKeysDb.getApiKeyMetadata(rawKey);
    assert.ok(metadata);
    assert.equal(metadata.id, "slai-slai-key-1");
    assert.equal(metadata.name, "Legacy SLAI Key");
    assert.equal(metadata.machineId, "user-1");
    assert.equal(metadata.noLog, true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test("validateApiKey keeps unknown SLAI-looking keys invalid when SLAI rejects them", async () => {
  process.env.OMNIROUTE_MANAGEMENT_TOKEN = "slai-management-token";
  const server = await new Promise<import("node:http").Server>((resolve) => {
    import("node:http").then(({ createServer }) => {
      const instance = createServer((_request, response) => {
        response.statusCode = 404;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ error: "api_key_not_found" }));
      });
      instance.listen(0, () => resolve(instance));
    });
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    process.env.SLAI_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    assert.equal(await apiKeysDb.validateApiKey("sk_slai_unknown"), false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
