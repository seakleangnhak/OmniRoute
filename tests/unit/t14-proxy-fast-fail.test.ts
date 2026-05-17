import test from "node:test";
import assert from "node:assert/strict";

import {
  isProxyReachable,
  getCachedProxyHealth,
  invalidateProxyHealth,
  resolveProxyHealthTarget,
} from "../../src/lib/proxyHealth.ts";
import { runWithProxyContext } from "../../open-sse/utils/proxyFetch.ts";

test("T14: proxy health preserves explicit HTTP port 80", () => {
  assert.deepEqual(resolveProxyHealthTarget("http://p.webshare.io:80"), {
    host: "p.webshare.io",
    port: 80,
  });
  assert.deepEqual(resolveProxyHealthTarget("http://p.webshare.io"), {
    host: "p.webshare.io",
    port: 8080,
  });
});

test("T14: isProxyReachable caches unreachable proxy result", async () => {
  const proxyUrl = "http://127.0.0.1:1";
  invalidateProxyHealth(proxyUrl);

  const healthy = await isProxyReachable(proxyUrl, 120, 2_000);
  assert.equal(healthy, false);
  assert.equal(getCachedProxyHealth(proxyUrl), false);
});

test("T14: runWithProxyContext fast-fails when proxy is unreachable", async () => {
  const proxyUrl = "http://127.0.0.1:1";
  invalidateProxyHealth(proxyUrl);

  let executed = false;
  await assert.rejects(
    () =>
      runWithProxyContext(proxyUrl, async () => {
        executed = true;
        return "ok";
      }),
    (err) => err instanceof Error && (err as Error & { code?: string }).code === "PROXY_UNREACHABLE"
  );

  assert.equal(executed, false);
});
