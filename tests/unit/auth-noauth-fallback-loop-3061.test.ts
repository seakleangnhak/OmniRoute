/**
 * Issue #3061 — No-auth providers (opencode / opencode-zen) infinite
 * account-fallback loop on a persistent upstream error → unbounded DB growth /
 * disk exhaustion.
 *
 * For a no-auth provider, getProviderCredentials early-returns synthetic
 * credentials with connectionId "noauth" BEFORE honoring the exclusion set
 * (src/sse/services/auth.ts: the NOAUTH_PROVIDERS block and the opencode-zen
 * keyless fallback). So when the chat fallback loop marks the failed "noauth"
 * connection and excludes it, the selector hands "noauth" right back → it loops
 * forever, writing key-health + request logs every iteration until the disk
 * fills (see @paraflu's "failure #320" trace in discussion #3038).
 *
 * Loop-breaking invariant under test: once "noauth" is in excludeConnectionIds,
 * the selector MUST return null (no remaining candidate) so the chat handler
 * stops after a single attempt instead of re-selecting the same synthetic
 * connection. The happy-path (nothing excluded → synthetic noauth) must stay
 * intact so keyless access still works.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-noauth-loop-3061-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { getProviderCredentials } = await import("../../src/sse/services/auth.ts");
const { createProviderConnection, deleteProviderConnection } =
  await import("../../src/lib/db/providers.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ── Happy path preserved: first selection (nothing excluded) still works ──

test("#3061 opencode no-auth: first selection returns synthetic noauth (happy path preserved)", async () => {
  const creds = await getProviderCredentials("opencode", null, null, "minimax-m2.5-free");
  assert.ok(creds, "opencode must resolve to synthetic no-auth credentials on first selection");
  assert.equal((creds as { connectionId?: string }).connectionId, "noauth");
  assert.equal((creds as { apiKey?: unknown }).apiKey, null);
});

test("#3061 opencode-zen no-auth: first selection returns synthetic noauth (happy path preserved)", async () => {
  const creds = await getProviderCredentials("opencode-zen");
  assert.ok(creds, "opencode-zen must resolve to synthetic no-auth credentials on first selection");
  assert.equal((creds as { connectionId?: string }).connectionId, "noauth");
});

// ── The fix: once "noauth" is excluded, selection MUST stop (return null) ──

test("#3061 opencode no-auth: excluding 'noauth' returns null (breaks the fallback loop)", async () => {
  const creds = await getProviderCredentials("opencode", null, null, "minimax-m2.5-free", {
    excludeConnectionIds: ["noauth"],
  });
  assert.equal(
    creds,
    null,
    "after the synthetic noauth connection failed and was excluded, the selector must return " +
      "null instead of handing back 'noauth' (which would loop forever and fill the disk)"
  );
});

test("#3061 opencode-zen no-auth: excluding 'noauth' returns null (breaks the fallback loop)", async () => {
  const creds = await getProviderCredentials("opencode-zen", null, null, null, {
    excludeConnectionIds: ["noauth"],
  });
  assert.equal(
    creds,
    null,
    "excluded synthetic noauth must not be re-selected for the opencode-zen keyless path"
  );
});

test("mimocode no-auth uses saved account rows before synthetic noauth", async () => {
  const firstConnection = await createProviderConnection({
    provider: "mimocode",
    authType: "apikey",
    name: "MiMoCode Account A",
    priority: 1,
    isActive: true,
    testStatus: "active",
    providerSpecificData: { fingerprints: ["mimo-fingerprint-a"] },
  });
  const secondConnection = await createProviderConnection({
    provider: "mimocode",
    authType: "apikey",
    name: "MiMoCode Account B",
    priority: 2,
    isActive: true,
    testStatus: "active",
    providerSpecificData: { fingerprints: ["mimo-fingerprint-b"] },
  });

  try {
    const first = await getProviderCredentials("mimocode");
    assert.ok(first, "mimocode must resolve to a saved connection when rows exist");
    assert.equal((first as { connectionId?: string }).connectionId, firstConnection?.id);
    assert.notEqual((first as { connectionId?: string }).connectionId, "noauth");

    const second = await getProviderCredentials(
      "mimocode",
      (first as { connectionId?: string }).connectionId || null
    );
    assert.ok(second, "excluding the selected MiMo account should select the next saved row");
    assert.equal((second as { connectionId?: string }).connectionId, secondConnection?.id);
    assert.notEqual((second as { connectionId?: string }).connectionId, "noauth");
  } finally {
    if (firstConnection?.id) await deleteProviderConnection(firstConnection.id);
    if (secondConnection?.id) await deleteProviderConnection(secondConnection.id);
  }
});

test("mimocode configured banned row never falls through to synthetic noauth", async () => {
  const connection = await createProviderConnection({
    provider: "mimocode",
    authType: "apikey",
    name: "MiMoCode Banned Account",
    priority: 1,
    isActive: false,
    testStatus: "banned",
    providerSpecificData: { fingerprints: ["mimo-fingerprint-banned"] },
  });

  try {
    const credentials = await getProviderCredentials("mimocode");
    assert.ok(credentials, "terminal configured accounts should return an allExpired result");
    assert.equal(
      (credentials as { allExpired?: boolean }).allExpired,
      true,
      "a configured banned MiMo row must stop synthetic noauth fallback"
    );
    assert.notEqual((credentials as { connectionId?: string }).connectionId, "noauth");
  } finally {
    if (connection?.id) await deleteProviderConnection(connection.id);
  }
});
