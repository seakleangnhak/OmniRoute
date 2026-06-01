import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-v1-ws-route-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_API_KEY_SECRET = process.env.API_KEY_SECRET;
const ORIGINAL_REQUIRE_API_KEY = process.env.REQUIRE_API_KEY;
const ORIGINAL_OMNIROUTE_WS_AUTH = process.env.OMNIROUTE_WS_AUTH;
const ORIGINAL_WS_AUTH = process.env.WS_AUTH;

process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "test-v1-ws-route-secret";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const localDb = await import("../../src/lib/localDb.ts");
const wsRoute = await import("../../src/app/api/v1/ws/route.ts");

function resetStorage() {
  apiKeysDb.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  delete process.env.REQUIRE_API_KEY;
  delete process.env.OMNIROUTE_WS_AUTH;
  delete process.env.WS_AUTH;
  resetStorage();
  await localDb.updateSettings({
    wsAuth: true,
    requireLogin: true,
    password: "hashed-password",
  });
});

test.after(() => {
  apiKeysDb.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });

  if (ORIGINAL_DATA_DIR === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  }

  if (ORIGINAL_API_KEY_SECRET === undefined) {
    delete process.env.API_KEY_SECRET;
  } else {
    process.env.API_KEY_SECRET = ORIGINAL_API_KEY_SECRET;
  }

  if (ORIGINAL_REQUIRE_API_KEY === undefined) {
    delete process.env.REQUIRE_API_KEY;
  } else {
    process.env.REQUIRE_API_KEY = ORIGINAL_REQUIRE_API_KEY;
  }

  if (ORIGINAL_OMNIROUTE_WS_AUTH === undefined) {
    delete process.env.OMNIROUTE_WS_AUTH;
  } else {
    process.env.OMNIROUTE_WS_AUTH = ORIGINAL_OMNIROUTE_WS_AUTH;
  }

  if (ORIGINAL_WS_AUTH === undefined) {
    delete process.env.WS_AUTH;
  } else {
    process.env.WS_AUTH = ORIGINAL_WS_AUTH;
  }
});

test("v1 ws handshake requires credentials by default even when stored wsAuth is false", async () => {
  await localDb.updateSettings({ wsAuth: false });

  const response = await wsRoute.GET(new Request("http://localhost/api/v1/ws?handshake=1"));

  assert.equal(response.status, 401);
  const body = (await response.json()) as any;
  assert.equal(body.error.code, "ws_auth_required");
  assert.equal(body.wsAuth, true);
});

test("v1 ws handshake can be explicitly disabled with env override", async () => {
  await localDb.updateSettings({ wsAuth: false });
  process.env.OMNIROUTE_WS_AUTH = "false";

  const response = await wsRoute.GET(
    new Request("http://localhost/api/v1/ws?handshake=1", {
      headers: { origin: "http://localhost" },
    })
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as any;
  assert.equal(body.ok, true);
  assert.equal(body.wsAuth, false);
  assert.equal(body.authenticated, false);
  assert.equal(body.path, "/v1/ws");
});

test("v1 ws handshake rejects unknown bearer even with auth explicitly disabled", async () => {
  await localDb.updateSettings({ wsAuth: false });
  process.env.OMNIROUTE_WS_AUTH = "false";

  const response = await wsRoute.GET(
    new Request("http://localhost/api/v1/ws?handshake=1", {
      headers: { Authorization: "Bearer sk-server-b-key" },
    })
  );

  assert.equal(response.status, 403);
  const body = (await response.json()) as any;
  assert.equal(body.error.code, "ws_auth_invalid");
});

test("v1 ws handshake requires credentials when wsAuth is enabled", async () => {
  await localDb.updateSettings({ wsAuth: true });

  const response = await wsRoute.GET(new Request("http://localhost/api/v1/ws?handshake=1"));

  assert.equal(response.status, 401);
  const body = (await response.json()) as any;
  assert.equal(body.error.code, "ws_auth_required");
  assert.equal(body.wsAuth, true);
});

test("v1 ws handshake requires credentials when REQUIRE_API_KEY is enabled", async () => {
  await localDb.updateSettings({ wsAuth: false });
  process.env.OMNIROUTE_WS_AUTH = "false";
  process.env.REQUIRE_API_KEY = "true";

  const response = await wsRoute.GET(new Request("http://localhost/api/v1/ws?handshake=1"));

  assert.equal(response.status, 401);
  const body = (await response.json()) as any;
  assert.equal(body.error.code, "ws_auth_required");
  assert.equal(body.wsAuth, true);
});

test("v1 ws handshake requires credentials when env ws auth override is enabled", async () => {
  await localDb.updateSettings({ wsAuth: false });
  process.env.OMNIROUTE_WS_AUTH = "true";

  const response = await wsRoute.GET(new Request("http://localhost/api/v1/ws?handshake=1"));

  assert.equal(response.status, 401);
  const body = (await response.json()) as any;
  assert.equal(body.error.code, "ws_auth_required");
  assert.equal(body.wsAuth, true);
});

test("v1 ws handshake accepts valid API key query credentials when wsAuth is enabled", async () => {
  await localDb.updateSettings({ wsAuth: true });
  const key = await apiKeysDb.createApiKey("ws client", "machine-ws-route");

  const response = await wsRoute.GET(
    new Request(`http://localhost/api/v1/ws?handshake=1&api_key=${encodeURIComponent(key.key)}`)
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as any;
  assert.equal(body.ok, true);
  assert.equal(body.authenticated, true);
  assert.equal(body.authType, "api_key");
});

test("v1 ws HTTP GET reports upgrade required outside handshake mode", async () => {
  const response = await wsRoute.GET(new Request("http://localhost/api/v1/ws"));

  assert.equal(response.status, 426);
  assert.equal(response.headers.get("upgrade"), "websocket");
  const body = (await response.json()) as any;
  assert.equal(body.error.code, "upgrade_required");
});
