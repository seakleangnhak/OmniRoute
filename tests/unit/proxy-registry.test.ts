import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-proxy-registry-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const proxiesDb = await import("../../src/lib/db/proxies.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const rotatingProxy = await import("../../src/lib/rotatingProxy.ts");

async function resetStorage() {
  core.resetDbInstance();
  rotatingProxy.clearRotatingProxyStickyCacheForTests();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.after(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("proxy registry blocks delete when proxy is still assigned", async () => {
  await resetStorage();

  const created = await proxiesDb.createProxy({
    name: "Delete Safety Proxy",
    type: "http",
    host: "127.0.0.1",
    port: 8080,
  });

  assert.ok(created?.id);
  await proxiesDb.assignProxyToScope("provider", "openai", created.id);

  await assert.rejects(
    async () => proxiesDb.deleteProxyById(created.id),
    (error) => {
      assert.equal((error as any).status, 409);
      (assert as any).equal((error as any).code, "proxy_in_use");
      return true;
    }
  );
});

test("registry assignment takes precedence over legacy proxy config", async () => {
  await resetStorage();

  const conn = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "registry-precedence",
    apiKey: "sk-test",
  });

  await settingsDb.setProxyForLevel("key", (conn as any).id, {
    type: "http",
    host: "legacy-key.local",
    port: 8080,
  });

  const providerProxy = await proxiesDb.createProxy({
    name: "Provider Proxy",
    type: "https",
    host: "provider.local",
    port: 443,
  });
  const accountProxy = await proxiesDb.createProxy({
    name: "Account Proxy",
    type: "http",
    host: "account.local",
    port: 8081,
  });

  await proxiesDb.assignProxyToScope("provider", "openai", providerProxy.id);
  await proxiesDb.assignProxyToScope("account", (conn as any).id, accountProxy.id);

  const resolved = await settingsDb.resolveProxyForConnection((conn as any).id);
  assert.equal(resolved.level, "account");
  assert.equal(resolved.source, "registry");
  assert.equal(resolved.proxy.host, "account.local");
});

test("legacy proxy config migration imports global/provider/key assignments", async () => {
  await resetStorage();

  const conn = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "legacy-import",
    apiKey: "sk-test-legacy",
  });

  await settingsDb.setProxyForLevel("global", null, {
    type: "http",
    host: "global.local",
    port: 8080,
  });
  await settingsDb.setProxyForLevel("provider", "openai", {
    type: "https",
    host: "provider-legacy.local",
    port: 443,
  });
  await settingsDb.setProxyForLevel("key", (conn as any).id, {
    type: "http",
    host: "account-legacy.local",
    port: 8082,
  });

  const result = await proxiesDb.migrateLegacyProxyConfigToRegistry();
  assert.equal(result.skipped, false);
  assert.equal(result.migrated >= 3, true);

  const resolved = await settingsDb.resolveProxyForConnection((conn as any).id);
  assert.equal(resolved.level, "account");
  assert.equal(resolved.source, "registry");
  assert.equal(resolved.proxy.host, "account-legacy.local");
});

test("rotating proxy setting selects a different oneproxy entry for each request", async () => {
  await resetStorage();

  const conn = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "rotating-proxy-account",
    apiKey: "sk-rotate",
  });

  await proxiesDb.createProxy({
    name: "Manual Proxy Should Not Rotate",
    type: "http",
    host: "manual.local",
    port: 8080,
  });
  const oneproxyDb = await import("../../src/lib/db/oneproxy.ts");
  await oneproxyDb.upsertOneproxyProxy({
    ip: "10.0.0.1",
    port: 8001,
    protocol: "http",
    countryCode: "US",
    qualityScore: 90,
  });
  await oneproxyDb.upsertOneproxyProxy({
    ip: "10.0.0.2",
    port: 8002,
    protocol: "http",
    countryCode: "US",
    qualityScore: 90,
  });

  await settingsDb.updateSettings({
    rotatingProxy: {
      enabled: true,
      source: "oneproxy",
      strategy: "sequential",
      scope: "global",
      minQuality: 50,
    },
  });

  const first = await settingsDb.resolveProxyForConnection((conn as any).id);
  const second = await settingsDb.resolveProxyForConnection((conn as any).id);

  assert.equal(first.source, "oneproxy-rotation");
  assert.equal(second.source, "oneproxy-rotation");
  assert.notEqual(first.proxy.host, "manual.local");
  assert.notEqual(second.proxy.host, "manual.local");
  assert.notEqual(first.proxy.host, second.proxy.host);
});

