import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-image-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "image-route-test-api-key-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const chatGptTls = await import("../../open-sse/services/chatgptTlsClient.ts");
const chatGptWeb = await import("../../open-sse/executors/chatgpt-web.ts");
const imageRoute = await import("../../src/app/api/v1/images/generations/route.ts");
const imageEditRoute = await import("../../src/app/api/v1/images/edits/route.ts");
const providerImageRoute =
  await import("../../src/app/api/v1/providers/[provider]/images/generations/route.ts");

const originalFetch = globalThis.fetch;
const originalRequireApiKey = process.env.REQUIRE_API_KEY;
const originalOmnirouteApiKey = process.env.OMNIROUTE_API_KEY;
const originalRouterApiKey = process.env.ROUTER_API_KEY;

type ErrorBody = { error?: { message?: string } };

async function resetStorage() {
  globalThis.fetch = originalFetch;
  chatGptTls.__setTlsFetchOverrideForTesting(null);
  chatGptWeb.__resetChatGptWebCachesForTesting();
  delete process.env.REQUIRE_API_KEY;
  delete process.env.OMNIROUTE_API_KEY;
  delete process.env.ROUTER_API_KEY;
  apiKeysDb.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function seedConnection(provider: string, overrides: { apiKey?: string | null } = {}) {
  return providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: `${provider}-${Math.random().toString(16).slice(2, 8)}`,
    apiKey: overrides.apiKey ?? "test-key",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
}

function makeHeaders(map: Record<string, string> = {}) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(map)) headers.set(key, value);
  return headers;
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  globalThis.fetch = originalFetch;
  apiKeysDb.resetApiKeyState();
  core.resetDbInstance();
  if (originalRequireApiKey === undefined) delete process.env.REQUIRE_API_KEY;
  else process.env.REQUIRE_API_KEY = originalRequireApiKey;
  if (originalOmnirouteApiKey === undefined) delete process.env.OMNIROUTE_API_KEY;
  else process.env.OMNIROUTE_API_KEY = originalOmnirouteApiKey;
  if (originalRouterApiKey === undefined) delete process.env.ROUTER_API_KEY;
  else process.env.ROUTER_API_KEY = originalRouterApiKey;
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("v1 image models GET exposes image-only modalities for image-only models", async () => {
  const response = await imageRoute.GET();
  const body = (await response.json()) as {
    data: Array<{ id: string; input_modalities?: string[] }>;
  };
  const byId = new Map(body.data.map((item: { id: string }) => [item.id, item]));

  assert.equal(response.status, 200);
  assert.deepEqual(byId.get("topaz/topaz-enhance")?.input_modalities, ["image"]);
  assert.deepEqual(byId.get("stability-ai/remove-background")?.input_modalities, ["image"]);
  assert.deepEqual(byId.get("stability-ai/fast")?.input_modalities, ["image"]);
});

test("v1 image generation POST accepts promptless requests for image-only models", async () => {
  await seedConnection("topaz", { apiKey: "topaz-key" });

  globalThis.fetch = async (url, options = {}) => {
    const stringUrl = String(url);
    if (stringUrl === "https://example.com/topaz-input.png") {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }

    if (stringUrl === "https://api.topazlabs.com/image/v1/enhance") {
      const formData = options.body as FormData;
      assert.ok(formData.get("image") instanceof File);
      return new Response(new Uint8Array([7, 7, 7]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }

    throw new Error(`Unexpected URL: ${stringUrl}`);
  };

  const response = await imageRoute.POST(
    new Request("http://localhost/api/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "topaz/topaz-enhance",
        image_url: "https://example.com/topaz-input.png",
        size: "2048x2048",
        response_format: "b64_json",
      }),
    })
  );
  const body = (await response.json()) as { data: Array<{ b64_json?: string }> };

  assert.equal(response.status, 200);
  assert.equal(body.data[0].b64_json, "BwcH");
});

