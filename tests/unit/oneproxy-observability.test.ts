import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-oneproxy-observability-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const oneproxyDb = await import("../../src/lib/db/oneproxy.ts");
const observability = await import("../../src/lib/oneproxyObservability.ts");

async function resetStorage() {
  observability.stopOneproxyObservabilityScheduler();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.afterEach(() => {
  observability.stopOneproxyObservabilityScheduler();
});

test.after(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("oneproxy observability settings normalize and clamp unsafe values", () => {
  const normalized = observability.normalizeOneproxyObservabilitySettings({
    retentionDays: 0,
    cleanupIntervalMinutes: 1,
    cleanupOnStartup: false,
    alertsEnabled: false,
    minActiveProxies: -1,
    minSuccessRate: 200,
    maxQuarantineRate: -10,
  });

  assert.deepEqual(normalized, {
    retentionDays: 1,
    cleanupIntervalMinutes: 5,
    cleanupOnStartup: false,
    alertsEnabled: false,
    minActiveProxies: 0,
    minSuccessRate: 100,
    maxQuarantineRate: 0,
  });
});

test("oneproxy observability scheduler exposes active status and can stop cleanly", () => {
  observability.startOneproxyObservabilityScheduler({
    retentionDays: 14,
    cleanupIntervalMinutes: 5,
    cleanupOnStartup: false,
    alertsEnabled: true,
    minActiveProxies: 5,
    minSuccessRate: 75,
    maxQuarantineRate: 30,
  });

  const active = observability.getOneproxyObservabilityStatus();
  assert.equal(active.active, true);
  assert.equal(active.running, false);
  assert.equal(active.retentionDays, 14);
  assert.equal(active.cleanupIntervalMinutes, 5);
  assert.equal(active.cleanupOnStartup, false);
  assert.equal(active.alertsEnabled, true);
  assert.equal(active.minActiveProxies, 5);
  assert.equal(active.minSuccessRate, 75);
  assert.equal(active.maxQuarantineRate, 30);
  assert.equal(typeof active.nextRunAt, "string");

  observability.stopOneproxyObservabilityScheduler();

  const stopped = observability.getOneproxyObservabilityStatus();
  assert.equal(stopped.active, false);
  assert.equal(stopped.nextRunAt, null);
});

test("oneproxy observability cleanup cycle deletes expired events", async () => {
  await resetStorage();

  const created = await oneproxyDb.upsertOneproxyProxy({
    ip: "10.11.0.1",
    port: 9111,
    protocol: "http",
    countryCode: "US",
    qualityScore: 80,
    latencyMs: 200,
    lastValidated: new Date().toISOString(),
  });

  assert.ok(created.proxy);
  await oneproxyDb.getOneproxyProxyForRotation({ strategy: "quality" });
  const oldTimestamp = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  core.getDbInstance().prepare("UPDATE oneproxy_events SET created_at = ?").run(oldTimestamp);

  const result = await observability.runOneproxyObservabilityCleanupCycle(
    { retentionDays: 30 },
    { force: true }
  );

  assert.equal(result.success, true);
  assert.equal(result.deleted, 1);
  assert.equal((await oneproxyDb.listOneproxyProxyEvents({ limit: 10 })).length, 0);
});
