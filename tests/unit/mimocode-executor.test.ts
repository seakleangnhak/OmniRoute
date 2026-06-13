import { describe, it } from "node:test";
import assert from "node:assert";
import {
  MimocodeExecutor,
  MIMO_SYSTEM_MARKER,
  generateFingerprint,
  normalizeFingerprint,
} from "../../open-sse/executors/mimocode.ts";

const executor = new MimocodeExecutor();

describe("MimocodeExecutor", () => {
  it("generateFingerprint returns a 64-char hex string", () => {
    const fp = generateFingerprint();
    assert.match(fp, /^[0-9a-f]{64}$/);
  });

  it("generateFingerprint is deterministic", () => {
    assert.strictEqual(generateFingerprint(), generateFingerprint());
  });

  it("generateFingerprint with seed is deterministic", () => {
    assert.strictEqual(generateFingerprint("seed-a"), generateFingerprint("seed-a"));
  });

  it("generateFingerprint with different seeds differs", () => {
    assert.notStrictEqual(generateFingerprint("seed-a"), generateFingerprint("seed-b"));
  });

  it("normalizes saved account ids to official 64-char sha256 fingerprints", () => {
    assert.strictEqual(
      normalizeFingerprint("short-random-id"),
      generateFingerprint("short-random-id")
    );
    assert.match(normalizeFingerprint("short-random-id"), /^[0-9a-f]{64}$/);

    const existing = "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789";
    assert.strictEqual(normalizeFingerprint(existing), existing.toLowerCase());
  });

  it("buildUrl returns the free-ai chat endpoint", () => {
    const url = executor.buildUrl("mimo-auto", false);
    assert.ok(url.includes("/api/free-ai/openai/chat"));
    assert.ok(url.startsWith("https://"));
  });

  it("buildHeaders includes X-Mimo-Source and Content-Type", () => {
    const headers = (executor as any).buildHeaders({}, true);
    assert.strictEqual(headers["Content-Type"], "application/json");
    assert.strictEqual(headers["X-Mimo-Source"], "mimocode-cli-free");
    assert.strictEqual(
      headers["User-Agent"],
      "mimocode/local ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.11"
    );
  });

  it("buildHeaders includes session affinity from the selected connection", () => {
    const headers = (executor as any).buildHeaders({ connectionId: "conn-123" }, true);
    assert.strictEqual(headers["x-session-affinity"], "conn-123");
  });

  it("buildHeaders matches the official Accept header for streaming", () => {
    const headers = (executor as any).buildHeaders({}, true);
    assert.strictEqual(headers["Accept"], "*/*");
  });

  it("buildHeaders matches the official Accept header for non-streaming", () => {
    const headers = (executor as any).buildHeaders({}, false);
    assert.strictEqual(headers["Accept"], "*/*");
  });

  it("transformRequest strips model prefix", () => {
    const result = (executor as any).transformRequest(
      "mcode/mimo-auto",
      { model: "mcode/mimo-auto", messages: [{ role: "user", content: "hi" }] },
      false
    );
    assert.strictEqual(result.model, "mimo-auto");
    assert.strictEqual(result.max_tokens, 128000);
    assert.strictEqual(result.messages[0].role, "system");
    assert.ok(result.messages[0].content.includes(MIMO_SYSTEM_MARKER));
    assert.strictEqual(result.messages[1].role, "user");
  });

  it("transformRequest adds official streaming defaults", () => {
    const result = (executor as any).transformRequest(
      "mimo-auto",
      { model: "mimo-auto", messages: [{ role: "user", content: "hi" }], stream: true },
      true
    );
    assert.deepStrictEqual(result.stream_options, { include_usage: true });
    assert.strictEqual(result.max_tokens, 128000);
  });

  it("transformRequest clamps oversized max_tokens to MiMo output limit", () => {
    const result = (executor as any).transformRequest(
      "mimo-auto",
      {
        model: "mimo-auto",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 999999,
      },
      false
    );
    assert.strictEqual(result.max_tokens, 128000);
  });

  it("transformRequest passes model through when no prefix", () => {
    const result = (executor as any).transformRequest(
      "mimo-auto",
      { model: "mimo-auto", messages: [{ role: "user", content: "hi" }] },
      false
    );
    assert.strictEqual(result.model, "mimo-auto");
  });

  it("merges MiMoCode guidance into an existing system message", () => {
    const result = (executor as any).transformRequest(
      "mimo-auto",
      {
        model: "mimo-auto",
        messages: [
          { role: "system", content: "Stay with the task until it is complete." },
          { role: "user", content: "build the project" },
        ],
      },
      true
    );

    assert.strictEqual(result.messages.length, 2);
    assert.strictEqual(result.messages[0].role, "system");
    assert.ok(result.messages[0].content.includes(MIMO_SYSTEM_MARKER));
    assert.ok(
      result.messages[0].content.includes("continue tool calls until the work is complete")
    );
    assert.ok(result.messages[0].content.includes("Stay with the task until it is complete."));
    assert.strictEqual(result.messages[1].role, "user");
  });

  it("transformRequest does not duplicate the MiMoCode identity preamble", () => {
    const result = (executor as any).transformRequest(
      "mimo-auto",
      {
        model: "mimo-auto",
        messages: [
          {
            role: "system",
            content: MIMO_SYSTEM_MARKER,
          },
          { role: "user", content: "hi" },
        ],
      },
      false
    );

    assert.strictEqual(
      result.messages.filter(
        (message: any) => message.role === "system" && message.content.includes(MIMO_SYSTEM_MARKER)
      ).length,
      1
    );
    assert.ok(
      result.messages[0].content.includes("continue tool calls until the work is complete")
    );
  });

  it("returns 499 on pre-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    const result = await executor.execute({
      model: "mimo-auto",
      body: { messages: [{ role: "user", content: "hi" }], stream: false },
      stream: false,
      signal: controller.signal,
      credentials: {},
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });

    assert.strictEqual((result as any).response.status, 499);
  });

  it("is registered in executor index", async () => {
    const { getExecutor } = await import("../../open-sse/executors/index.ts");
    const exec = getExecutor("mimocode");
    assert.ok(exec instanceof MimocodeExecutor);
  });

  it("mcode alias works", async () => {
    const { getExecutor } = await import("../../open-sse/executors/index.ts");
    const exec = getExecutor("mcode");
    assert.ok(exec instanceof MimocodeExecutor);
    assert.strictEqual(exec, getExecutor("mimocode"));
  });
});

