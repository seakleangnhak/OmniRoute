/**
 * Regression guard: `open-sse/handlers/chatCore.ts` must transform/compile.
 *
 * `handleChatCore` declared `const settings` twice in the same function scope
 * (a "fetch once, reuse" const near the top + a duplicate added by the per-key
 * stream-default-mode feature). esbuild/tsx rejected it with
 * "The symbol 'settings' has already been declared", which turned EVERY test
 * that imports chatCore red and broke the production build.
 *
 * Importing the module forces the transform; if the duplicate declaration
 * returns, this import throws and the test fails loudly.
 */
import test from "node:test";
import assert from "node:assert/strict";

test("chatCore.ts imports without a duplicate-declaration transform error", async () => {
  const mod = await import("../../open-sse/handlers/chatCore.ts");
  assert.equal(
    typeof mod.handleChatCore,
    "function",
    "handleChatCore must be importable (no duplicate `const settings` in scope)"
  );
});

test("MiMo 403 skips the generic OAuth credential refresh path", async () => {
  const { shouldAttemptGenericCredentialRefresh } =
    await import("../../open-sse/handlers/chatCore.ts");

  assert.equal(shouldAttemptGenericCredentialRefresh({ provider: "mimocode", status: 403 }), false);
  assert.equal(shouldAttemptGenericCredentialRefresh({ provider: "mcode", status: 403 }), false);
  assert.equal(shouldAttemptGenericCredentialRefresh({ provider: "codex", status: 403 }), true);
});
