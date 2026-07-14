import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-oneproxy-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "oneproxy-route-secret";

const core = await import("../../src/lib/db/core.ts");
const freeProxySyncRoute = await import("../../src/app/api/settings/free-proxies/sync/route.ts");

function resetStorage() {
  delete process.env.INITIAL_PASSWORD;
  delete process.env.ONEPROXY_ENABLED;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(() => {
  resetStorage();
  freeProxySyncRoute._setProvidersForTests([]);
});

test.after(() => {
  freeProxySyncRoute._setProvidersForTests(null);
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("free proxy sync accepts an empty POST body", async () => {
  const response = await freeProxySyncRoute.POST(
    new Request("http://localhost/api/settings/free-proxies/sync", { method: "POST" })
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(body.results, {});
});

test("free proxy sync still rejects malformed JSON bodies", async () => {
  const response = await freeProxySyncRoute.POST(
    new Request("http://localhost/api/settings/free-proxies/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad",
    })
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.message, "Invalid JSON");
});