test("rotating proxy sticky session reuses proxy and retry exclusion replaces it", async () => {
  await resetStorage();

  const conn = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "sticky-rotating-proxy-account",
    apiKey: "sk-sticky-rotate",
  });

  const oneproxyDb = await import("../../src/lib/db/oneproxy.ts");
  await oneproxyDb.upsertOneproxyProxy({
    ip: "10.0.2.1",
    port: 8201,
    protocol: "http",
    countryCode: "US",
    qualityScore: 95,
  });
  await oneproxyDb.upsertOneproxyProxy({
    ip: "10.0.2.2",
    port: 8202,
    protocol: "http",
    countryCode: "US",
    qualityScore: 95,
  });

  await settingsDb.updateSettings({
    rotatingProxy: {
      enabled: true,
      source: "oneproxy",
      strategy: "sequential",
      scope: "global",
      minQuality: 50,
      stickyMode: "per-session",
      stickyTtlMinutes: 30,
    },
  });

  const stickyContext = { sessionId: "session-a", apiKeyId: "key-a" };
  const first = await settingsDb.resolveProxyForConnection((conn as any).id, { stickyContext });
  const second = await settingsDb.resolveProxyForConnection((conn as any).id, { stickyContext });

  assert.equal(first.source, "oneproxy-rotation");
  assert.equal(second.source, "oneproxy-rotation");
  assert.equal(second.proxy.host, first.proxy.host);
  assert.equal((second as any).rotation.stickyMode, "per-session");
  assert.ok((second as any).rotation.stickyKey.includes("session-a"));

  const afterFailure = await settingsDb.resolveProxyForConnection((conn as any).id, {
    stickyContext,
    excludeRotatingProxyIds: [(first as any).rotation.proxyId],
  });
  const nextCached = await settingsDb.resolveProxyForConnection((conn as any).id, {
    stickyContext,
  });

  assert.equal(afterFailure.source, "oneproxy-rotation");
  assert.notEqual(afterFailure.proxy.host, first.proxy.host);
  assert.equal(nextCached.proxy.host, afterFailure.proxy.host);
});

test("oneproxy rotation excludes already failed proxies", async () => {
  await resetStorage();

  const oneproxyDb = await import("../../src/lib/db/oneproxy.ts");
  await oneproxyDb.upsertOneproxyProxy({
    ip: "10.0.1.1",
    port: 8101,
    protocol: "http",
    countryCode: "US",
    qualityScore: 95,
  });
  await oneproxyDb.upsertOneproxyProxy({
    ip: "10.0.1.2",
    port: 8102,
    protocol: "http",
    countryCode: "US",
    qualityScore: 95,
  });

  const first = await oneproxyDb.getOneproxyProxyForRotation({ strategy: "quality" });
  assert.ok(first);

  const second = await oneproxyDb.getOneproxyProxyForRotation({
    strategy: "quality",
    excludeIds: [first.id],
  });

  assert.ok(second);
  assert.notEqual(second.id, first.id);
  assert.notEqual(second.host, first.host);
});

test("oneproxy quality rotation uses effective pool scoring", async () => {
  await resetStorage();

  const oneproxyDb = await import("../../src/lib/db/oneproxy.ts");
  const staleValidation = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const freshValidation = new Date().toISOString();

  const staleHighQuality = await oneproxyDb.upsertOneproxyProxy({
    ip: "10.0.3.1",
    port: 8301,
    protocol: "http",
    countryCode: "US",
    qualityScore: 100,
    latencyMs: 5000,
    lastValidated: staleValidation,
  });
  const freshLowerQuality = await oneproxyDb.upsertOneproxyProxy({
    ip: "10.0.3.2",
    port: 8302,
    protocol: "http",
    countryCode: "US",
    qualityScore: 75,
    latencyMs: 120,
    googleAccess: true,
    lastValidated: freshValidation,
  });

  assert.ok(staleHighQuality.proxy);
  assert.ok(freshLowerQuality.proxy);
  assert.equal(staleHighQuality.proxy.qualityScore! > freshLowerQuality.proxy.qualityScore!, true);
  assert.equal(
    staleHighQuality.proxy.effectiveScore < freshLowerQuality.proxy.effectiveScore,
    true
  );

  const selected = await oneproxyDb.getOneproxyProxyForRotation({ strategy: "quality" });

  assert.ok(selected);
  assert.equal(selected.host, "10.0.3.2");
  assert.equal(selected.effectiveScore, freshLowerQuality.proxy.effectiveScore);
});

