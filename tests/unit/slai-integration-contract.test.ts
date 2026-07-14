import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-slai-contract-"));
const ORIGINAL_ENV = {
  ALLOW_API_KEY_REVEAL: process.env.ALLOW_API_KEY_REVEAL,
  API_KEY_SECRET: process.env.API_KEY_SECRET,
  DATA_DIR: process.env.DATA_DIR,
  INITIAL_PASSWORD: process.env.INITIAL_PASSWORD,
  JWT_SECRET: process.env.JWT_SECRET,
  OMNIROUTE_MANAGEMENT_TOKEN: process.env.OMNIROUTE_MANAGEMENT_TOKEN,
  REQUIRE_API_KEY: process.env.REQUIRE_API_KEY,
};

process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "slai-contract-api-secret";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const localDb = await import("../../src/lib/localDb.ts");
const listRoute = await import("../../src/app/api/keys/route.ts");
const keyRoute = await import("../../src/app/api/keys/[id]/route.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");
const callLogsRoute = await import("../../src/app/api/usage/call-logs/route.ts");
const chatRoute = await import("../../src/app/api/v1/chat/completions/route.ts");

const MANAGEMENT_TOKEN = "slai-management-token-for-tests";
const MACHINE_ID = "slai-machine-0001";

async function resetStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

  process.env.ALLOW_API_KEY_REVEAL = "false";
  process.env.API_KEY_SECRET = "slai-contract-api-secret";
  process.env.DATA_DIR = TEST_DATA_DIR;
  process.env.INITIAL_PASSWORD = "slai-bootstrap-password";
  process.env.JWT_SECRET = "slai-jwt-secret";
  process.env.OMNIROUTE_MANAGEMENT_TOKEN = MANAGEMENT_TOKEN;
  process.env.REQUIRE_API_KEY = "true";

  await localDb.updateSettings({ requireLogin: true, password: "" });
}

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function managementRequest(url: string, options: { method?: string; body?: unknown } = {}) {
  const headers = new Headers({ authorization: `Bearer ${MANAGEMENT_TOKEN}` });
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return new Request(url, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

function rawApiKeyOccurrences(payload: unknown, rawKey: string) {
  return JSON.stringify(payload).split(rawKey).length - 1;
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  restoreEnv();
});

test("SLAI management token protects API key endpoints and creates safe metadata", async () => {
  const unauthenticated = await listRoute.GET(new Request("http://localhost/api/keys"));
  assert.equal(unauthenticated.status, 401);

  const createResponse = await listRoute.POST(
    managementRequest("http://localhost/api/keys", {
      method: "POST",
      body: { name: "SLAI User Key" },
    })
  );
  const created = (await createResponse.json()) as any;

  assert.equal(createResponse.status, 201);
  assert.match(created.key, /^sk-/);
  assert.equal(created.name, "SLAI User Key");
  assert.equal(created.status, "active");
  assert.equal(created.isActive, true);
  assert.ok(created.id);
  assert.ok(created.prefix || created.maskedKey);
  assert.ok(created.createdAt);

  const listResponse = await listRoute.GET(managementRequest("http://localhost/api/keys"));
  const listBody = (await listResponse.json()) as any;
  const listed = listBody.keys.find((entry) => entry.id === created.id);

  assert.equal(listResponse.status, 200);
  assert.ok(listed);
  assert.equal(rawApiKeyOccurrences(listBody, created.key), 0);
  assert.match(listed.key, /\*{4}/);
  assert.equal(listed.status, "active");
  assert.equal(JSON.stringify(listBody).includes(MANAGEMENT_TOKEN), false);
});

test("SLAI key list and detail never reveal raw API keys when reveal is disabled", async () => {
  const created = await apiKeysDb.createApiKey("SLAI Managed", MACHINE_ID);

  const listResponse = await listRoute.GET(managementRequest("http://localhost/api/keys"));
  const detailResponse = await keyRoute.GET(
    managementRequest(`http://localhost/api/keys/${created.id}`),
    { params: Promise.resolve({ id: created.id }) }
  );

  const listBody = (await listResponse.json()) as any;
  const detailBody = (await detailResponse.json()) as any;

  assert.equal(listResponse.status, 200);
  assert.equal(detailResponse.status, 200);
  assert.equal(rawApiKeyOccurrences(listBody, created.key), 0);
  assert.equal(rawApiKeyOccurrences(detailBody, created.key), 0);
  assert.match(detailBody.key, /\*{4}/);
  assert.equal(detailBody.status, "active");
});

test("disabled SLAI-managed API key cannot call /v1/chat/completions", async () => {
  const created = await apiKeysDb.createApiKey("Disabled SLAI Key", MACHINE_ID);
  const patchResponse = await keyRoute.PATCH(
    managementRequest(`http://localhost/api/keys/${created.id}`, {
      method: "PATCH",
      body: { isActive: false },
    }),
    { params: Promise.resolve({ id: created.id }) }
  );
  const patchBody = (await patchResponse.json()) as any;

  assert.equal(patchResponse.status, 200);
  assert.equal(patchBody.isActive, false);
  assert.equal(patchBody.status, "disabled");
  assert.equal(rawApiKeyOccurrences(patchBody, created.key), 0);

  const response = await chatRoute.POST(
    new Request("http://localhost/api/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${created.key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      }),
    })
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 403);
  assert.match(body.error.message, /disabled/i);
});