test("v1 image generation POST accepts multipart image uploads for image-input models", async () => {
  await seedConnection("topaz", { apiKey: "topaz-key" });

  globalThis.fetch = async (url, options = {}) => {
    const stringUrl = String(url);
    if (stringUrl === "https://api.topazlabs.com/image/v1/enhance") {
      const upstreamForm = options.body as FormData;
      const upstreamImage = upstreamForm.get("image");
      assert.ok(upstreamImage instanceof File);
      assert.equal(upstreamImage.type, "image/png");
      assert.deepEqual(
        new Uint8Array(await upstreamImage.arrayBuffer()),
        new Uint8Array([1, 2, 3])
      );
      assert.equal(upstreamForm.get("output_width"), "2048");
      assert.equal(upstreamForm.get("output_height"), "2048");
      return new Response(new Uint8Array([7, 7, 7]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }

    throw new Error(`Unexpected URL: ${stringUrl}`);
  };

  const formData = new FormData();
  formData.set("model", "topaz/topaz-enhance");
  formData.set("size", "2048x2048");
  formData.set("response_format", "b64_json");
  formData.set("image", new File([new Uint8Array([1, 2, 3])], "source.png", { type: "image/png" }));

  const response = await imageRoute.POST(
    new Request("http://localhost/api/v1/images/generations", {
      method: "POST",
      body: formData,
    })
  );
  const body = (await response.json()) as { data: Array<{ b64_json?: string }> };

  assert.equal(response.status, 200);
  assert.equal(body.data[0].b64_json, "BwcH");
});

test("v1 image generation POST still requires prompts for text-input models", async () => {
  const response = await imageRoute.POST(
    new Request("http://localhost/api/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-image-2",
        image_url: "https://example.com/source.png",
      }),
    })
  );
  const body = (await response.json()) as ErrorBody;

  assert.equal(response.status, 400);
  assert.match(body.error.message, /Prompt is required for image model: openai\/gpt-image-2/);
});

test("v1 image generation POST rejects an unknown bearer before routing", async () => {
  const response = await imageRoute.POST(
    new Request("http://localhost/api/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: "Bearer sk-server-b-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-image-2",
        prompt: "server A should not accept server B key",
      }),
    })
  );
  const body = (await response.json()) as ErrorBody;

  assert.equal(response.status, 401);
  assert.match(body.error?.message || "", /Invalid API key/);
});

test("v1 image generation POST requires a bearer when REQUIRE_API_KEY is true", async () => {
  process.env.REQUIRE_API_KEY = "true";

  const response = await imageRoute.POST(
    new Request("http://localhost/api/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-image-2",
        prompt: "missing bearer",
      }),
    })
  );
  const body = (await response.json()) as ErrorBody;

  assert.equal(response.status, 401);
  assert.match(body.error?.message || "", /Authentication required/);
});

test("provider-scoped image generation POST rejects an unknown bearer", async () => {
  const response = await providerImageRoute.POST(
    new Request("http://localhost/api/v1/providers/openai/images/generations", {
      method: "POST",
      headers: {
        Authorization: "Bearer sk-server-b-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-image-2",
        prompt: "provider scoped auth guard",
      }),
    }),
    { params: Promise.resolve({ provider: "openai" }) }
  );
  const body = (await response.json()) as ErrorBody;

  assert.equal(response.status, 401);
  assert.match(body.error?.message || "", /Invalid API key/);
});

test("v1 image edit POST enforces disabled API key policy", async () => {
  const createdKey = await apiKeysDb.createApiKey("Disabled image edit key", "machine-image-edit");
  await apiKeysDb.updateApiKeyPermissions(createdKey.id, { isActive: false });

  const formData = new FormData();
  formData.set("prompt", "make the background lighter");
  formData.set("model", "cgpt-web/gpt-5.3-instant");
  formData.set("image", new File([new Uint8Array([1, 2, 3])], "source.png", { type: "image/png" }));

  const response = await imageEditRoute.POST(
    new Request("http://localhost/api/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${createdKey.key}` },
      body: formData,
    })
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 403);
  assert.match(body.error.message, /disabled/);
});

test("v1 image edit POST accepts cache_id instead of uploaded image", async () => {
  const formData = new FormData();
  formData.set("prompt", "make the background lighter");
  formData.set("model", "cgpt-web/gpt-5.3-instant");
  formData.set("cache_id", "0123456789abcdef0123456789abcdef");

  const response = await imageEditRoute.POST(
    new Request("http://localhost/api/v1/images/edits", {
      method: "POST",
      body: formData,
    })
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 401);
  assert.doesNotMatch(body.error.message, /Missing required field: image/);
  assert.match(body.error.message, /No credentials for provider: chatgpt-web/);
});

