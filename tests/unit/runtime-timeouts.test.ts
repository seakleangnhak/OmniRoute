import test from "node:test";
import assert from "node:assert/strict";

const runtimeTimeouts = await import("../../src/shared/utils/runtimeTimeouts.ts");

test("upstream timeout config derives hidden fetch timeouts from FETCH_TIMEOUT_MS", () => {
  const config = runtimeTimeouts.getUpstreamTimeoutConfig({
    FETCH_TIMEOUT_MS: "600000",
    STREAM_IDLE_TIMEOUT_MS: "600000",
  });

  assert.deepEqual(config, {
    fetchTimeoutMs: 600000,
    streamIdleTimeoutMs: 600000,
    sseHeartbeatIntervalMs: 15000,
    streamReadinessTimeoutMs: 10000,
    fetchHeadersTimeoutMs: 600000,
    fetchBodyTimeoutMs: 600000,
    fetchConnectTimeoutMs: 10000,
    fetchKeepAliveTimeoutMs: 4000,
  });
});

test("REQUEST_TIMEOUT_MS becomes the common upstream timeout baseline when specific overrides are unset", () => {
  const upstreamConfig = runtimeTimeouts.getUpstreamTimeoutConfig({
    REQUEST_TIMEOUT_MS: "600000",
  });
  const apiBridgeConfig = runtimeTimeouts.getApiBridgeTimeoutConfig({
    REQUEST_TIMEOUT_MS: "600000",
  });

  assert.equal(upstreamConfig.fetchTimeoutMs, 600000);
  assert.equal(upstreamConfig.streamIdleTimeoutMs, 600000);
  assert.equal(upstreamConfig.streamReadinessTimeoutMs, 600000);
  assert.equal(upstreamConfig.fetchHeadersTimeoutMs, 600000);
  assert.equal(upstreamConfig.fetchBodyTimeoutMs, 600000);
  assert.equal(apiBridgeConfig.proxyTimeoutMs, 10000);
  assert.equal(apiBridgeConfig.streamProxyTimeoutMs, 600000);
  assert.equal(apiBridgeConfig.serverRequestTimeoutMs, 10000);
});

test("upstream timeout config honors explicit overrides and falls back on invalid values", () => {
  const config = runtimeTimeouts.getUpstreamTimeoutConfig({
    REQUEST_TIMEOUT_MS: "550000",
    FETCH_TIMEOUT_MS: "600000",
    STREAM_IDLE_TIMEOUT_MS: "600000",
    STREAM_READINESS_TIMEOUT_MS: "90000",
    FETCH_HEADERS_TIMEOUT_MS: "610000",
    FETCH_BODY_TIMEOUT_MS: "0",
    FETCH_CONNECT_TIMEOUT_MS: "45000",
    FETCH_KEEPALIVE_TIMEOUT_MS: "-1",
  });

  assert.equal(config.streamReadinessTimeoutMs, 90000);
  assert.equal(config.fetchHeadersTimeoutMs, 610000);
  assert.equal(config.fetchBodyTimeoutMs, 0);
  assert.equal(config.fetchConnectTimeoutMs, 45000);
  assert.equal(config.fetchKeepAliveTimeoutMs, 4000);
});

test("TLS client timeout defaults to FETCH_TIMEOUT_MS and can be overridden", () => {
  const defaultConfig = runtimeTimeouts.getTlsClientTimeoutConfig({
    FETCH_TIMEOUT_MS: "600000",
  });
  const overriddenConfig = runtimeTimeouts.getTlsClientTimeoutConfig({
    FETCH_TIMEOUT_MS: "600000",
    TLS_CLIENT_TIMEOUT_MS: "720000",
  });

  assert.equal(defaultConfig.timeoutMs, 600000);
  assert.equal(overriddenConfig.timeoutMs, 720000);
});

test("stainless timeout derives from fetch timeout and rounds up to whole seconds", () => {
  assert.equal(
    runtimeTimeouts.getStainlessTimeoutSeconds({
      REQUEST_TIMEOUT_MS: "1200000",
    }),
    1200
  );
  assert.equal(
    runtimeTimeouts.getStainlessTimeoutSeconds({
      FETCH_TIMEOUT_MS: "600001",
    }),
    601
  );
});

