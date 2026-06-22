import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-provider-account-proxies-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const proxiesDb = await import("../../src/lib/db/proxies.ts");
const distributeRoute =
  await import("../../src/app/api/providers/[id]/account-proxies/distribute/route.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("distribute route assigns real proxy credentials to no-auth account fingerprints", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "mimocode",
    authType: "oauth",
    name: "MiMoCode Managed",
    isActive: true,
    providerSpecificData: {
      fingerprints: ["fp-a", "fp-b", "fp-c"],
    },
  });

  const proxyA = await proxiesDb.createProxy({
    name: "Proxy A",
    type: "http",
    host: "proxy-a.local",
    port: 8080,
    username: "alice",
    password: "secret-a",
    family: "ipv4",
    status: "active",
  });
  const proxyB = await proxiesDb.createProxy({
    name: "Proxy B",
    type: "socks5",
    host: "proxy-b.local",
    port: 1080,
    status: "active",
  });
  await proxiesDb.createProxy({
    name: "Inactive Proxy",
    type: "http",
    host: "proxy-dead.local",
    port: 9090,
    username: "dead",
    password: "secret-dead",
    status: "error",
  });

  const request = await makeManagementSessionRequest(
    `http://localhost/api/providers/${connection.id}/account-proxies/distribute`,
    {
      method: "POST",
      body: { dataKey: "fingerprints" },
    }
  );

  const response = await distributeRoute.POST(request, {
    params: Promise.resolve({ id: connection.id }),
  });

  assert.equal(response.status, 200);

  const updated = await providersDb.getProviderConnectionById(connection.id);
  const providerSpecificData = updated?.providerSpecificData as
    | { accountProxies?: unknown }
    | undefined;
  assert.deepEqual(providerSpecificData?.accountProxies, [
    {
      fingerprint: "fp-a",
      proxy: {
        type: "http",
        host: "proxy-a.local",
        port: 8080,
        proxyId: proxyA?.id,
        proxyName: "Proxy A",
        username: "alice",
        password: "secret-a",
        family: "ipv4",
      },
    },
    {
      fingerprint: "fp-b",
      proxy: {
        type: "socks5",
        host: "proxy-b.local",
        port: 1080,
        proxyId: proxyB?.id,
        proxyName: "Proxy B",
        family: "auto",
      },
    },
    {
      fingerprint: "fp-c",
      proxy: {
        type: "http",
        host: "proxy-a.local",
        port: 8080,
        proxyId: proxyA?.id,
        proxyName: "Proxy A",
        username: "alice",
        password: "secret-a",
        family: "ipv4",
      },
    },
  ]);
});
