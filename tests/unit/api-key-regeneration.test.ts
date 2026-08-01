import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-apikey-regen-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-secret-regen";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");

const VALIDATION_RESULT_PREFIX = "API_KEY_VALIDATION_RESULT:";
const AUTH_GUARD_RESULT_PREFIX = "API_KEY_AUTH_GUARD_RESULT:";
const CHILD_VALIDATOR_SOURCE = `
import readline from "node:readline";

const { validateApiKey } = await import("./src/lib/db/apiKeys.ts");
const { enforceClientApiAuth } = await import("./src/app/api/v1/_helpers/clientApiAuth.ts");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of lines) {
  if (line === "validate") {
    const valid = await validateApiKey(process.env.TEST_API_KEY);
    process.stdout.write("${VALIDATION_RESULT_PREFIX}" + String(valid) + "\\n");
  }
  if (line === "enforce") {
    const request = new Request("http://localhost/api/v1/models", {
      headers: { authorization: "Bearer " + process.env.TEST_API_KEY },
    });
    const rejection = await enforceClientApiAuth(request);
    process.stdout.write("${AUTH_GUARD_RESULT_PREFIX}" + String(rejection?.status ?? 200) + "\\n");
  }
}
`;

function startValidatorProcess(apiKey: string) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx/esm", "--input-type=module", "--eval", CHILD_VALIDATOR_SOURCE],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATA_DIR: TEST_DATA_DIR,
        API_KEY_SECRET: "test-secret-regen",
        NODE_ENV: "test",
        TEST_API_KEY: apiKey,
      },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );

  const output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const results: Array<(valid: boolean) => void> = [];
  const authGuardResults: Array<(status: number) => void> = [];
  let stderr = "";

  output.on("line", (line) => {
    if (!line.startsWith(VALIDATION_RESULT_PREFIX)) return;
    results.shift()?.(line.slice(VALIDATION_RESULT_PREFIX.length) === "true");
  });
  output.on("line", (line) => {
    if (!line.startsWith(AUTH_GUARD_RESULT_PREFIX)) return;
    authGuardResults.shift()?.(Number(line.slice(AUTH_GUARD_RESULT_PREFIX.length)));
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  return {
    child,
    validate: () =>
      new Promise<boolean>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for validator process: ${stderr}`));
        }, 10_000);
        results.push((valid) => {
          clearTimeout(timeout);
          resolve(valid);
        });
        child.stdin.write("validate\n");
      }),
    enforce: () =>
      new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for auth guard process: ${stderr}`));
        }, 10_000);
        authGuardResults.push((status) => {
          clearTimeout(timeout);
          resolve(status);
        });
        child.stdin.write("enforce\n");
      }),
  };
}

async function stopValidatorProcess(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null) return;
  child.stdin.end();
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

function reset() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(() => {
  reset();
});

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("regenerateApiKey creates a new key and invalidates the old one", async () => {
  const machineId = "test-machine-regen";
  const created = await apiKeysDb.createApiKey("Regen Test", machineId);
  const oldKey = created.key;
  const oldId = created.id;

  assert.ok(oldKey);
  assert.equal(await apiKeysDb.validateApiKey(oldKey), true);

  // Regenerate
  const result = await apiKeysDb.regenerateApiKey(oldId);
  assert.ok(result?.key);
  const regenerated = result!.key;

  assert.notEqual(regenerated, oldKey);

  // New key should be valid
  assert.equal(await apiKeysDb.validateApiKey(regenerated), true);

  // Old key should be invalid
  assert.equal(await apiKeysDb.validateApiKey(oldKey), false);

  // Name and machineId should persist
  const md = await apiKeysDb.getApiKeyMetadata(regenerated);
  assert.equal(md?.name, "Regen Test");
  assert.ok(regenerated.startsWith(`sk-${machineId}-`));
});

test("regeneration invalidates an old key cached by another process", async () => {
  const created = await apiKeysDb.createApiKey("Cross-process Regen", "cross-process-machine");
  const validator = startValidatorProcess(created.key);

  try {
    assert.equal(await validator.validate(), true);

    const result = await apiKeysDb.regenerateApiKey(created.id);
    assert.ok(result?.key);

    assert.equal(await validator.validate(), false);
  } finally {
    await stopValidatorProcess(validator.child);
  }
});

test("direct route auth rejects an old key whose metadata was cached by another process", async () => {
  const created = await apiKeysDb.createApiKey("Cross-process Guard", "guard-machine");
  const validator = startValidatorProcess(created.key);

  try {
    assert.equal(await validator.enforce(), 200);

    const result = await apiKeysDb.regenerateApiKey(created.id);
    assert.ok(result?.key);

    assert.equal(await validator.enforce(), 401);
  } finally {
    await stopValidatorProcess(validator.child);
  }
});

test("regenerateApiKey returns null for non-existent ID", async () => {
  const result = await apiKeysDb.regenerateApiKey("00000000-0000-0000-0000-000000000000");
  assert.equal(result, null);
});
