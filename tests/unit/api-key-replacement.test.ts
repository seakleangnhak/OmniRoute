import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-key-replacement-"));
const ENV_NAMES = [
  "DATA_DIR",
  "API_KEY_SECRET",
  "OMNIROUTE_API_KEY",
  "ROUTER_API_KEY",
  "REQUIRE_API_KEY",
] as const;
const originalEnv = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "key-replacement-test-secret";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const { clientApiPolicy } = await import("../../src/server/authz/policies/clientApi.ts");
const { enforceClientApiAuth } = await import("../../src/app/api/v1/_helpers/clientApiAuth.ts");

function requestFor(key: string): Request {
  return new Request("http://localhost/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
  });
}

async function authenticate(key: string) {
  return clientApiPolicy.evaluate({
    request: requestFor(key),
    classification: {
      routeClass: "CLIENT_API",
      reason: "client_api_v1",
      normalizedPath: "/api/v1/chat/completions",
    },
    requestId: "key-replacement-test",
  });
}

test.beforeEach(() => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  delete process.env.OMNIROUTE_API_KEY;
  delete process.env.ROUTER_API_KEY;
  process.env.REQUIRE_API_KEY = "true";
});

test.after(() => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const removalCases = [
  { name: "revoked", remove: apiKeysDb.revokeApiKey, directStatus: 403 },
  { name: "deleted", remove: apiKeysDb.deleteApiKey, directStatus: 401 },
] as const;

for (const { name, remove, directStatus } of removalCases) {
  test(`${name} key A stays rejected after creating key B with the same name and machine`, async () => {
    const keyA = await apiKeysDb.createApiKey("Replacement", "replacement-machine");
    assert.equal((await authenticate(keyA.key)).allow, true);
    assert.equal(await enforceClientApiAuth(requestFor(keyA.key)), null);
    assert.ok(await apiKeysDb.getApiKeyMetadata(keyA.key));

    assert.equal(await remove(keyA.id), true);
    // Revocation/deletion takes effect before another key is created.
    assert.equal(await apiKeysDb.validateApiKey(keyA.key), false);
    assert.equal((await enforceClientApiAuth(requestFor(keyA.key)))?.status, directStatus);

    const keyB = await apiKeysDb.createApiKey("Replacement", "replacement-machine");
    assert.notEqual(keyB.id, keyA.id);
    assert.notEqual(keyB.key, keyA.key);
    assert.equal(await apiKeysDb.validateApiKey(keyB.key), true);
    assert.equal((await authenticate(keyB.key)).allow, true);
    assert.equal(await enforceClientApiAuth(requestFor(keyB.key)), null);

    const oldKeyResult = await authenticate(keyA.key);
    assert.equal(oldKeyResult.allow, false);
    if (!oldKeyResult.allow) {
      assert.equal(oldKeyResult.status, 401);
      assert.equal(oldKeyResult.code, "AUTH_002");
    }
    assert.equal((await enforceClientApiAuth(requestFor(keyA.key)))?.status, directStatus);
  });
}

test("creating key B alone does not revoke key A", async () => {
  const keyA = await apiKeysDb.createApiKey("Replacement", "replacement-machine");
  const keyB = await apiKeysDb.createApiKey("Replacement", "replacement-machine");

  assert.notEqual(keyA.key, keyB.key);
  assert.equal((await authenticate(keyA.key)).allow, true);
  assert.equal((await authenticate(keyB.key)).allow, true);
});

for (const envName of ["OMNIROUTE_API_KEY", "ROUTER_API_KEY"] as const) {
  for (const { name, remove } of removalCases) {
    test(`${envName} keeps ${name} key A authorized until the environment key is rotated`, async () => {
      const keyA = await apiKeysDb.createApiKey("Environment exception", "env-key-machine");
      process.env[envName] = keyA.key;
      assert.equal((await authenticate(keyA.key)).allow, true);

      assert.equal(await remove(keyA.id), true);
      const keyB = await apiKeysDb.createApiKey("Environment exception", "env-key-machine");

      assert.equal(await apiKeysDb.validateApiKey(keyA.key), true);
      assert.equal((await authenticate(keyA.key)).allow, true);
      assert.equal(await enforceClientApiAuth(requestFor(keyA.key)), null);
      assert.equal((await authenticate(keyB.key)).allow, true);

      process.env[envName] = keyB.key;
      assert.equal(await apiKeysDb.validateApiKey(keyA.key), false);
      const oldKeyResult = await authenticate(keyA.key);
      assert.equal(oldKeyResult.allow, false);
      if (!oldKeyResult.allow) assert.equal(oldKeyResult.status, 401);
      assert.equal((await authenticate(keyB.key)).allow, true);
    });
  }
}
