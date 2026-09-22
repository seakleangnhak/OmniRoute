import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempImage = await import("../../src/lib/images/tempImageFile.ts");
const tempImageRoute = await import("../../src/app/api/v1/images/temp/[id]/route.ts");
const { classifyRoute } = await import("../../src/server/authz/classify.ts");

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
let tempDir = "";

test.beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omniroute-image-temp-test-"));
  tempImage.__setTemporaryImageDirectoryForTesting(tempDir);
});

test.afterEach(async () => {
  tempImage.__setTemporaryImageDirectoryForTesting(null);
  await fs.rm(tempDir, { recursive: true, force: true });
});

test("materializeImageResponseUrls converts b64_json into a five-minute temp URL", async () => {
  const response = await tempImage.materializeImageResponseUrls(
    {
      created: 123,
      data: [{ b64_json: PNG_BYTES.toString("base64"), revised_prompt: "clean image" }],
    },
    "https://omni.example.test"
  );

  assert.equal(response.created, 123);
  assert.equal(response.data.length, 1);
  assert.equal(response.data[0].b64_json, undefined);
  assert.equal(response.data[0].revised_prompt, "clean image");
  assert.match(response.data[0].url ?? "", /^https:\/\/omni\.example\.test\/v1\/images\/temp\//);

  const id = new URL(response.data[0].url as string).pathname.split("/").pop();
  assert.ok(id);

  const stored = await tempImage.readTemporaryImage(id);
  assert.ok(stored);
  assert.equal(stored.mime, "image/png");
  assert.deepEqual(stored.bytes, PNG_BYTES);
  assert.ok(stored.expiresAt - Date.now() <= 5 * 60 * 1000);
  assert.ok(stored.expiresAt > Date.now());
});

test("temporary image route serves the file inline and removes it after expiry", async () => {
  const stored = await tempImage.storeTemporaryImageFromBase64(PNG_BYTES.toString("base64"), 5_000);

  const first = await tempImageRoute.GET(
    new Request(`http://localhost/v1/images/temp/${stored.id}`),
    { params: Promise.resolve({ id: stored.id }) }
  );

  assert.equal(first.status, 200);
  assert.equal(first.headers.get("content-type"), "image/png");
  assert.match(first.headers.get("content-disposition") ?? "", /^inline;/);
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), PNG_BYTES);

  const originalDateNow = Date.now;
  try {
    Date.now = () => stored.expiresAt + 1;
    const expired = await tempImageRoute.GET(
      new Request(`http://localhost/v1/images/temp/${stored.id}`),
      { params: Promise.resolve({ id: stored.id }) }
    );
    assert.equal(expired.status, 404);
    assert.deepEqual(await fs.readdir(tempDir), []);
  } finally {
    Date.now = originalDateNow;
  }
});

test("temporary image download URLs are public for browser viewing", () => {
  const classification = classifyRoute(
    "/v1/images/temp/0123456789abcdef0123456789abcdef-1790088116000",
    "GET"
  );
  assert.equal(classification.routeClass, "PUBLIC");
});
