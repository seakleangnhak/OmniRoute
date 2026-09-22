import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-9router-images-test-"));
process.env.DATA_DIR = testDataDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.API_KEY_SECRET = "9router-image-route-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const models = await import("../../src/lib/db/models.ts");
const keys = await import("../../src/lib/db/apiKeys.ts");
const { resolveImageBaseUrl, handleImageGeneration } =
  await import("../../open-sse/handlers/imageGeneration.ts");
const route = await import("../../src/app/api/v1/images/generations/route.ts");
const scopedRoute =
  await import("../../src/app/api/v1/providers/[provider]/images/generations/route.ts");
const tempImage = await import("../../src/lib/images/tempImageFile.ts");
const tempImageRoute = await import("../../src/app/api/v1/images/temp/[id]/route.ts");

const providerId = "openai-compatible-nine-router-test";
const baseUrl = "https://nine-router.example.test/v1";
const upstreamKey = "9router-upstream-test-key";
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0xff, 0xd9]);
const originalFetch = globalThis.fetch;
const gatewayEnvNames = [
  "OMNIROUTE_CODEX_IMAGE_CONNECTION_ID",
  "OMNIROUTE_CODEX_IMAGE_MODEL",
] as const;
const originalGatewayEnv = Object.fromEntries(
  gatewayEnvNames.map((name) => [name, process.env[name]])
);
let clientKey = "";

async function seedGateway(url = baseUrl) {
  await providers.createProviderNode({
    id: providerId,
    type: "openai-compatible",
    name: "9router Images",
    prefix: "nine-images",
    baseUrl: url,
    apiType: "chat-completions",
  });
  const connection = await providers.createProviderConnection({
    provider: providerId,
    name: "9router test connection",
    authType: "apikey",
    apiKey: upstreamKey,
    isActive: true,
    testStatus: "active",
    providerSpecificData: { baseUrl: url },
  });
  await models.addCustomModel(
    providerId,
    "cx/gpt-image-2.5",
    "Codex image model via 9router",
    "manual",
    "images-generations",
    ["images"]
  );
  clientKey = (await keys.createApiKey("Image test client", "image-test-machine")).key;
  return String(connection.id);
}

function imageRequest(body: Record<string, unknown> = {}, query = "", key = clientKey) {
  return new Request(`http://localhost/api/v1/images/generations${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: "nine-images/cx/gpt-image-2.5",
      prompt: "A cute cat wearing a hat",
      n: 1,
      ...body,
    }),
  });
}

function multipartImageRequest(entries: Record<string, string>, key = clientKey) {
  const formData = new FormData();
  for (const [name, value] of Object.entries(entries)) formData.set(name, value);
  return new Request("http://localhost/api/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: formData,
  });
}

test.beforeEach(() => {
  for (const name of gatewayEnvNames) delete process.env[name];
  globalThis.fetch = originalFetch;
  keys.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(testDataDir, { recursive: true, force: true });
  fs.mkdirSync(testDataDir, { recursive: true });
});

test.after(() => {
  for (const name of gatewayEnvNames) {
    if (originalGatewayEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalGatewayEnv[name];
  }
  globalThis.fetch = originalFetch;
  keys.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

test("custom image endpoint normalization preserves query parameters without duplicate paths", () => {
  const endpoint = `${baseUrl}/images/generations?response_format=binary`;
  assert.equal(resolveImageBaseUrl({ baseUrl: endpoint }, "https://fallback.test"), endpoint);
  assert.equal(
    resolveImageBaseUrl({ baseUrl: `${baseUrl}?tenant=test` }, "https://fallback.test"),
    `${baseUrl}/images/generations?tenant=test`
  );
  assert.equal(
    resolveImageBaseUrl({ baseUrl: endpoint }, "https://fallback.test", "edits"),
    `${baseUrl}/images/edits?response_format=binary`
  );
});

test("custom image routing preserves the nested Codex model and 9router image options", async () => {
  await seedGateway();
  let calls = 0;
  const options = {
    size: "auto",
    quality: "auto",
    background: "auto",
    image_detail: "low",
    output_format: "jpeg",
    image: "https://assets.example.test/reference.jpg",
  };
  globalThis.fetch = async (input, init) => {
    calls += 1;
    assert.equal(String(input), `${baseUrl}/images/generations`);
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${upstreamKey}`);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      model: "cx/gpt-image-2.5",
      prompt: "A cute cat wearing a hat",
      n: 1,
      ...options,
    });
    return Response.json({ created: 123, data: [{ b64_json: "dGVzdA==" }] });
  };
  const response = await route.POST(imageRequest({ ...options, internalRoutingHint: "drop-me" }));
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { created: 123, data: [{ b64_json: "dGVzdA==" }] });
  assert.equal(calls, 1);
});