test("oneproxy runtime failure quarantines proxy and rotation skips it", async () => {
  await resetStorage();

  const oneproxyDb = await import("../../src/lib/db/oneproxy.ts");
  const first = await oneproxyDb.upsertOneproxyProxy({
    ip: "10.0.4.1",
    port: 8401,
    protocol: "http",
    countryCode: "US",
    qualityScore: 100,
    latencyMs: 100,
    lastValidated: new Date().toISOString(),
  });
  await oneproxyDb.upsertOneproxyProxy({
    ip: "10.0.4.2",
    port: 8402,
    protocol: "http",
    countryCode: "US",
    qualityScore: 80,
    latencyMs: 100,
    lastValidated: new Date().toISOString(),
  });

  assert.ok(first.proxy);
  await oneproxyDb.markOneproxyProxyFailed("10.0.4.1", 8401, {
    error: Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }),
    quarantineMinutes: 60,
  });

  const failed = await oneproxyDb.getOneproxyProxyById(first.proxy.id);
  assert.ok(failed?.quarantinedUntil);
  assert.equal(Date.parse(failed.quarantinedUntil!) > Date.now(), true);
  assert.equal(failed.lastErrorType, "timeout");
  assert.equal(failed.failureStreak, 1);
  assert.equal(failed.effectiveScore, 0);

  const selected = await oneproxyDb.getOneproxyProxyForRotation({ strategy: "quality" });
  assert.ok(selected);
  assert.equal(selected.host, "10.0.4.2");
});

test("oneproxy runtime success clears quarantine and failure streak", async () => {
  await resetStorage();

  const oneproxyDb = await import("../../src/lib/db/oneproxy.ts");
  const created = await oneproxyDb.upsertOneproxyProxy({
    ip: "10.0.5.1",
    port: 8501,
    protocol: "http",
    countryCode: "US",
    qualityScore: 70,
    latencyMs: 1000,
    lastValidated: new Date().toISOString(),
  });

  assert.ok(created.proxy);
  await oneproxyDb.markOneproxyProxyFailed("10.0.5.1", 8501, {
    errorType: "connection",
    quarantineMinutes: 60,
  });
  await oneproxyDb.recordOneproxyProxyRuntimeSuccess("10.0.5.1", 8501, { latencyMs: 200 });

  const recovered = await oneproxyDb.getOneproxyProxyById(created.proxy.id);
  assert.equal(recovered?.status, "active");
  assert.equal(recovered?.quarantinedUntil, null);
  assert.equal(recovered?.lastError, null);
  assert.equal(recovered?.failureStreak, 0);
  assert.equal(recovered?.failureCount, 0);
  assert.equal(recovered?.successCount, 1);
  assert.equal(recovered?.latencyMs, 200);
});

