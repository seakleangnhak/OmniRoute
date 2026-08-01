/**
 * Issue #2257 — clientApi policy behavior when an invalid API key is sent.
 *
 * This standalone file mocks `validateApiKey` so invalid-key rejection can be
 * tested in isolation without a DB or migration runner.
 */

import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// ─── Mock validateApiKey via require interception (so the dynamic import in
// the policy module returns our stub instead of hitting the real DB module) ─

type ValidateFn = (key: string) => boolean | Promise<boolean>;
let mockValidateApiKey: ValidateFn = () => false;

const originalResolve = (Module as unknown as { _resolveFilename: typeof Module._resolveFilename })
  ._resolveFilename;

// Intercept require() / import() resolution for the apiKeys DB module and
// substitute it for our stub. This runs only for the exact path the policy
// imports — production code paths are unaffected.
const POLICY_IMPORT_TARGET = "src/lib/db/apiKeys";

(Module as unknown as { _resolveFilename: typeof Module._resolveFilename })._resolveFilename =
  function patched(this: unknown, request: string, ...rest: unknown[]) {
    if (request.includes(POLICY_IMPORT_TARGET)) {
      // Resolve to a stub file we create below
      const stubPath = new URL("./__stub_apiKeys.mjs", import.meta.url).pathname;
      // @ts-expect-error - rest spread to original
      return originalResolve.call(this, stubPath, ...rest);
    }
    // @ts-expect-error - rest spread to original
    return originalResolve.call(this, request, ...rest);
  };

// Write the stub file ad-hoc (Node's loader needs a real file)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-clientapi-policy-fallback-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUB_PATH = path.join(__dirname, "__stub_apiKeys.mjs");
fs.writeFileSync(
  STUB_PATH,
  `export const validateApiKey = (key) => globalThis.__mockValidateApiKey(key);\n`
);

// Wire the stub to our local variable
(globalThis as unknown as { __mockValidateApiKey: ValidateFn }).__mockValidateApiKey = (key) =>
  mockValidateApiKey(key);

test.after(() => {
  try {
    fs.unlinkSync(STUB_PATH);
  } catch {
    /* ignore */
  }
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
});

// ─── Load policy fresh (after the interceptor is in place) ────────────────

async function loadPolicy() {
  const mod = await import(`../../../src/server/authz/policies/clientApi.ts?ts=${Date.now()}`);
  return mod.clientApiPolicy;
}