test("image generations maps multipart image_url to 9router's image edit field", async () => {
  await seedGateway();
  const imageUrl = "https://assets.example.test/reference.jpg";
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), `${baseUrl}/images/generations`);
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${upstreamKey}`);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      model: "cx/gpt-image-2.5",
      prompt: "Remove the text from image",
      response_format: "url",
      n: 1,
      aspect_ratio: "16:9",
      image: imageUrl,
    });
    return Response.json({ created: 123, data: [{ url: "https://cdn.example.test/result.png" }] });
  };

  const response = await route.POST(
    multipartImageRequest({
      model: "nine-images/cx/gpt-image-2.5",
      response_format: "url",
      n: "1",
      aspect_ratio: "16:9",
      image_url: imageUrl,
      prompt: "Remove the text from image",
    })
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), {
    created: 123,
    data: [{ url: "https://cdn.example.test/result.png" }],
  });
});

test("URL response format stores 9router b64_json as a five-minute download URL", async () => {
  await seedGateway();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-9router-temp-image-"));
  tempImage.__setTemporaryImageDirectoryForTesting(tempDir);
  try {
    globalThis.fetch = async () =>
      Response.json({
        created: 123,
        data: [{ b64_json: Buffer.from(jpeg).toString("base64") }],
      });

    const response = await route.POST(imageRequest({ response_format: "url" }));
    assert.equal(response.status, 200, await response.clone().text());
    const payload = await response.json();
    assert.equal(payload.created, 123);
    assert.equal(payload.data[0].b64_json, undefined);
    assert.match(payload.data[0].url, /^http:\/\/localhost\/v1\/images\/temp\//);

    const id = new URL(payload.data[0].url).pathname.split("/").pop();
    assert.ok(id);
    const download = await tempImageRoute.GET(new Request(payload.data[0].url), {
      params: Promise.resolve({ id }),
    });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "image/jpeg");
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), jpeg);
  } finally {
    tempImage.__setTemporaryImageDirectoryForTesting(null);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("binary query forwards to 9router and returns the actual JPEG content type and bytes", async () => {
  await seedGateway();
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls += 1;
    assert.equal(String(input), `${baseUrl}/images/generations?response_format=binary`);
    assert.equal(JSON.parse(String(init?.body)).model, "cx/gpt-image-2.5");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${upstreamKey}`);
    return new Response(jpeg, { headers: { "Content-Type": "image/jpeg" } });
  };
  const response = await route.POST(
    imageRequest({ output_format: "jpeg" }, "?response_format=binary")
  );
  assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), jpeg);
  assert.equal(calls, 1);
});

test("a binary upstream response is normalized to OpenAI JSON for existing clients", async () => {
  await seedGateway(`${baseUrl}/images/generations?response_format=binary`);
  globalThis.fetch = async () => new Response(jpeg, { headers: { "Content-Type": "image/jpeg" } });
  const response = await route.POST(imageRequest());
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get("content-type") || "", /application\/json/);
  const payload = await response.json();
  assert.deepEqual(payload.data, [{ b64_json: Buffer.from(jpeg).toString("base64") }]);
  assert.equal(typeof payload.created, "number");
});

test("URL response format uses a data URL when the gateway returns image bytes", async () => {
  const result = await (async () => {
    globalThis.fetch = async () =>
      new Response(jpeg, { headers: { "Content-Type": "image/jpeg" } });
    return handleImageGeneration({
      body: { model: `${providerId}/cx/gpt-image-2.5`, prompt: "cat", response_format: "url" },
      resolvedProvider: providerId,
      credentials: { apiKey: upstreamKey, baseUrl },
      log: null,
    });
  })();
  assert.equal(result.success, true);
  assert.ok("data" in result);
  assert.deepEqual(result.data.data, [
    { url: `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}` },
  ]);
});

test("binary output rejects multi-image requests before contacting the provider", async () => {
  await seedGateway();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ data: [] });
  };
  const response = await route.POST(imageRequest({ n: 2 }, "?response_format=binary"));
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
  assert.match((await response.json()).error.message, /n.*1/);
});

test("invalid client keys cannot use the configured upstream key", async () => {
  await seedGateway();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(jpeg);
  };
  const response = await route.POST(
    imageRequest({}, "?response_format=binary", "invalid-client-key")
  );
  assert.equal(response.status, 401);
  assert.equal(calls, 0);
});

test("binary requests still return structured JSON for upstream errors", async () => {
  await seedGateway();
  globalThis.fetch = async () =>
    Response.json({ error: { message: "Image service unavailable" } }, { status: 503 });
  const response = await route.POST(imageRequest({}, "?response_format=binary"));
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.error.message, "Image service unavailable");
  assert.doesNotMatch(JSON.stringify(payload), /at \/|9router-upstream-test-key/);
});

test("empty and unsupported image responses fail instead of reporting a generated image", async () => {
  await seedGateway();
  for (const upstream of [
    new Response(new Uint8Array(), { headers: { "Content-Type": "image/jpeg" } }),
    new Response("<svg></svg>", { headers: { "Content-Type": "image/svg+xml" } }),
  ]) {
    globalThis.fetch = async () => upstream;
    const response = await route.POST(imageRequest({}, "?response_format=binary"));
    assert.equal(response.status, 502);
    assert.match(response.headers.get("content-type") || "", /application\/json/);
  }
});

