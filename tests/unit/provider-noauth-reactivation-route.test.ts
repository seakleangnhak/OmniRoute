import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  makeManagementSessionRequest,
  TEST_MANAGEMENT_JWT_SECRET,
} from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-noauth-reactivation-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.JWT_SECRET = TEST_MANAGEMENT_JWT_SECRET;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const providerByIdRoute = await import("../../src/app/api/providers/[id]/route.ts");

function resetDb() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(() => {
  resetDb();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("PUT reactivates managed mimocode connection when fingerprints change", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "mimocode",
    authType: "apikey",
    name: "MiMoCode Managed",
    isActive: false,
    testStatus: "banned",
    lastError: "Illegal access",
    lastErrorType: "banned",
    lastErrorSource: "provider",
    errorCode: 403,
    rateLimitedUntil: new Date(Date.now() + 60_000).toISOString(),
    backoffLevel: 4,
    providerSpecificData: {
      fingerprints: ["old-fp"],
      accountProxies: [{ fingerprint: "old-fp", proxy: null }],
    },
  });

  const response = await providerByIdRoute.PUT(
    await makeManagementSessionRequest(`http://localhost/api/providers/${connection.id}`, {
      method: "PUT",
      body: {
        providerSpecificData: {
          fingerprints: ["old-fp", "new-fp"],
          accountProxies: [{ fingerprint: "old-fp", proxy: null }],
        },
      },
    }),
    { params: Promise.resolve({ id: connection.id as string }) }
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as { connection: Record<string, unknown> };
  assert.equal(payload.connection.isActive, true);
  assert.equal(payload.connection.testStatus, "active");
  assert.equal(payload.connection.lastError, undefined);
  assert.equal(payload.connection.errorCode, undefined);
  assert.equal(payload.connection.rateLimitedUntil, undefined);

  const stored = await providersDb.getProviderConnectionById(connection.id as string);
  assert.equal(stored?.isActive, true);
  assert.equal(stored?.testStatus, "active");
  assert.equal(stored?.lastError ?? null, null);
  assert.equal(stored?.lastErrorType ?? null, null);
  assert.equal(stored?.lastErrorSource ?? null, null);
  assert.equal(stored?.errorCode ?? null, null);
  assert.equal(stored?.rateLimitedUntil ?? null, null);
  assert.equal(stored?.backoffLevel, 0);
  assert.deepEqual((stored?.providerSpecificData as Record<string, unknown>)?.fingerprints, [
    "old-fp",
    "new-fp",
  ]);
});
