import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-oneproxy-health-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const oneproxyDb = await import("../../src/lib/db/oneproxy.ts");
const healthValidator = await import("../../src/lib/oneproxyHealthValidator.ts");

async function resetStorage() {
  healthValidator.stopOneproxyHealthValidatorScheduler();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.afterEach(() => {
  healthValidator.stopOneproxyHealthValidatorScheduler();
});

test.after(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("oneproxy health validator settings normalize and clamp unsafe values", () => {
  const normalized = healthValidator.normalizeOneproxyHealthValidatorSettings({
    enabled: true,
    intervalMinutes: 1,
    batchSize: 5000,
    timeoutMs: 100,
    testUrl: "file:///tmp/nope",
    revalidateOlderThanMinutes: 1,
    maxFailures: 99,
    validateOnStartup: false,
  });

  assert.deepEqual(normalized, {
    enabled: true,
    intervalMinutes: 5,
    batchSize: 200,
    timeoutMs: 1000,
    testUrl: "https://www.google.com/generate_204",
    revalidateOlderThanMinutes: 5,
    maxFailures: 10,
    validateOnStartup: false,
  });
});

test("oneproxy health validator scheduler exposes active status and can stop cleanly", () => {
  healthValidator.startOneproxyHealthValidatorScheduler({
    enabled: true,
    intervalMinutes: 5,
    batchSize: 10,
    timeoutMs: 1500,
    revalidateOlderThanMinutes: 30,
    maxFailures: 2,
    validateOnStartup: false,
  });

  const active = healthValidator.getOneproxyHealthValidatorStatus();
  assert.equal(active.configured, true);
  assert.equal(active.active, true);
  assert.equal(active.running, false);
  assert.equal(active.intervalMinutes, 5);
  assert.equal(active.batchSize, 10);
  assert.equal(active.timeoutMs, 1500);
  assert.equal(active.revalidateOlderThanMinutes, 30);
  assert.equal(active.maxFailures, 2);
  assert.equal(active.validateOnStartup, false);
  assert.equal(typeof active.nextRunAt, "string");

  healthValidator.stopOneproxyHealthValidatorScheduler();

  const stopped = healthValidator.getOneproxyHealthValidatorStatus();
  assert.equal(stopped.configured, false);
  assert.equal(stopped.active, false);
  assert.equal(stopped.nextRunAt, null);
});

test("oneproxy health validation updates quality and deactivates repeated failures", async () => {
  await resetStorage();
  const oldValidatedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  const healthy = await oneproxyDb.upsertOneproxyProxy({
    ip: "10.10.0.1",
    port: 9001,
    protocol: "http",
    countryCode: "US",
    qualityScore: 50,
    latencyMs: 5000,
    lastValidated: oldValidatedAt,
  });
  const unhealthy = await oneproxyDb.upsertOneproxyProxy({
    ip: "10.10.0.2",
    port: 9002,
    protocol: "http",
    countryCode: "US",
    qualityScore: 50,
    latencyMs: 5000,
    lastValidated: oldValidatedAt,
  });

  const result = await healthValidator.runOneproxyHealthValidationCycle(
    {
      enabled: true,
      batchSize: 2,
      revalidateOlderThanMinutes: 5,
      maxFailures: 1,
    },
    {
      validateProxy: async (proxy) =>
        proxy.host === "10.10.0.1"
          ? { success: true, latencyMs: 250, qualityScore: 100 }
          : { success: false, latencyMs: 8000, error: "connect ECONNREFUSED" },
    }
  );

  assert.equal(result.success, true);
  assert.equal(result.checked, 2);
  assert.equal(result.healthy, 1);
  assert.equal(result.unhealthy, 1);
  assert.equal(result.deactivated, 1);

  const healthyAfter = await oneproxyDb.getOneproxyProxyById(healthy.proxy!.id);
  const unhealthyAfter = await oneproxyDb.getOneproxyProxyById(unhealthy.proxy!.id);

  assert.equal(healthyAfter?.status, "active");
  assert.equal(healthyAfter?.latencyMs, 250);
  assert.equal(healthyAfter?.qualityScore, 100);
  assert.equal(healthyAfter?.failureCount, 0);
  assert.equal(unhealthyAfter?.status, "inactive");
  assert.equal(unhealthyAfter?.failureCount, 1);
  assert.equal(unhealthyAfter?.failureStreak, 1);
  assert.equal(unhealthyAfter?.lastErrorType, "connection");
  assert.ok(unhealthyAfter?.quarantinedUntil);
  assert.equal(unhealthyAfter?.qualityScore, 30);
});

test("oneproxy health validation recovers quarantined inactive proxies", async () => {
  await resetStorage();
  const oldValidatedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  const created = await oneproxyDb.upsertOneproxyProxy({
    ip: "10.10.1.1",
    port: 9101,
    protocol: "http",
    countryCode: "US",
    qualityScore: 40,
    latencyMs: 8000,
    lastValidated: oldValidatedAt,
  });

  assert.ok(created.proxy);
  await oneproxyDb.markOneproxyProxyFailed("10.10.1.1", 9101, {
    errorType: "connection",
    maxFailures: 1,
    quarantineMinutes: 60,
  });

  const before = await oneproxyDb.getOneproxyProxyById(created.proxy.id);
  assert.equal(before?.status, "inactive");
  assert.ok(before?.quarantinedUntil);

  const result = await healthValidator.runOneproxyHealthValidationCycle(
    {
      enabled: true,
      batchSize: 1,
      revalidateOlderThanMinutes: 5,
      maxFailures: 1,
    },
    {
      validateProxy: async () => ({ success: true, latencyMs: 180, qualityScore: 100 }),
    }
  );

  assert.equal(result.success, true);
  assert.equal(result.checked, 1);
  assert.equal(result.healthy, 1);

  const after = await oneproxyDb.getOneproxyProxyById(created.proxy.id);
  assert.equal(after?.status, "active");
  assert.equal(after?.quarantinedUntil, null);
  assert.equal(after?.lastError, null);
  assert.equal(after?.lastErrorType, null);
  assert.equal(after?.failureCount, 0);
  assert.equal(after?.failureStreak, 0);
  assert.equal(after?.successCount, 1);
  assert.equal(after?.latencyMs, 180);
  assert.equal(after?.qualityScore, 100);
});
