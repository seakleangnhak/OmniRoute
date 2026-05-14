import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-oneproxy-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "oneproxy-route-secret";

const core = await import("../../src/lib/db/core.ts");
const oneproxyRoute = await import("../../src/app/api/settings/oneproxy/route.ts");

function resetStorage() {
  delete process.env.INITIAL_PASSWORD;
  delete process.env.ONEPROXY_ENABLED;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(() => {
  resetStorage();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("oneproxy sync accepts an empty POST body", async () => {
  process.env.ONEPROXY_ENABLED = "false";
  const response = await oneproxyRoute.POST(
    new Request("http://localhost/api/settings/oneproxy", { method: "POST" })
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, false);
  assert.equal(body.error, "1proxy integration disabled");
});

test("oneproxy sync still rejects malformed JSON bodies", async () => {
  const response = await oneproxyRoute.POST(
    new Request("http://localhost/api/settings/oneproxy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad",
    })
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.message, "Invalid JSON body");
});