test("v1 image edit POST accepts JSON cache_id without multipart", async () => {
  const response = await imageEditRoute.POST(
    new Request("http://localhost/api/v1/images/edits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "make the background lighter",
        model: "cgpt-web/gpt-5.3-instant",
        cache_id: "0123456789abcdef0123456789abcdef",
        response_format: "url",
      }),
    })
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 401);
  assert.doesNotMatch(body.error.message, /Invalid multipart body/);
  assert.doesNotMatch(body.error.message, /Missing required field: image/);
  assert.match(body.error.message, /No credentials for provider: chatgpt-web/);
});

test("v1 image generation POST resolves proxy and executes with proxy context when credentials.connectionId exists", async () => {
  // Create a connection — it gets an auto-generated id used as credentials.connectionId
  const connection = await seedConnection("openai", { apiKey: "image-proxy-key" });

  // Set a key-level proxy for this specific connection (id = connectionId)
  await settingsDb.setProxyForLevel("key", (connection as any).id, {
    type: "http",
    host: "127.0.0.1",
    port: 1, // intentionally unreachable — proves proxy path was taken
  });

  globalThis.fetch = async () => {
    throw new Error("fetch should not be called — proxy fast-fail should trigger first");
  };

  const response = await imageRoute.POST(
    new Request("http://localhost/api/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-image-2",
        prompt: "proxy test image",
      }),
    })
  );

  assert.equal(response.status, 503);
  const body = (await response.json()) as any;
  assert.match(body.error.message, /unreachable/i);
});

test("v1 image generation POST executes directly when proxy resolution fails gracefully", async () => {
  const connection = await seedConnection("openai", { apiKey: "image-proxy-fail-key" });

  const db = core.getDbInstance();
  db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('proxyConfig', 'keys', 'corrupt-json')"
  ).run();

  globalThis.fetch = async (url) => {
    const stringUrl = String(url);
    if (stringUrl === "https://api.openai.com/v1/images/generations") {
      return new Response(
        JSON.stringify({ created: 123, data: [{ url: "https://cdn.example.com/proxy-fail.png" }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`Unexpected URL: ${stringUrl}`);
  };

  const response = await imageRoute.POST(
    new Request("http://localhost/api/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-image-2",
        prompt: "proxy failover image",
      }),
    })
  );

  const body = (await response.json()) as any;
  assert.equal(response.status, 200);
  assert.equal(body.data[0].url, "https://cdn.example.com/proxy-fail.png");
});

