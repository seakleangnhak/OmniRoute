import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-opencode-managed-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { getProviderCredentials } = await import("../../src/sse/services/auth.ts");

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

test("opencode-zen reuses the dashboard-managed opencode connection instead of synthetic noauth", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "opencode",
    authType: "apikey",
    name: "OpenCode Managed",
    isActive: true,
    providerSpecificData: {
      fingerprints: ["fp-1", "fp-2"],
      accountProxies: [{ fingerprint: "fp-1", proxy: null }],
    },
  });

  const creds = await getProviderCredentials("opencode-zen", null, null, "minimax-m2.5-free");

  assert.ok(creds, "opencode-zen should resolve to the saved dashboard-managed OpenCode row");
  assert.equal(
    (creds as { connectionId?: string }).connectionId,
    connection?.id,
    "selector must not bypass the managed OpenCode row with synthetic noauth"
  );
  assert.deepEqual(
    (creds as { providerSpecificData?: Record<string, unknown> }).providerSpecificData,
    {
      fingerprints: ["fp-1", "fp-2"],
      accountProxies: [{ fingerprint: "fp-1", proxy: null }],
    }
  );
});

test("opencode-zen does not fall back to synthetic noauth when an inactive managed opencode row exists", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "opencode",
    authType: "apikey",
    name: "OpenCode Managed",
    isActive: true,
    providerSpecificData: {
      fingerprints: ["fp-inactive"],
    },
  });

  await providersDb.updateProviderConnection(connection?.id as string, {
    isActive: false,
    rateLimitedUntil: null,
    testStatus: "unknown",
  });

  const creds = await getProviderCredentials("opencode-zen", null, null, "minimax-m2.5-free");

  assert.notEqual(
    (creds as { connectionId?: string } | null)?.connectionId,
    "noauth",
    "a managed OpenCode dashboard row must suppress synthetic noauth fallback on the zen route"
  );
  assert.equal(
    creds,
    null,
    "without any active managed OpenCode row, selector should stop instead of bypassing it"
  );
});