test("oneproxy observability records rotation selections and runtime outcomes", async () => {
  await resetStorage();

  const oneproxyDb = await import("../../src/lib/db/oneproxy.ts");
  const created = await oneproxyDb.upsertOneproxyProxy({
    ip: "10.0.6.1",
    port: 8601,
    protocol: "http",
    countryCode: "US",
    qualityScore: 90,
    latencyMs: 300,
    lastValidated: new Date().toISOString(),
  });

  assert.ok(created.proxy);
  const selected = await oneproxyDb.getOneproxyProxyForRotation({ strategy: "quality" });
  assert.ok(selected);
  assert.equal(selected.id, created.proxy.id);
  assert.equal(selected.requestCount, 1);
  assert.ok(selected.lastUsedAt);

  await oneproxyDb.recordOneproxyProxyRuntimeSuccess("10.0.6.1", 8601, { latencyMs: 180 });
  let observed = await oneproxyDb.getOneproxyProxyById(created.proxy.id);
  assert.ok(observed);
  assert.equal(observed.runtimeSuccessCount, 1);
  assert.equal(observed.runtimeFailureCount, 0);
  assert.equal(observed.avgLatencyMs, 180);
  assert.equal(observed.successRate, 100);
  assert.equal(observed.successRate1h, 100);
  assert.equal(observed.successRate24h, 100);
  assert.equal(observed.p95LatencyMs1h, 180);
  assert.ok(observed.lastSuccessAt);

  await oneproxyDb.markOneproxyProxyFailed("10.0.6.1", 8601, {
    errorType: "timeout",
    quarantineMinutes: 10,
  });
  observed = await oneproxyDb.getOneproxyProxyById(created.proxy.id);
  assert.ok(observed);
  assert.equal(observed.runtimeSuccessCount, 1);
  assert.equal(observed.runtimeFailureCount, 1);
  assert.equal(observed.successRate, 50);
  assert.equal(observed.successRate1h, 50);
  assert.ok(observed.lastFailureAt);

  const events = await oneproxyDb.listOneproxyProxyEvents({ proxyId: created.proxy.id, limit: 10 });
  const eventTypes = events.map((event) => event.eventType);
  assert.ok(eventTypes.includes("selected"));
  assert.ok(eventTypes.includes("success"));
  assert.ok(eventTypes.includes("failure"));
  assert.ok(eventTypes.includes("quarantine"));
});

test("oneproxy health validation writes health and recovery events", async () => {
  await resetStorage();

  const oneproxyDb = await import("../../src/lib/db/oneproxy.ts");
  const created = await oneproxyDb.upsertOneproxyProxy({
    ip: "10.0.7.1",
    port: 8701,
    protocol: "http",
    countryCode: "US",
    qualityScore: 50,
    latencyMs: 1000,
    lastValidated: new Date().toISOString(),
  });

  assert.ok(created.proxy);
  await oneproxyDb.markOneproxyProxyFailed("10.0.7.1", 8701, {
    errorType: "connection",
    quarantineMinutes: 10,
  });
  await oneproxyDb.recordOneproxyProxyHealthResult(created.proxy.id, {
    success: true,
    latencyMs: 120,
    qualityScore: 100,
  });

  const events = await oneproxyDb.listOneproxyProxyEvents({ proxyId: created.proxy.id, limit: 10 });
  const eventTypes = events.map((event) => event.eventType);
  assert.ok(eventTypes.includes("health_success"));
  assert.ok(eventTypes.includes("recovery"));
});

test("oneproxy event retention cleanup prunes old events", async () => {
  await resetStorage();

  const oneproxyDb = await import("../../src/lib/db/oneproxy.ts");
  const created = await oneproxyDb.upsertOneproxyProxy({
    ip: "10.0.8.1",
    port: 8801,
    protocol: "http",
    countryCode: "US",
    qualityScore: 90,
    latencyMs: 250,
    lastValidated: new Date().toISOString(),
  });

  assert.ok(created.proxy);
  await oneproxyDb.getOneproxyProxyForRotation({ strategy: "quality" });
  await oneproxyDb.recordOneproxyProxyRuntimeSuccess("10.0.8.1", 8801, { latencyMs: 150 });

  const oldTimestamp = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  core
    .getDbInstance()
    .prepare("UPDATE oneproxy_events SET created_at = ? WHERE event_type = ?")
    .run(oldTimestamp, "selected");

  const cleanup = await oneproxyDb.cleanupOneproxyProxyEvents({ retentionDays: 7 });
  assert.equal(cleanup.deleted, 1);

  const events = await oneproxyDb.listOneproxyProxyEvents({ proxyId: created.proxy.id, limit: 10 });
  const eventTypes = events.map((event) => event.eventType);
  assert.equal(eventTypes.includes("selected"), false);
  assert.equal(eventTypes.includes("success"), true);
});