test("v1 image generation POST executes directly when credentials.connectionId is absent (authType: none)", async () => {
  globalThis.fetch = async (url) => {
    const stringUrl = String(url);
    if (stringUrl === "http://localhost:7860/sdapi/v1/txt2img") {
      return new Response(JSON.stringify({ images: ["YmFzZTY0LWltYWdl"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected URL: ${stringUrl}`);
  };

  const response = await imageRoute.POST(
    new Request("http://localhost/api/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sdwebui/stable-diffusion-v1-5",
        prompt: "no credentials test",
      }),
    })
  );

  const body = (await response.json()) as any;
  assert.equal(response.status, 200);
  assert.ok(body.data, "should have image data");
});

test("v1 image generation POST retries ChatGPT Web Sentinel blocks with another account", async () => {
  await seedConnection("chatgpt-web", { apiKey: "blocked-cookie" });
  await seedConnection("chatgpt-web", { apiKey: "good-cookie" });

  const sentinelCookies: string[] = [];
  const conversationCookies: string[] = [];
  const sseText = [
    {
      conversation_id: "conv-img-route",
      message: {
        id: "msg-img-route",
        author: { role: "assistant" },
        content: {
          content_type: "text",
          parts: [
            "![image](http://localhost/v1/chatgpt-web/image/0123456789abcdef0123456789abcdef)",
          ],
        },
        status: "finished_successfully",
      },
    },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
    .join("");

  chatGptTls.__setTlsFetchOverrideForTesting(async (url, options = {}) => {
    const stringUrl = String(url);
    const headers = (options.headers || {}) as Record<string, string>;
    const cookie = String(headers.Cookie || headers.cookie || "");

    if (stringUrl === "https://chatgpt.com/" || stringUrl === "https://chatgpt.com") {
      return {
        status: 200,
        headers: makeHeaders({ "content-type": "text/html" }),
        text: '<html data-build="prod-test"><script src="https://cdn.oaistatic.com/_next/static/chunks/main-test.js"></script></html>',
        body: null,
      };
    }

    if (stringUrl.includes("/api/auth/session")) {
      return {
        status: 200,
        headers: makeHeaders({ "content-type": "application/json" }),
        text: JSON.stringify({
          accessToken: cookie.includes("good-cookie") ? "jwt-good" : "jwt-blocked",
          expires: new Date(Date.now() + 3600_000).toISOString(),
          user: { id: cookie.includes("good-cookie") ? "user-good" : "user-blocked" },
        }),
        body: null,
      };
    }

    if (
      stringUrl.includes("/backend-api/me") ||
      stringUrl.includes("/backend-api/conversations?") ||
      stringUrl.includes("/backend-api/models?")
    ) {
      return {
        status: 200,
        headers: makeHeaders({ "content-type": "application/json" }),
        text: "{}",
        body: null,
      };
    }

    if (stringUrl.includes("/backend-api/sentinel/chat-requirements/prepare")) {
      sentinelCookies.push(cookie);
      if (cookie.includes("blocked-cookie")) {
        return {
          status: 403,
          headers: makeHeaders({ "content-type": "application/json" }),
          text: JSON.stringify({ error: "turnstile required" }),
          body: null,
        };
      }
      return {
        status: 200,
        headers: makeHeaders({ "content-type": "application/json" }),
        text: JSON.stringify({
          prepare_token: "prepare-good",
          proofofwork: { required: false },
        }),
        body: null,
      };
    }

    if (stringUrl.includes("/backend-api/sentinel/chat-requirements")) {
      return {
        status: 200,
        headers: makeHeaders({ "content-type": "application/json" }),
        text: JSON.stringify({ token: "requirements-good", proofofwork: { required: false } }),
        body: null,
      };
    }

    if (stringUrl.endsWith("/backend-api/f/conversation")) {
      conversationCookies.push(cookie);
      return {
        status: 200,
        headers: makeHeaders({ "content-type": "text/event-stream" }),
        text: `${sseText}data: [DONE]\r\n\r\n`,
        body: null,
      };
    }

    return {
      status: 404,
      headers: makeHeaders(),
      text: `Unexpected URL: ${stringUrl}`,
      body: null,
    };
  });

  const response = await imageRoute.POST(
    new Request("http://localhost/api/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "cgpt-web/gpt-5.3-instant",
        prompt: "make a stable retry image",
      }),
    })
  );
  const body = (await response.json()) as { data: Array<{ url?: string }> };

  assert.equal(response.status, 200);
  assert.equal(
    body.data[0].url,
    "http://localhost/v1/chatgpt-web/image/0123456789abcdef0123456789abcdef"
  );
  assert.ok(
    sentinelCookies.some((cookie) => cookie.includes("blocked-cookie")),
    "first account should hit Sentinel"
  );
  assert.ok(
    sentinelCookies.some((cookie) => cookie.includes("good-cookie")),
    "second account should be retried"
  );
  assert.deepEqual(
    conversationCookies.map((cookie) =>
      cookie.includes("good-cookie") ? "good-cookie" : "blocked-cookie"
    ),
    ["good-cookie"]
  );
});

test("shouldRetryImageGenerationWithNextAccount only retries ChatGPT Web account-scoped errors", () => {
  const credentials = { connectionId: "conn-1" };
  assert.equal(
    imageRoute.shouldRetryImageGenerationWithNextAccount(
      {
        success: false,
        status: 403,
        error: JSON.stringify({
          error: {
            message: "ChatGPT blocked the request (Sentinel/Turnstile required).",
            code: "SENTINEL_BLOCKED",
          },
        }),
      },
      { format: "chatgpt-web" },
      credentials
    ),
    true
  );
  assert.equal(
    imageRoute.shouldRetryImageGenerationWithNextAccount(
      { success: false, status: 403, error: "policy denied" },
      { format: "openai" },
      credentials
    ),
    false
  );
  assert.equal(
    imageRoute.shouldRetryImageGenerationWithNextAccount(
      { success: false, status: 400, error: "bad prompt" },
      { format: "chatgpt-web" },
      credentials
    ),
    false
  );
});