test("call-log sync includes stable apiKeyId, event id, token fields, and costUsd", async () => {
  await localDb.updatePricing({
    "slai-provider": {
      "slai-model": {
        input: 1000,
        cached: 100,
        output: 2000,
        reasoning: 3000,
        cache_creation: 1500,
      },
    },
  });

  const created = await apiKeysDb.createApiKey("SLAI Billing Key", MACHINE_ID);
  const oldTimestamp = new Date(Date.now() - 60_000).toISOString();
  const recentTimestamp = new Date().toISOString();

  await callLogs.saveCallLog({
    id: "slai-old-event",
    timestamp: oldTimestamp,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    provider: "slai-provider",
    model: "slai-model",
    apiKeyId: created.id,
    apiKeyName: created.name,
    tokens: { input: 1, output: 1 },
  });

  await callLogs.saveCallLog({
    id: "slai-recent-event",
    timestamp: recentTimestamp,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    provider: "slai-provider",
    model: "slai-model",
    apiKeyId: created.id,
    apiKeyName: created.name,
    tokens: { input: 100, output: 50, cacheRead: 20, cacheCreation: 10, reasoning: 5 },
  });

  const response = await callLogsRoute.GET(
    managementRequest(
      `http://localhost/api/usage/call-logs?limit=100&since=${encodeURIComponent(
        new Date(Date.now() - 30_000).toISOString()
      )}`
    )
  );
  const logs = (await response.json()) as any[];
  const recent = logs.find((entry) => entry.id === "slai-recent-event");

  assert.equal(response.status, 200);
  assert.equal(
    logs.some((entry) => entry.id === "slai-old-event"),
    false
  );
  assert.ok(recent);
  assert.equal(recent.apiKeyId, created.id);
  assert.equal(recent.method, "POST");
  assert.equal(recent.path, "/v1/chat/completions");
  assert.equal(recent.status, 200);
  assert.equal(recent.provider, "slai-provider");
  assert.equal(recent.model, "slai-model");
  assert.deepEqual(recent.tokens, {
    in: 100,
    out: 50,
    cacheRead: 20,
    cacheWrite: 10,
    reasoning: 5,
    compressed: null,
    images: null,
  });
  assert.ok(Math.abs(recent.costUsd - 0.202) < 1e-12);
  assert.equal(JSON.stringify(logs).includes(created.key), false);
  assert.equal(JSON.stringify(logs).includes(MANAGEMENT_TOKEN), false);
});