test("response_format in the body also selects binary gateway output", async () => {
  await seedGateway();
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input)).searchParams.get("response_format"), "binary");
    assert.equal(JSON.parse(String(init?.body)).response_format, undefined);
    return new Response(jpeg, { headers: { "Content-Type": "image/jpeg" } });
  };
  const response = await route.POST(imageRequest({ response_format: "binary" }));
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), jpeg);
});

test("client cancellation reaches the upstream image request", async () => {
  const controller = new AbortController();
  let cancelled = false;
  globalThis.fetch = async (_input, init) => {
    const upstreamSignal = init?.signal;
    assert.ok(upstreamSignal);
    controller.abort();
    cancelled = upstreamSignal.aborted;
    throw new DOMException("The request was aborted", "AbortError");
  };
  const result = await handleImageGeneration({
    body: { model: `${providerId}/cx/gpt-image-2.5`, prompt: "cat" },
    resolvedProvider: providerId,
    credentials: { apiKey: upstreamKey, baseUrl },
    signal: controller.signal,
    log: null,
  });
  assert.equal(cancelled, true);
  assert.equal(result.success, false);
});

test("existing Codex model names route through the configured gateway without a client prefix change", async () => {
  process.env.OMNIROUTE_CODEX_IMAGE_CONNECTION_ID = await seedGateway();
  const receivedModels: string[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), `${baseUrl}/images/generations`);
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${upstreamKey}`);
    const body = JSON.parse(String(init?.body));
    receivedModels.push(body.model);
    assert.equal(body.image, "https://assets.example.test/reference.jpg");
    return new Response(jpeg, { headers: { "Content-Type": "image/jpeg" } });
  };
  for (const model of ["cx/gpt-image-2.5", "codex/gpt-image-2.5", "codex/gpt-5.6-sol"]) {
    const response = await route.POST(imageRequest({
      model,
      image: "https://assets.example.test/reference.jpg",
      response_format: "b64_json",
    }));
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual((await response.json()).data, [{ b64_json: Buffer.from(jpeg).toString("base64") }]);
  }
  assert.deepEqual(receivedModels, Array(3).fill("cx/gpt-image-2.5"));
});

test("existing provider-scoped Codex API shares gateway routing and binary responses", async () => {
  process.env.OMNIROUTE_CODEX_IMAGE_CONNECTION_ID = await seedGateway();
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), `${baseUrl}/images/generations?response_format=binary`);
    assert.equal(JSON.parse(String(init?.body)).model, "cx/gpt-image-2.5");
    return new Response(jpeg, { headers: { "Content-Type": "image/jpeg" } });
  };
  const response = await scopedRoute.POST(new Request(
    "http://localhost/api/v1/providers/codex/images/generations?response_format=binary",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${clientKey}` },
      body: JSON.stringify({ model: "gpt-image-2.5", prompt: "cat", n: 1 }),
    }
  ), { params: Promise.resolve({ provider: "codex" }) });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), jpeg);
});

test("gateway selection preserves client connection restrictions", async () => {
  process.env.OMNIROUTE_CODEX_IMAGE_CONNECTION_ID = await seedGateway();
  const restrictedKey = await keys.createApiKey("Restricted client", "image-test-machine", undefined, {
    allowedConnections: ["another-connection"],
  });
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json({ data: [] }); };
  const response = await route.POST(imageRequest({ model: "cx/gpt-image-2.5" }, "", restrictedKey.key));
  assert.equal(response.status, 403);
  assert.equal(calls, 0);
});

test("an invalid gateway setting fails closed rather than using native Codex credentials", async () => {
  await seedGateway();
  process.env.OMNIROUTE_CODEX_IMAGE_CONNECTION_ID = "missing-connection";
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json({ data: [] }); };
  const response = await route.POST(imageRequest({ model: "cx/gpt-image-2.5" }));
  assert.equal(response.status, 503);
  assert.equal(calls, 0);
  assert.doesNotMatch(await response.text(), /9router-upstream-test-key|at \/Users/);
});

test("gateway mapping is opt-in and leaves other custom image requests unchanged", async () => {
  const connectionId = await seedGateway();
  process.env.OMNIROUTE_CODEX_IMAGE_CONNECTION_ID = "missing-connection";
  globalThis.fetch = async () => Response.json({ created: 123, data: [{ b64_json: "dGVzdA==" }] });
  const customResponse = await route.POST(imageRequest());
  assert.equal(customResponse.status, 200);

  process.env.OMNIROUTE_CODEX_IMAGE_CONNECTION_ID = connectionId;
  process.env.OMNIROUTE_CODEX_IMAGE_MODEL = "cx/operator-selected-model";
  globalThis.fetch = async (_input, init) => {
    assert.equal(JSON.parse(String(init?.body)).model, "cx/operator-selected-model");
    return Response.json({ created: 123, data: [{ b64_json: "dGVzdA==" }] });
  };
  const response = await route.POST(imageRequest({ model: "codex/gpt-5.6-sol" }));
  assert.equal(response.status, 200, await response.clone().text());
});