test("oneproxy pool alerts detect low active success and high quarantine rates", async () => {
  await resetStorage();

  const oneproxyDb = await import("../../src/lib/db/oneproxy.ts");
  await oneproxyDb.upsertOneproxyProxy({
    ip: "10.0.9.1",
    port: 8901,
    protocol: "http",
    countryCode: "US",
    qualityScore: 90,
    latencyMs: 150,
    lastValidated: new Date().toISOString(),
  });
  await oneproxyDb.upsertOneproxyProxy({
    ip: "10.0.9.2",
    port: 8902,
    protocol: "http",
    countryCode: "US",
    qualityScore: 90,
    latencyMs: 150,
    lastValidated: new Date().toISOString(),
  });

  await oneproxyDb.recordOneproxyProxyRuntimeSuccess("10.0.9.1", 8901, { latencyMs: 120 });
  await oneproxyDb.markOneproxyProxyFailed("10.0.9.2", 8902, {
    errorType: "timeout",
    quarantineMinutes: 30,
  });

  const alerts = await oneproxyDb.getOneproxyPoolAlerts({
    minActiveProxies: 3,
    minSuccessRate: 80,
    maxQuarantineRate: 25,
  });
  const codes = alerts.map((alert) => alert.code).sort();

  assert.deepEqual(codes, ["high_quarantine_rate", "low_active_pool", "low_success_rate"]);
});

test("rotating proxy policy provider override can bypass rotation", async () => {
  await resetStorage();

  const conn = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "policy-bypass-account",
    apiKey: "sk-policy-bypass",
  });

  const oneproxyDb = await import("../../src/lib/db/oneproxy.ts");
  await oneproxyDb.upsertOneproxyProxy({
    ip: "10.0.10.1",
    port: 9001,
    protocol: "http",
    countryCode: "US",
    qualityScore: 95,
  });

  await settingsDb.updateSettings({
    rotatingProxy: {
      enabled: true,
      source: "oneproxy",
      strategy: "quality",
      scope: "global",
      minQuality: 50,
    },
    rotatingProxyPolicy: {
      defaultMode: "optional",
      failBehavior: "fail-open",
      providerOverrides: {
        openai: { mode: "disabled" },
      },
      accountOverrides: {},
    },
  });

  const resolved = await settingsDb.resolveProxyForConnection((conn as any).id);

  assert.notEqual(resolved.source, "oneproxy-rotation");
  assert.notEqual(resolved.proxy?.host, "10.0.10.1");
});

test("required rotating proxy policy can force rotation when global toggle is off", async () => {
  await resetStorage();

  const conn = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "policy-required-account",
    apiKey: "sk-policy-required",
  });

  const oneproxyDb = await import("../../src/lib/db/oneproxy.ts");
  await oneproxyDb.upsertOneproxyProxy({
    ip: "10.0.11.1",
    port: 9101,
    protocol: "http",
    countryCode: "US",
    qualityScore: 95,
  });

  await settingsDb.updateSettings({
    rotatingProxy: {
      enabled: false,
      source: "oneproxy",
      strategy: "quality",
      scope: "global",
      minQuality: 50,
    },
    rotatingProxyPolicy: {
      defaultMode: "required",
      failBehavior: "fail-closed",
      maxProxyRetries: 2,
      providerOverrides: {},
      accountOverrides: {},
    },
  });

  const resolved = await settingsDb.resolveProxyForConnection((conn as any).id);

  assert.equal(resolved.source, "oneproxy-rotation");
  assert.equal(resolved.proxy.host, "10.0.11.1");
  assert.equal((resolved as any).rotation.policyMode, "required");
  assert.equal((resolved as any).rotation.failBehavior, "fail-closed");
  assert.equal((resolved as any).rotation.maxProxyRetries, 2);
});

test("required fail-closed rotating proxy policy blocks empty pool", async () => {
  await resetStorage();

  const conn = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "policy-empty-pool-account",
    apiKey: "sk-policy-empty",
  });

  await settingsDb.updateSettings({
    rotatingProxy: {
      enabled: false,
      source: "oneproxy",
      strategy: "quality",
      scope: "global",
      minQuality: 50,
    },
    rotatingProxyPolicy: {
      defaultMode: "required",
      failBehavior: "fail-closed",
      providerOverrides: {},
      accountOverrides: {},
    },
  });

  await assert.rejects(
    async () => settingsDb.resolveProxyForConnection((conn as any).id),
    (error) => {
      assert.equal((error as any).code, "ROTATING_PROXY_REQUIRED");
      assert.equal((error as any).status, 503);
      return true;
    }
  );
});