describe("mimocode multi-account", () => {
  it("executor has at least one account", () => {
    const accounts = (executor as any).getAccountsForCredentials({});
    assert.ok(Array.isArray(accounts));
    assert.ok(accounts.length >= 1);
  });

  it("each account has required fields", () => {
    const accounts = (executor as any).getAccountsForCredentials({});
    for (const acct of accounts) {
      assert.ok(typeof acct.fingerprint === "string");
      assert.ok(typeof acct.jwt === "string");
      assert.ok(typeof acct.expiresAt === "number");
      assert.ok(typeof acct.cooldownUntil === "number");
      assert.ok(typeof acct.consecutiveFails === "number");
    }
  });

  it("pickAccount returns an account", () => {
    const accounts = (executor as any).getAccountsForCredentials({});
    const acct = (executor as any).pickAccount(accounts, "default");
    assert.ok(acct);
    assert.ok(typeof acct.fingerprint === "string");
  });

  it("markCooldown increases consecutiveFails and sets cooldownUntil", () => {
    const acct = (executor as any).getAccountsForCredentials({})[0];
    const before = acct.consecutiveFails;
    (executor as any).markCooldown(acct);
    assert.strictEqual(acct.consecutiveFails, before + 1);
    assert.ok(acct.cooldownUntil > Date.now());
  });

  it("markSuccess resets consecutiveFails", () => {
    const acct = (executor as any).getAccountsForCredentials({})[0];
    acct.consecutiveFails = 5;
    (executor as any).markSuccess(acct);
    assert.strictEqual(acct.consecutiveFails, 0);
  });

  it("returns retry metadata without fetching upstream when all selected accounts are cooling", async () => {
    const coolingExecutor = new MimocodeExecutor();
    const accounts = (coolingExecutor as any).getAccountsForCredentials({
      connectionId: "connection-cooling",
      providerSpecificData: { fingerprints: ["fingerprint-cooling-a", "fingerprint-cooling-b"] },
    });
    const cooldownUntil = Date.now() + 7_500;
    for (const account of accounts) {
      account.cooldownUntil = cooldownUntil;
      account.consecutiveFails = 1;
    }

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response("unexpected", { status: 500 });
    };

    try {
      const result = await coolingExecutor.execute({
        model: "mimo-auto",
        body: { messages: [{ role: "user", content: "hi" }], stream: false },
        stream: false,
        credentials: {
          connectionId: "connection-cooling",
          providerSpecificData: {
            fingerprints: ["fingerprint-cooling-a", "fingerprint-cooling-b"],
          },
        },
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      });

      assert.strictEqual(fetchCalls, 0);
      assert.strictEqual(result.response.status, 429);
      assert.ok(Number(result.response.headers.get("Retry-After")) >= 1);
      const body = (await result.response.json()) as {
        error: { code: string; retry_after: number; retry_after_ms: number };
      };
      assert.strictEqual(body.error.code, "ACCOUNTS_COOLING_DOWN");
      assert.ok(body.error.retry_after >= 1);
      assert.ok(body.error.retry_after_ms > 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps selected connections isolated from fingerprints on other connections", () => {
    const isolatedExecutor = new MimocodeExecutor();
    const first = (isolatedExecutor as any).getAccountsForCredentials({
      connectionId: "connection-a",
      providerSpecificData: { fingerprints: ["fingerprint-a"] },
    });
    const second = (isolatedExecutor as any).getAccountsForCredentials({
      connectionId: "connection-b",
      providerSpecificData: { fingerprints: ["fingerprint-b"] },
    });

    assert.deepStrictEqual(
      first.map((account: any) => account.fingerprint),
      [generateFingerprint("fingerprint-a")]
    );
    assert.deepStrictEqual(
      second.map((account: any) => account.fingerprint),
      [generateFingerprint("fingerprint-b")]
    );
  });

  it("round-robins legacy fingerprints even when the first account already has a JWT", () => {
    const legacyExecutor = new MimocodeExecutor();
    const accounts = (legacyExecutor as any).getAccountsForCredentials({
      connectionId: "legacy-connection",
      providerSpecificData: { fingerprints: ["fingerprint-a", "fingerprint-b"] },
    });
    accounts[0].jwt = "cached-jwt";
    accounts[0].expiresAt = Date.now() + 60 * 60 * 1000;

    const first = (legacyExecutor as any).pickAccount(accounts, "legacy-connection");
    const second = (legacyExecutor as any).pickAccount(accounts, "legacy-connection");

    assert.strictEqual(first.fingerprint, generateFingerprint("fingerprint-a"));
    assert.strictEqual(second.fingerprint, generateFingerprint("fingerprint-b"));
  });

  it("bootstraps with normalized fingerprints and official free-source headers", async () => {
    const officialShapeExecutor = new MimocodeExecutor();
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/api/free-ai/bootstrap")) {
        return new Response(JSON.stringify({ jwt: "test-jwt" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      const result = await officialShapeExecutor.execute({
        model: "mimocode/mimo-auto",
        body: { messages: [{ role: "user", content: "hi" }], stream: false },
        stream: false,
        credentials: {
          connectionId: "connection-official-shape",
          providerSpecificData: { fingerprints: ["short-random-id"] },
        },
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      });

      assert.strictEqual(result.response.status, 200);
      assert.strictEqual(calls.length, 2);
      assert.deepStrictEqual(JSON.parse(String(calls[0].init.body)), {
        client: generateFingerprint("short-random-id"),
      });
      const bootstrapHeaders = calls[0].init.headers as Record<string, string>;
      assert.strictEqual(bootstrapHeaders.Accept, "*/*");
      assert.strictEqual(bootstrapHeaders["User-Agent"], "Bun/1.3.11");
      const chatHeaders = calls[1].init.headers as Record<string, string>;
      assert.strictEqual(chatHeaders.Authorization, "Bearer test-jwt");
      assert.strictEqual(chatHeaders["X-Mimo-Source"], "mimocode-cli-free");
      assert.strictEqual(chatHeaders.Accept, "*/*");
      assert.strictEqual(
        chatHeaders["User-Agent"],
        "mimocode/local ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.11"
      );
      assert.strictEqual(chatHeaders["x-session-affinity"], "connection-official-shape");
      const chatBody = JSON.parse(String(calls[1].init.body));
      assert.strictEqual(chatBody.max_tokens, 128000);
      assert.strictEqual(chatBody.messages[0].role, "system");
      assert.ok(chatBody.messages[0].content.includes(MIMO_SYSTEM_MARKER));
      assert.strictEqual(chatBody.messages[1].role, "user");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("auto-continues reasoning-only streaming stops before returning to the caller", async () => {
    const autoContinueExecutor = new MimocodeExecutor();
    const originalFetch = globalThis.fetch;
    const chatBodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).includes("/api/free-ai/bootstrap")) {
        return new Response(JSON.stringify({ jwt: "test-jwt" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      chatBodies.push(
        JSON.parse(String(init.body)) as { messages: Array<Record<string, unknown>> }
      );
      if (chatBodies.length === 1) {
        return new Response(
          [
            'data: {"id":"chatcmpl_1","choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning_content":null},"finish_reason":null}]}',
            'data: {"id":"chatcmpl_1","choices":[{"index":0,"delta":{"reasoning_content":"I should keep working."},"finish_reason":null}]}',
            'data: {"id":"chatcmpl_1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        );
      }

      return new Response(
        [
          'data: {"id":"chatcmpl_2","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
          'data: {"id":"chatcmpl_2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"exec_command","arguments":"{}"}}]},"finish_reason":null}]}',
          'data: {"id":"chatcmpl_2","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    };

    try {
      const result = await autoContinueExecutor.execute({
        model: "mimo-auto",
        body: {
          messages: [{ role: "user", content: "finish the task" }],
          tools: [{ type: "function", function: { name: "exec_command", parameters: {} } }],
          stream: true,
        },
        stream: true,
        credentials: {
          connectionId: "connection-auto-continue",
          providerSpecificData: { fingerprints: ["fingerprint-auto-continue"] },
        },
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      });

      assert.strictEqual(result.response.status, 200);
      assert.strictEqual(chatBodies.length, 2);
      assert.match(
        String(chatBodies[1].messages.at(-2)?.reasoning_content),
        /I should keep working/
      );
      assert.ok(
        String(chatBodies[1].messages.at(-1)?.content).includes(
          "stopped before making actionable progress"
        )
      );
      const text = await result.response.text();
      assert.ok(text.includes('"tool_calls"'));
      assert.ok(!text.includes("I should keep working."));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("auto-continues repeated reasoning-only progress stops until a tool call", async () => {
    const autoContinueExecutor = new MimocodeExecutor();
    const originalFetch = globalThis.fetch;
    const chatBodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).includes("/api/free-ai/bootstrap")) {
        return new Response(JSON.stringify({ jwt: "test-jwt" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      chatBodies.push(
        JSON.parse(String(init.body)) as { messages: Array<Record<string, unknown>> }
      );
      if (chatBodies.length <= 4) {
        return new Response(
          [
            `data: {"id":"chatcmpl_${chatBodies.length}","choices":[{"index":0,"delta":{"reasoning_content":"Now let me continue building the remaining files."},"finish_reason":null}]}`,
            `data: {"id":"chatcmpl_${chatBodies.length}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        );
      }

      return new Response(
        [
          'data: {"id":"chatcmpl_tool","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"exec_command","arguments":"{}"}}]},"finish_reason":null}]}',
          'data: {"id":"chatcmpl_tool","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    };

    try {
      const result = await autoContinueExecutor.execute({
        model: "mimo-auto",
        body: {
          messages: [{ role: "user", content: "build the full project" }],
          tools: [{ type: "function", function: { name: "exec_command", parameters: {} } }],
          stream: true,
        },
        stream: true,
        credentials: {
          connectionId: "connection-repeated-auto-continue",
          providerSpecificData: { fingerprints: ["fingerprint-repeated-auto-continue"] },
        },
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      });

      assert.strictEqual(result.response.status, 200);
      assert.strictEqual(chatBodies.length, 5);
      assert.ok(
        String(chatBodies.at(-1)?.messages.at(-1)?.content).includes(
          "stopped before making actionable progress"
        )
      );
      const text = await result.response.text();
      assert.ok(text.includes('"tool_calls"'));
      assert.ok(!text.includes("Now let me continue building"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("auto-continues visible progress-only stops before returning", async () => {
    const autoContinueExecutor = new MimocodeExecutor();
    const originalFetch = globalThis.fetch;
    const chatBodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).includes("/api/free-ai/bootstrap")) {
        return new Response(JSON.stringify({ jwt: "test-jwt" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      chatBodies.push(
        JSON.parse(String(init.body)) as { messages: Array<Record<string, unknown>> }
      );
      if (chatBodies.length === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: { role: "assistant", content: "Now let me run the full build:" },
                finish_reason: "stop",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: "Build completed successfully." },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    try {
      const result = await autoContinueExecutor.execute({
        model: "mimo-auto",
        body: {
          messages: [{ role: "user", content: "build the full project" }],
          tools: [{ type: "function", function: { name: "exec_command", parameters: {} } }],
          stream: false,
        },
        stream: false,
        credentials: {
          connectionId: "connection-visible-auto-continue",
          providerSpecificData: { fingerprints: ["fingerprint-visible-auto-continue"] },
        },
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      });

      assert.strictEqual(result.response.status, 200);
      assert.strictEqual(chatBodies.length, 2);
      const text = await result.response.text();
      assert.ok(text.includes("Build completed successfully."));
      assert.ok(!text.includes("Now let me run the full build"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("auto-continues a premature build-success wrap-up from the VPS log", async () => {
    const autoContinueExecutor = new MimocodeExecutor();
    const originalFetch = globalThis.fetch;
    const chatBodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).includes("/api/free-ai/bootstrap")) {
        return new Response(JSON.stringify({ jwt: "test-jwt" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      chatBodies.push(
        JSON.parse(String(init.body)) as { messages: Array<Record<string, unknown>> }
      );
      if (chatBodies.length === 1) {
        return new Response(
          [
            'data: {"id":"chatcmpl_wrapup","choices":[{"index":0,"delta":{"reasoning_content":"Build passes. Let me update the plan."},"finish_reason":null}]}',
            'data: {"id":"chatcmpl_wrapup","choices":[{"index":0,"delta":{"content":"Build passes! The large chunk warning is expected since Phaser is a large library. Let me update the plan and provide the final summary."},"finish_reason":null}]}',
            'data: {"id":"chatcmpl_wrapup","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        );
      }

      return new Response(
        [
          'data: {"id":"chatcmpl_tool","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_review","type":"function","function":{"name":"exec_command","arguments":"{\\"cmd\\":\\"npm run test\\"}"}}]},"finish_reason":null}]}',
          'data: {"id":"chatcmpl_tool","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    };

    try {
      const result = await autoContinueExecutor.execute({
        model: "mimo-auto",
        body: {
          messages: [{ role: "user", content: "finish implementing the full project" }],
          tools: [{ type: "function", function: { name: "exec_command", parameters: {} } }],
          stream: true,
        },
        stream: true,
        credentials: {
          connectionId: "connection-premature-wrapup",
          providerSpecificData: { fingerprints: ["fingerprint-premature-wrapup"] },
        },
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      });

      assert.strictEqual(result.response.status, 200);
      assert.strictEqual(chatBodies.length, 2);
      assert.match(
        String(chatBodies[1].messages.at(-2)?.content),
        /Let me update the plan and provide the final summary/
      );
      const text = await result.response.text();
      assert.ok(text.includes('"name":"exec_command"'));
      assert.ok(!text.includes("The large chunk warning is expected"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("auto-continues pseudo-final progress blocks from the TestMiMo log", async () => {
    const autoContinueExecutor = new MimocodeExecutor();
    const originalFetch = globalThis.fetch;
    const chatBodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).includes("/api/free-ai/bootstrap")) {
        return new Response(JSON.stringify({ jwt: "test-jwt" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      chatBodies.push(
        JSON.parse(String(init.body)) as { messages: Array<Record<string, unknown>> }
      );
      if (chatBodies.length === 1) {
        return new Response(
          [
            'data: {"id":"chatcmpl_mimo_progress","choices":[{"index":0,"delta":{"reasoning_content":"The user wants me to implement the full game. Let me continue building all the remaining files systematically."},"finish_reason":null}]}',
            'data: {"id":"chatcmpl_mimo_progress","choices":[{"index":0,"delta":{"content":"I\'m continuing to build all the game files. I\'ve started with the foundational files."},"finish_reason":null}]}',
            'data: {"id":"chatcmpl_mimo_progress","choices":[{"index":0,"delta":{"content":"\\n\\n<final>\\n\\nI\'m continuing through the remaining ~35 files in dependency order. The implementation will complete all phases: engine -> dungeon -> entities -> systems -> rendering -> UI -> audio -> data -> entry point.\\n\\n</final>"},"finish_reason":null}]}',
            'data: {"id":"chatcmpl_mimo_progress","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        );
      }

      return new Response(
        [
          'data: {"id":"chatcmpl_mimo_tool","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_continue","type":"function","function":{"name":"exec_command","arguments":"{\\"cmd\\":\\"rg --files /Users/seakleang/WorkPlace/personal/TestMiMo\\"}"}}]},"finish_reason":null}]}',
          'data: {"id":"chatcmpl_mimo_tool","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    };

    try {
      const result = await autoContinueExecutor.execute({
        model: "mimo-auto",
        body: {
          messages: [{ role: "user", content: "finish implementing the full project" }],
          tools: [{ type: "function", function: { name: "exec_command", parameters: {} } }],
          stream: true,
        },
        stream: true,
        credentials: {
          connectionId: "connection-mimo-pseudo-final",
          providerSpecificData: { fingerprints: ["fingerprint-mimo-pseudo-final"] },
        },
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      });

      assert.strictEqual(result.response.status, 200);
      assert.strictEqual(chatBodies.length, 2);
      assert.match(
        String(chatBodies[1].messages.at(-2)?.content),
        /remaining ~35 files in dependency order/
      );
      assert.ok(
        String(chatBodies[1].messages.at(-1)?.content).includes(
          "stopped before making actionable progress"
        )
      );
      const text = await result.response.text();
      assert.ok(text.includes('"name":"exec_command"'));
      assert.ok(!text.includes("remaining ~35 files in dependency order"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns a real final summary without auto-continuing it", async () => {
    const completedExecutor = new MimocodeExecutor();
    const originalFetch = globalThis.fetch;
    let chatCalls = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes("/api/free-ai/bootstrap")) {
        return new Response(JSON.stringify({ jwt: "test-jwt" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      chatCalls++;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content:
                  "Summary: implemented the requested game systems and verified the production build. How to run: npm run dev. Known limitations: none.",
              },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    try {
      const result = await completedExecutor.execute({
        model: "mimo-auto",
        body: {
          messages: [{ role: "user", content: "finish implementing the full project" }],
          tools: [{ type: "function", function: { name: "exec_command", parameters: {} } }],
          stream: false,
        },
        stream: false,
        credentials: {
          connectionId: "connection-complete-summary",
          providerSpecificData: { fingerprints: ["fingerprint-complete-summary"] },
        },
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      });

      assert.strictEqual(result.response.status, 200);
      assert.strictEqual(chatCalls, 1);
      assert.match(await result.response.text(), /How to run: npm run dev/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("auto-continues all three streaming progress stops from the VPS log", async () => {
    const autoContinueExecutor = new MimocodeExecutor();
    const originalFetch = globalThis.fetch;
    const chatBodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
    const progressStops = [
      {
        reasoning: ["Now let me update ", "the App.tsx and create the CSS files."],
        content: ["Now ", "update App.tsx and create the styles."],
      },
      {
        reasoning: ["Now let me fix the component files too."],
        content: ["Now fix the React components."],
      },
      {
        reasoning: ["Now let me fix the remaining issues in engine.ts."],
        content: ["Now fix the remaining unused imports and issues."],
      },
    ];
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).includes("/api/free-ai/bootstrap")) {
        return new Response(JSON.stringify({ jwt: "test-jwt" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      chatBodies.push(
        JSON.parse(String(init.body)) as { messages: Array<Record<string, unknown>> }
      );
      const progressStop = progressStops[chatBodies.length - 1];
      if (progressStop) {
        return new Response(
          [
            ...progressStop.reasoning.map(
              (text) =>
                `data: ${JSON.stringify({
                  id: "chatcmpl_stall",
                  choices: [
                    {
                      index: 0,
                      delta: { reasoning_content: text },
                      finish_reason: null,
                    },
                  ],
                })}`
            ),
            ...progressStop.content.map(
              (text) =>
                `data: ${JSON.stringify({
                  id: "chatcmpl_stall",
                  choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
                })}`
            ),
            'data: {"id":"chatcmpl_stall","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        );
      }

      return new Response(
        [
          'data: {"id":"chatcmpl_tool","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_fix","type":"function","function":{"name":"exec_command","arguments":"{\\"cmd\\":\\"npm run build\\"}"}}]},"finish_reason":null}]}',
          'data: {"id":"chatcmpl_tool","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    };

    try {
      const result = await autoContinueExecutor.execute({
        model: "mimo-auto",
        body: {
          messages: [{ role: "user", content: "finish the implementation" }],
          tools: [{ type: "function", function: { name: "exec_command", parameters: {} } }],
          stream: true,
        },
        stream: true,
        credentials: {
          connectionId: "connection-vps-progress-stop",
          providerSpecificData: { fingerprints: ["fingerprint-vps-progress-stop"] },
        },
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      });

      assert.strictEqual(result.response.status, 200);
      assert.strictEqual(chatBodies.length, 4);
      assert.strictEqual(
        chatBodies[1].messages.at(-2)?.content,
        "Now update App.tsx and create the styles."
      );
      assert.strictEqual(
        chatBodies[1].messages.at(-2)?.reasoning_content,
        "Now let me update the App.tsx and create the CSS files."
      );
      assert.strictEqual(chatBodies[2].messages.at(-2)?.content, "Now fix the React components.");
      assert.strictEqual(
        chatBodies[3].messages.at(-2)?.content,
        "Now fix the remaining unused imports and issues."
      );
      const text = await result.response.text();
      assert.ok(text.includes('"name":"exec_command"'));
      assert.ok(!text.includes("Now update App.tsx"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces invalid output after MiMo-Code continuation retries are exhausted", async () => {
    const invalidOutputExecutor = new MimocodeExecutor();
    const originalFetch = globalThis.fetch;
    let chatCalls = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes("/api/free-ai/bootstrap")) {
        return new Response(JSON.stringify({ jwt: "test-jwt" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      chatCalls++;
      return new Response(
        [
          'data: {"id":"chatcmpl_invalid","choices":[{"index":0,"delta":{"reasoning_content":"still only thinking"},"finish_reason":null}]}',
          'data: {"id":"chatcmpl_invalid","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    };

    try {
      const result = await invalidOutputExecutor.execute({
        model: "mimo-auto",
        body: { messages: [{ role: "user", content: "finish the task" }], stream: true },
        stream: true,
        credentials: {
          connectionId: "connection-invalid-output",
          providerSpecificData: { fingerprints: ["fingerprint-invalid-output"] },
        },
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      });

      assert.strictEqual(chatCalls, 7);
      assert.strictEqual(result.response.status, 502);
      assert.match(await result.response.text(), /INVALID_OUTPUT/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves bootstrap 429 status instead of wrapping it as 502", async () => {
    const rateLimitedExecutor = new MimocodeExecutor();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: { code: "429", message: "Too many requests", type: "limitation" },
        }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      );

    try {
      const result = await rateLimitedExecutor.execute({
        model: "mimo-auto",
        body: { messages: [{ role: "user", content: "hi" }], stream: false },
        stream: false,
        credentials: {
          connectionId: "connection-rate-limited",
          providerSpecificData: { fingerprints: ["fingerprint-rate-limited"] },
        },
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      });

      assert.strictEqual(result.response.status, 429);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not re-bootstrap when MiMo chat returns illegal_access", async () => {
    const illegalAccessExecutor = new MimocodeExecutor();
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/api/free-ai/bootstrap")) {
        return new Response(JSON.stringify({ jwt: "test-jwt" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(
        JSON.stringify({
          error: {
            code: "403",
            message: "Illegal access",
            type: "illegal_access",
          },
        }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    };

    try {
      const result = await illegalAccessExecutor.execute({
        model: "mimo-auto",
        body: { messages: [{ role: "user", content: "hi" }], stream: false },
        stream: false,
        credentials: {
          connectionId: "connection-illegal-access",
          providerSpecificData: { fingerprints: ["fingerprint-illegal-access"] },
        },
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      });

      assert.strictEqual(calls.length, 2);
      assert.strictEqual(calls.filter((call) => call.url.includes("/bootstrap")).length, 1);
      assert.strictEqual(result.response.status, 403);
      const body = (await result.response.json()) as {
        error: { code: string; type: string };
      };
      assert.strictEqual(body.error.code, "MIMOCODE_ILLEGAL_ACCESS");
      assert.strictEqual(body.error.type, "illegal_access");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("still re-bootstraps once for non-illegal MiMo auth failures", async () => {
    const authRetryExecutor = new MimocodeExecutor();
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/api/free-ai/bootstrap")) {
        return new Response(JSON.stringify({ jwt: `test-jwt-${calls.length}` }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (calls.filter((call) => call.url.includes("/chat")).length === 1) {
        return new Response(
          JSON.stringify({
            error: {
              code: "403",
              message: "Token expired",
              type: "auth_error",
            },
          }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      const result = await authRetryExecutor.execute({
        model: "mimo-auto",
        body: { messages: [{ role: "user", content: "hi" }], stream: false },
        stream: false,
        credentials: {
          connectionId: "connection-auth-retry",
          providerSpecificData: { fingerprints: ["fingerprint-auth-retry"] },
        },
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      });

      assert.strictEqual(result.response.status, 200);
      assert.strictEqual(calls.filter((call) => call.url.includes("/bootstrap")).length, 2);
      assert.strictEqual(calls.filter((call) => call.url.includes("/chat")).length, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("maps in-flight aborts to 499 instead of 502", async () => {
    const abortedExecutor = new MimocodeExecutor();
    const controller = new AbortController();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      controller.abort();
      throw new DOMException("This operation was aborted", "AbortError");
    };

    try {
      const result = await abortedExecutor.execute({
        model: "mimo-auto",
        body: { messages: [{ role: "user", content: "hi" }], stream: false },
        stream: false,
        signal: controller.signal,
        credentials: {
          connectionId: "connection-aborted",
          providerSpecificData: { fingerprints: ["fingerprint-aborted"] },
        },
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      });

      assert.strictEqual(result.response.status, 499);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("mimocode provider registration", () => {
  it("provider is registered in NOAUTH_PROVIDERS", async () => {
    const { NOAUTH_PROVIDERS } = await import("../../src/shared/constants/providers.ts");
    const provider = (NOAUTH_PROVIDERS as Record<string, any>)["mimocode"];
    assert.ok(provider);
    assert.strictEqual(provider.id, "mimocode");
    assert.strictEqual(provider.alias, "mcode");
    assert.strictEqual(provider.noAuth, true);
    assert.strictEqual(provider.hasFree, true);
  });

  it("provider has correct service kinds", async () => {
    const { NOAUTH_PROVIDERS } = await import("../../src/shared/constants/providers.ts");
    const provider = (NOAUTH_PROVIDERS as Record<string, any>)["mimocode"];
    assert.ok(provider.serviceKinds?.includes("llm"));
  });
});

describe("mimocode providerRegistry entry", () => {
  it("registry entry exists with correct executor", async () => {
    const { getRegistryEntry } = await import("../../open-sse/config/providerRegistry.ts");
    const entry = getRegistryEntry("mimocode");
    assert.ok(entry);
    assert.strictEqual(entry.executor, "mimocode");
    assert.strictEqual(entry.format, "openai");
    assert.strictEqual(entry.authType, "none");
  });

  it("registry entry has mimo-auto model", async () => {
    const { getRegistryEntry } = await import("../../open-sse/config/providerRegistry.ts");
    const entry = getRegistryEntry("mimocode");
    const models = entry.models as Array<{
      id: string;
      supportsReasoning?: boolean;
      interleavedField?: string;
    }>;
    const mimoAuto = models.find((m) => m.id === "mimo-auto");
    assert.ok(mimoAuto);
    assert.strictEqual(mimoAuto.supportsReasoning, true);
    assert.strictEqual(mimoAuto.interleavedField, "reasoning_content");
  });
});
