import test from "node:test";
import assert from "node:assert/strict";

import {
  getOneproxyAutoSyncStatus,
  normalizeOneproxyAutoSyncSettings,
  startOneproxyAutoSyncScheduler,
  stopOneproxyAutoSyncScheduler,
} from "../../src/lib/oneproxyAutoSync.ts";

test.afterEach(() => {
  stopOneproxyAutoSyncScheduler();
});

test("oneproxy auto sync settings normalize and clamp unsafe values", () => {
  const normalized = normalizeOneproxyAutoSyncSettings({
    enabled: true,
    intervalMinutes: 1,
    maxProxies: 5000,
    minQuality: -10,
    syncOnStartup: false,
  });

  assert.deepEqual(normalized, {
    enabled: true,
    intervalMinutes: 5,
    maxProxies: 1000,
    minQuality: 0,
    syncOnStartup: false,
  });
});

test("oneproxy auto sync scheduler exposes active status and can stop cleanly", () => {
  startOneproxyAutoSyncScheduler({
    enabled: true,
    intervalMinutes: 5,
    maxProxies: 25,
    minQuality: 60,
    syncOnStartup: false,
  });

  const active = getOneproxyAutoSyncStatus();
  assert.equal(active.configured, true);
  assert.equal(active.active, true);
  assert.equal(active.running, false);
  assert.equal(active.intervalMinutes, 5);
  assert.equal(active.maxProxies, 25);
  assert.equal(active.minQuality, 60);
  assert.equal(active.syncOnStartup, false);
  assert.equal(typeof active.nextRunAt, "string");

  stopOneproxyAutoSyncScheduler();

  const stopped = getOneproxyAutoSyncStatus();
  assert.equal(stopped.configured, false);
  assert.equal(stopped.active, false);
  assert.equal(stopped.nextRunAt, null);
});