function ctx(headers: Headers, normalizedPath = "/api/v1/chat/completions") {
  return {
    request: { method: "POST", headers, url: `http://localhost${normalizedPath}` },
    classification: {
      routeClass: "CLIENT_API" as const,
      reason: "client_api_v1" as const,
      normalizedPath,
    },
    requestId: "req_test",
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

test.beforeEach(() => {
  // Default to "every key fails" — individual tests override as needed.
  mockValidateApiKey = () => false;
  delete process.env.REQUIRE_API_KEY;
});

test("#2257 — invalid bearer + REQUIRE_API_KEY=true → 401", async () => {
  process.env.REQUIRE_API_KEY = "true";
  const policy = await loadPolicy();
  const headers = new Headers({ authorization: "Bearer sk-stub-bogus" });
  const out = await policy.evaluate(ctx(headers));
  assert.equal(out.allow, false);
  if (!out.allow) {
    assert.equal(out.status, 401);
    assert.equal(out.code, "AUTH_002");
  }
});

test("#2257 — invalid bearer is rejected even when REQUIRE_API_KEY=false", async () => {
  process.env.REQUIRE_API_KEY = "false";
  const policy = await loadPolicy();
  const headers = new Headers({ authorization: "Bearer sk-stub-bogus" });
  const out = await policy.evaluate(ctx(headers));
  assert.equal(out.allow, false);
  if (!out.allow) {
    assert.equal(out.status, 401);
    assert.equal(out.code, "AUTH_002");
    assert.equal(out.message, "Invalid API key");
  }
});

test("#2257 — invalid x-api-key is rejected even when REQUIRE_API_KEY=false", async () => {
  process.env.REQUIRE_API_KEY = "false";
  const policy = await loadPolicy();
  const headers = new Headers({ "x-api-key": "sk-stub-bogus" });
  const out = await policy.evaluate(ctx(headers));
  assert.equal(out.allow, false);
  if (!out.allow) {
    assert.equal(out.status, 401);
    assert.equal(out.code, "AUTH_002");
    assert.equal(out.message, "Invalid API key");
  }
});

test("#2257 — invalid-key rejection does not log credential fragments", async () => {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (msg: string) => warnings.push(String(msg));
  try {
    const policy = await loadPolicy();
    const headers = new Headers({ "x-api-key": "sk-secretprefix-secretmiddle-XYZW" });
    const out = await policy.evaluate(ctx(headers));
    assert.equal(out.allow, false);
    assert.ok(
      warnings.every((w) => !w.includes("secretprefix") && !w.includes("secretmiddle")),
      "invalid-key rejection must not leak credentials"
    );
  } finally {
    console.warn = originalWarn;
  }
});

test("#2257 — missing key is rejected even when REQUIRE_API_KEY=false", async () => {
  process.env.REQUIRE_API_KEY = "false";
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (msg: string) => warnings.push(String(msg));
  try {
    const policy = await loadPolicy();
    const out = await policy.evaluate(ctx(new Headers()));
    assert.equal(out.allow, false);
    if (!out.allow) {
      assert.equal(out.status, 401);
      assert.equal(out.code, "AUTH_002");
      assert.equal(out.message, "Authentication required");
    }
    assert.ok(
      warnings.every((w) => !w.includes("[clientApiPolicy]")),
      "missing-key rejection should not emit fallback warnings"
    );
  } finally {
    console.warn = originalWarn;
  }
});

// ─── #3504 — non-usable Authorization must NOT short-circuit the URL path token ─
// VS Code Copilot sends its own (empty / non-OmniRoute) Authorization header even
// when the OmniRoute key lives in the URL path of a /vscode tokenized endpoint.
// A non-"Bearer <token>" Authorization must fall through to the URL token instead
// of returning null and 401'ing under REQUIRE_API_KEY=true.

// validateApiKey is the real (no-DB → always-false) implementation here, so we
// distinguish "URL token was extracted" from "no token found" by the rejection
// MESSAGE: an extracted-but-unknown token → "Invalid API key"; nothing extracted
// → "Authentication required". On the pre-fix code a non-Bearer Authorization
// returned null, so these would all 401 with "Authentication required".

test("#3504 — empty 'Bearer ' Authorization falls through to the URL path token", async () => {
  process.env.REQUIRE_API_KEY = "true";
  const policy = await loadPolicy();
  const headers = new Headers({ authorization: "Bearer " });
  const out = await policy.evaluate(ctx(headers, "/api/v1/vscode/sk-url-token/chat/completions"));
  assert.equal(out.allow, false);
  if (!out.allow) {
    assert.equal(out.status, 401);
    assert.equal(
      out.message,
      "Invalid API key",
      "URL token must be extracted (→ 'Invalid API key'), not skipped (→ 'Authentication required')"
    );
  }
});

test("#3504 — a non-Bearer scheme (Basic) also falls through to the URL token", async () => {
  process.env.REQUIRE_API_KEY = "true";
  const policy = await loadPolicy();
  const headers = new Headers({ authorization: "Basic Zm9vOmJhcg==" });
  const out = await policy.evaluate(ctx(headers, "/api/v1/vscode/sk-url-token/chat/completions"));
  assert.equal(out.allow, false);
  if (!out.allow) assert.equal(out.message, "Invalid API key");
});

test("#3504 — non-Bearer Authorization with NO URL token still rejects as unauthenticated", async () => {
  process.env.REQUIRE_API_KEY = "true";
  const policy = await loadPolicy();
  const headers = new Headers({ authorization: "Bearer " });
  const out = await policy.evaluate(ctx(headers, "/api/v1/chat/completions"));
  assert.equal(out.allow, false);
  if (!out.allow) assert.equal(out.message, "Authentication required");
});