test("API bridge timeouts align request timeout with long proxy timeout by default", () => {
  const config = runtimeTimeouts.getApiBridgeTimeoutConfig({
    API_BRIDGE_PROXY_TIMEOUT_MS: "120000",
  });

  assert.deepEqual(config, {
    proxyTimeoutMs: 120000,
    streamProxyTimeoutMs: 300000,
    serverRequestTimeoutMs: 120000,
    serverHeadersTimeoutMs: 60000,
    serverKeepAliveTimeoutMs: 5000,
    serverSocketTimeoutMs: 0,
  });
});

test("upstream timeout defaults use the 10s fast-fail window", () => {
  const config = runtimeTimeouts.getUpstreamTimeoutConfig({});

  assert.equal(runtimeTimeouts.DEFAULT_FETCH_TIMEOUT_MS, 10_000);
  assert.equal(runtimeTimeouts.DEFAULT_STREAM_IDLE_TIMEOUT_MS, 10_000);
  assert.equal(runtimeTimeouts.DEFAULT_STREAM_READINESS_TIMEOUT_MS, 10_000);
  assert.equal(runtimeTimeouts.DEFAULT_FETCH_CONNECT_TIMEOUT_MS, 10_000);
  assert.equal(config.fetchTimeoutMs, 10_000);
  assert.equal(config.streamIdleTimeoutMs, 10_000);
  assert.equal(config.streamReadinessTimeoutMs, 10_000);
  assert.equal(config.fetchHeadersTimeoutMs, 10_000);
  assert.equal(config.fetchBodyTimeoutMs, 10_000);
  assert.equal(config.fetchConnectTimeoutMs, 10_000);
});

test("heartbeat interval default = 15s, env-overridable", () => {
  assert.equal(runtimeTimeouts.DEFAULT_SSE_HEARTBEAT_INTERVAL_MS, 15_000);
  assert.equal(runtimeTimeouts.getUpstreamTimeoutConfig({}).sseHeartbeatIntervalMs, 15_000);
  assert.equal(
    runtimeTimeouts.getUpstreamTimeoutConfig({ SSE_HEARTBEAT_INTERVAL_MS: "8000" })
      .sseHeartbeatIntervalMs,
    8_000
  );
  assert.equal(
    runtimeTimeouts.getUpstreamTimeoutConfig({ SSE_HEARTBEAT_INTERVAL_MS: "0" })
      .sseHeartbeatIntervalMs,
    0
  );
});

test("API bridge proxy timeout defaults to the 10s fast-fail window", () => {
  const config = runtimeTimeouts.getApiBridgeTimeoutConfig({});

  assert.equal(runtimeTimeouts.DEFAULT_API_BRIDGE_PROXY_TIMEOUT_MS, 10_000);
  assert.equal(runtimeTimeouts.DEFAULT_API_BRIDGE_STREAM_PROXY_TIMEOUT_MS, 300_000);
  assert.equal(runtimeTimeouts.DEFAULT_API_BRIDGE_SERVER_REQUEST_TIMEOUT_MS, 10_000);
  assert.equal(config.proxyTimeoutMs, 10000);
  assert.equal(config.streamProxyTimeoutMs, 300000);
  assert.equal(config.serverRequestTimeoutMs, 10000);
});

test("API bridge streaming timeout follows long stream/body timeouts", () => {
  const inherited = runtimeTimeouts.getApiBridgeTimeoutConfig({
    STREAM_IDLE_TIMEOUT_MS: "301000",
    FETCH_BODY_TIMEOUT_MS: "600000",
  });
  const explicit = runtimeTimeouts.getApiBridgeTimeoutConfig({
    API_BRIDGE_STREAM_PROXY_TIMEOUT_MS: "450000",
    STREAM_IDLE_TIMEOUT_MS: "301000",
    FETCH_BODY_TIMEOUT_MS: "600000",
  });

  assert.equal(inherited.proxyTimeoutMs, 10000);
  assert.equal(inherited.streamProxyTimeoutMs, 600000);
  assert.equal(explicit.streamProxyTimeoutMs, 450000);
});

test("REQUEST_TIMEOUT_MS=0 disables API bridge proxy and request timeouts consistently", () => {
  const config = runtimeTimeouts.getApiBridgeTimeoutConfig({
    REQUEST_TIMEOUT_MS: "0",
  });

  assert.equal(config.proxyTimeoutMs, 0);
  assert.equal(config.serverRequestTimeoutMs, 0);
});
