/**
 * MiMoCode Executor — Free-tier Xiaomi MiMo models via bootstrap JWT auth.
 *
 * Implements the auth flow from the official MiMo-Code repository:
 *   https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/opencode/src/plugin/mimo-free.ts
 *
 *   1. Generate device fingerprint from hostname + OS + arch + CPU + username
 *   2. POST /api/free-ai/bootstrap with fingerprint → JWT
 *   3. Use JWT as Bearer token for chat requests
 *   4. Custom endpoint: /api/free-ai/openai/chat (not /v1/chat/completions)
 *   5. Custom header: X-Mimo-Source: mimocode-cli-free
 *
 * Only the "mimo-auto" model is supported (1M context, 128K output).
 * Supports multiple accounts: N fingerprints → N JWTs → round-robin with cooldown.
 * On 429, account enters cooldown (exponential backoff). On 401/403 auth failures,
 * JWT is re-bootstrapped. MiMo's 403 illegal_access is upstream access control, so
 * it skips the same-account token refresh and falls back/cools down instead.
 */

import * as crypto from "node:crypto";
import * as os from "node:os";
import {
  BaseExecutor,
  applyConfiguredUserAgent,
  setUserAgentHeader,
  type ExecuteInput,
  type ProviderCredentials,
} from "./base.ts";
import { sanitizeErrorMessage } from "../utils/error.ts";

const BOOTSTRAP_PATH = "/api/free-ai/bootstrap";
const CHAT_PATH = "/api/free-ai/openai/chat";
const JWT_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const BOOTSTRAP_TIMEOUT_MS = 15_000;
const COOLDOWN_BASE_MS = 5_000;
const COOLDOWN_MAX_MS = 60_000;
const INVALID_OUTPUT_CONTINUATION_LIMIT = 2;
const INVALID_OUTPUT_REASONING_CHAR_LIMIT = 20_000;
const MIMOCODE_OUTPUT_TOKEN_MAX = 128_000;

const MIMO_SOURCE = "mimocode-cli-free";
const MIMO_ACCEPT = "*/*";
const MIMO_BOOTSTRAP_USER_AGENT = "Bun/1.3.11";
const MIMO_USER_AGENT = "mimocode/local ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.11";
const MIMOCODE_IDENTITY_PROMPT =
  "You are MiMoCode, an interactive CLI tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.";
const MIMOCODE_TOOL_CONTINUATION_PROMPT =
  "When caller-side tools are available and the user asks you to implement, fix, build, or verify code, use the tools immediately and continue tool calls until the work is complete, verified, or genuinely blocked. Do not end a turn with only a plan or a statement of intent.";
const MIMOCODE_PROVIDER_PROMPT = `${MIMOCODE_IDENTITY_PROMPT}\n\n${MIMOCODE_TOOL_CONTINUATION_PROMPT}`;
const MIMOCODE_LEGACY_IDENTITY_PROMPT =
  "You are MiMoCode, an interactive CLI tool that helps users with software engineering tasks.";
const MIMOCODE_INVALID_OUTPUT_REMINDER = [
  "<system-reminder>",
  "Your previous response contained no usable answer (it had only reasoning, or was empty).",
  "Provide a final answer to the user now, or call a valid tool to make progress on the task.",
  "Do not respond with only reasoning/thinking.",
  "</system-reminder>",
].join("\n");

const TEXT_ENCODER = new TextEncoder();

// ── Account State ──────────────────────────────────────────────────────────

interface AccountState {
  fingerprint: string;
  jwt: string;
  expiresAt: number;
  cooldownUntil: number;
  consecutiveFails: number;
}

interface BufferedFailure {
  status: number;
  body: string;
  headers: Record<string, string>;
  illegalAccess?: boolean;
}

interface OutputSummary {
  hasVisibleText: boolean;
  hasToolCall: boolean;
  hasReasoning: boolean;
  reasoningText: string;
  finishReason: string | null;
  sawCompletion: boolean;
}

class MimocodeHttpError extends Error {
  status: number;
  body: string;

  constructor(message: string, status: number, body = "") {
    super(message);
    this.name = "MimocodeHttpError";
    this.status = status;
    this.body = body;
  }
}

function parseJwtExp(jwt: string): number {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return Date.now() + 50 * 60 * 1000;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    return (payload.exp ?? Math.floor(Date.now() / 1000) + 3000) * 1000;
  } catch {
    return Date.now() + 50 * 60 * 1000;
  }
}

function hasUsableJwt(account: AccountState): boolean {
  return Boolean(account.jwt && account.expiresAt - Date.now() > JWT_REFRESH_BUFFER_MS);
}

function isAccountCooling(account: AccountState): boolean {
  return account.cooldownUntil > Date.now();
}

function isAbortLikeError(err: unknown, signal?: AbortSignal | null): boolean {
  if (signal?.aborted) return true;
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || err.message.toLowerCase().includes("aborted");
}

function responseHeadersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function jsonErrorResponse(
  status: number,
  message: string,
  code: string,
  options: {
    headers?: Record<string, string>;
    retryAfterMs?: number | null;
  } = {}
): Response {
  const retryAfterMs =
    typeof options.retryAfterMs === "number" && Number.isFinite(options.retryAfterMs)
      ? Math.max(Math.ceil(options.retryAfterMs), 0)
      : null;
  const retryAfterSec = retryAfterMs !== null ? Math.max(Math.ceil(retryAfterMs / 1000), 1) : null;
  return new Response(
    TEXT_ENCODER.encode(
      JSON.stringify({
        error: {
          message,
          type: status === 499 ? "abort" : "upstream_error",
          code,
          ...(retryAfterSec !== null ? { retry_after: retryAfterSec } : {}),
          ...(retryAfterMs !== null ? { retry_after_ms: retryAfterMs } : {}),
        },
      })
    ),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
    }
  );
}

function emptyOutputSummary(): OutputSummary {
  return {
    hasVisibleText: false,
    hasToolCall: false,
    hasReasoning: false,
    reasoningText: "",
    finishReason: null,
    sawCompletion: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getNestedError(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!value) return null;
  return isRecord(value.error) ? value.error : null;
}

function isMimocodeIllegalAccessFailure(failure: BufferedFailure): boolean {
  if (failure.status !== 403) return false;
  const error = getNestedError(parseJsonObject(failure.body));
  const type = typeof error?.type === "string" ? error.type.toLowerCase() : "";
  const code = typeof error?.code === "string" ? error.code.toLowerCase() : "";
  const message = typeof error?.message === "string" ? error.message.toLowerCase() : "";
  return (
    type === "illegal_access" || code === "illegal_access" || message.includes("illegal access")
  );
}

function hasVisibleText(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (!Array.isArray(value)) return false;
  return value.some((part) => {
    if (typeof part === "string") return part.trim().length > 0;
    if (!isRecord(part)) return false;
    const type = typeof part.type === "string" ? part.type : "";
    if (type === "reasoning" || type === "thinking") return false;
    return hasVisibleText(part.text) || hasVisibleText(part.content);
  });
}

function appendReasoning(summary: OutputSummary, value: unknown): void {
  if (typeof value !== "string" || value.length === 0) return;
  summary.hasReasoning = true;
  if (summary.reasoningText.length >= INVALID_OUTPUT_REASONING_CHAR_LIMIT) return;
  summary.reasoningText = `${summary.reasoningText}${value}`.slice(
    0,
    INVALID_OUTPUT_REASONING_CHAR_LIMIT
  );
}

function inspectChatChoice(choice: unknown, summary: OutputSummary): void {
  if (!isRecord(choice)) return;
  summary.sawCompletion = true;

  if (typeof choice.finish_reason === "string") summary.finishReason = choice.finish_reason;
  const delta = isRecord(choice.delta) ? choice.delta : null;
  const message = isRecord(choice.message) ? choice.message : null;

  for (const source of [delta, message]) {
    if (!source) continue;
    if (hasVisibleText(source.content)) summary.hasVisibleText = true;
    if (Array.isArray(source.tool_calls) && source.tool_calls.length > 0) {
      summary.hasToolCall = true;
    }
    if (isRecord(source.function_call)) summary.hasToolCall = true;
    appendReasoning(summary, source.reasoning_content);
    appendReasoning(summary, source.reasoning);
  }
}

function summarizeChatPayload(payload: unknown): OutputSummary {
  const summary = emptyOutputSummary();
  if (!isRecord(payload)) return summary;
  if (Array.isArray(payload.choices)) {
    for (const choice of payload.choices) inspectChatChoice(choice, summary);
  }
  return summary;
}

function readSseJsonPayloads(raw: string): unknown[] {
  const payloads: unknown[] = [];
  let dataLines: string[] = [];

  const flush = () => {
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n").trim();
    dataLines = [];
    if (!data || data === "[DONE]") return;
    try {
      payloads.push(JSON.parse(data));
    } catch {
      // Ignore malformed provider frames; downstream parsing keeps the same behavior.
    }
  };

  for (const rawLine of raw.split(/\n/)) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  flush();
  return payloads;
}

function summarizeSsePayload(raw: string): OutputSummary {
  const summary = emptyOutputSummary();
  for (const payload of readSseJsonPayloads(raw)) {
    const next = summarizeChatPayload(payload);
    summary.hasVisibleText ||= next.hasVisibleText;
    summary.hasToolCall ||= next.hasToolCall;
    summary.hasReasoning ||= next.hasReasoning;
    if (next.finishReason) summary.finishReason = next.finishReason;
    summary.sawCompletion ||= next.sawCompletion;
    appendReasoning(summary, next.reasoningText);
  }
  return summary;
}

function isInvalidOutput(summary: OutputSummary): boolean {
  if (!summary.sawCompletion) return false;
  if (summary.hasVisibleText || summary.hasToolCall) return false;
  return summary.finishReason === null || summary.finishReason === "stop";
}

function responseFromText(response: Response, body: string): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ── Fingerprint Generation ─────────────────────────────────────────────────

function getCpuModel(): string {
  try {
    const cpus = os.cpus();
    if (cpus.length > 0 && cpus[0].model) return cpus[0].model.trim();
  } catch {
    /* ignore */
  }
  return "unknown-cpu";
}

export function generateFingerprint(seed?: string): string {
  if (seed) return crypto.createHash("sha256").update(seed).digest("hex");
  const hostname = os.hostname();
  const platform = os.platform();
  const arch = os.arch();
  const cpu = getCpuModel();
  let username = "unknown-user";
  try {
    username = os.userInfo().username;
  } catch {
    /* ignore */
  }
  return crypto
    .createHash("sha256")
    .update(`${hostname}|${platform}|${arch}|${cpu}|${username}`)
    .digest("hex");
}

export function normalizeFingerprint(fingerprint: string): string {
  const trimmed = fingerprint.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  return generateFingerprint(trimmed);
}

// ── Bootstrap ──────────────────────────────────────────────────────────────

const bootstrapInflight = new Map<string, Promise<{ jwt: string; expiresAt: number }>>();

async function bootstrapJwt(
  baseUrl: string,
  fingerprint: string,
  signal?: AbortSignal | null
): Promise<{ jwt: string; expiresAt: number }> {
  const existing = bootstrapInflight.get(fingerprint);
  if (existing) return existing;

  const url = `${baseUrl}${BOOTSTRAP_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BOOTSTRAP_TIMEOUT_MS);
  const onSignal = signal ? () => controller.abort(signal.reason) : null;
  if (signal && onSignal) signal.addEventListener("abort", onSignal, { once: true });

  const promise = (async () => {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Accept: MIMO_ACCEPT,
          "Content-Type": "application/json",
          "User-Agent": MIMO_BOOTSTRAP_USER_AGENT,
        },
        body: JSON.stringify({ client: fingerprint }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new MimocodeHttpError(
          `Bootstrap failed: ${resp.status} ${body.slice(0, 200)}`,
          resp.status,
          body
        );
      }
      const data = (await resp.json()) as { jwt?: string };
      if (!data.jwt) throw new Error("Bootstrap response missing jwt field");
      return { jwt: data.jwt, expiresAt: parseJwtExp(data.jwt) };
    } finally {
      clearTimeout(timer);
      if (signal && onSignal) signal.removeEventListener("abort", onSignal);
      bootstrapInflight.delete(fingerprint);
    }
  })();

  bootstrapInflight.set(fingerprint, promise);
  return promise;
}

// ── Model Rewriting ────────────────────────────────────────────────────────

function rewriteModelName(model: string): string {
  const idx = model.lastIndexOf("/");
  return idx >= 0 ? model.slice(idx + 1) : model;
}

function hasMimocodeIdentityPrompt(messages: unknown[]): boolean {
  return messages.some((message) => {
    if (typeof message !== "object" || message === null) return false;
    const record = message as Record<string, unknown>;
    return (
      record.role === "system" &&
      typeof record.content === "string" &&
      (record.content.includes(MIMOCODE_IDENTITY_PROMPT) ||
        record.content.includes(MIMOCODE_LEGACY_IDENTITY_PROMPT))
    );
  });
}

function withMimocodeIdentityPrompt(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.messages)) return body;
  const messages = [...body.messages];

  const existingMimocodeIdx = messages.findIndex((message) => {
    if (typeof message !== "object" || message === null) return false;
    const record = message as Record<string, unknown>;
    return (
      record.role === "system" &&
      typeof record.content === "string" &&
      (record.content.includes(MIMOCODE_IDENTITY_PROMPT) ||
        record.content.includes(MIMOCODE_LEGACY_IDENTITY_PROMPT))
    );
  });
  if (existingMimocodeIdx >= 0) {
    const record = messages[existingMimocodeIdx] as Record<string, unknown>;
    const content = String(record.content);
    if (content.includes(MIMOCODE_TOOL_CONTINUATION_PROMPT)) return body;
    messages[existingMimocodeIdx] = {
      ...record,
      content: `${content}\n\n${MIMOCODE_TOOL_CONTINUATION_PROMPT}`,
    };
    return { ...body, messages };
  }

  const firstSystemIdx = messages.findIndex((message) => {
    if (typeof message !== "object" || message === null) return false;
    const record = message as Record<string, unknown>;
    return record.role === "system" && typeof record.content === "string";
  });
  if (firstSystemIdx >= 0) {
    const record = messages[firstSystemIdx] as Record<string, unknown>;
    messages[firstSystemIdx] = {
      ...record,
      content: `${MIMOCODE_PROVIDER_PROMPT}\n\n${record.content}`,
    };
    return { ...body, messages };
  }

  if (hasMimocodeIdentityPrompt(messages)) return { ...body, messages };
  return {
    ...body,
    messages: [{ role: "system", content: MIMOCODE_PROVIDER_PROMPT }, ...messages],
  };
}

function appendInvalidOutputContinuation(
  body: unknown,
  summary: OutputSummary
): Record<string, unknown> | unknown {
  if (!isRecord(body) || !Array.isArray(body.messages)) return body;

  const assistant: Record<string, unknown> = {
    role: "assistant",
    content: "",
  };
  if (summary.reasoningText) assistant.reasoning_content = summary.reasoningText;

  return {
    ...body,
    messages: [
      ...body.messages,
      assistant,
      { role: "user", content: MIMOCODE_INVALID_OUTPUT_REMINDER },
    ],
  };
}

function getStringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveSessionAffinity(credentials: ProviderCredentials): string | null {
  const data = credentials.providerSpecificData || {};
  return (
    getStringField(data.sessionAffinity) ||
    getStringField(data.sessionId) ||
    getStringField(data.sessionID) ||
    getStringField(credentials.connectionId)
  );
}

function withOfficialRequestDefaults(
  body: Record<string, unknown>,
  stream: boolean
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...body };
  const maxTokens = Number(next.max_tokens);
  if (!Number.isFinite(maxTokens) && next.max_completion_tokens === undefined) {
    next.max_tokens = MIMOCODE_OUTPUT_TOKEN_MAX;
  } else if (Number.isFinite(maxTokens) && maxTokens > MIMOCODE_OUTPUT_TOKEN_MAX) {
    next.max_tokens = MIMOCODE_OUTPUT_TOKEN_MAX;
  }

  if (stream && next.stream_options === undefined) {
    next.stream_options = { include_usage: true };
  }

  return next;
}

// ── Executor ───────────────────────────────────────────────────────────────

export class MimocodeExecutor extends BaseExecutor {
  private accountStates = new Map<string, AccountState>();
  private accountCursors = new Map<string, number>();
  private defaultFingerprint: string;
  private baseUrl: string;

  constructor() {
    super("mimocode", { format: "openai" });
    this.baseUrl = this.getBaseUrls()[0] || "https://api.xiaomimimo.com";
    this.defaultFingerprint = generateFingerprint();
    this.getAccountState(this.defaultFingerprint);
  }

  private getCredentialFingerprints(credentials: ProviderCredentials): string[] {
    const fingerprints = credentials?.providerSpecificData?.fingerprints;
    if (!Array.isArray(fingerprints)) return [this.defaultFingerprint];

    const unique = new Set<string>();
    for (const fingerprint of fingerprints) {
      if (typeof fingerprint === "string" && fingerprint.trim().length > 0) {
        unique.add(normalizeFingerprint(fingerprint));
      }
    }
    return unique.size > 0 ? [...unique] : [this.defaultFingerprint];
  }

  private getAccountState(fingerprint: string): AccountState {
    const existing = this.accountStates.get(fingerprint);
    if (existing) return existing;

    const account: AccountState = {
      fingerprint,
      jwt: "",
      expiresAt: 0,
      cooldownUntil: 0,
      consecutiveFails: 0,
    };
    this.accountStates.set(fingerprint, account);
    return account;
  }

  private getAccountsForCredentials(credentials: ProviderCredentials): AccountState[] {
    return this.getCredentialFingerprints(credentials).map((fingerprint) =>
      this.getAccountState(fingerprint)
    );
  }

  private getAccountCursorKey(credentials: ProviderCredentials, accounts: AccountState[]): string {
    if (credentials.connectionId) return credentials.connectionId;
    return accounts.map((account) => account.fingerprint).join(",");
  }

  private async getJwtForAccount(
    account: AccountState,
    signal?: AbortSignal | null
  ): Promise<string> {
    if (hasUsableJwt(account)) return account.jwt;
    const result = await bootstrapJwt(this.baseUrl, account.fingerprint, signal);
    account.jwt = result.jwt;
    account.expiresAt = result.expiresAt;
    return account.jwt;
  }

  private pickAccount(accounts: AccountState[], cursorKey: string): AccountState | null {
    if (accounts.length === 0) return null;

    const nextAccountIdx = this.accountCursors.get(cursorKey) || 0;
    for (let i = 0; i < accounts.length; i++) {
      const idx = (nextAccountIdx + i) % accounts.length;
      const account = accounts[idx];
      if (!isAccountCooling(account)) {
        this.accountCursors.set(cursorKey, (idx + 1) % accounts.length);
        return account;
      }
    }
    return null;
  }

  private markCooldown(account: AccountState): void {
    account.consecutiveFails++;
    const backoff = Math.min(
      COOLDOWN_BASE_MS * Math.pow(2, account.consecutiveFails - 1),
      COOLDOWN_MAX_MS
    );
    account.cooldownUntil = Date.now() + backoff + Math.random() * 1000;
  }

  private markSuccess(account: AccountState): void {
    account.consecutiveFails = 0;
    account.cooldownUntil = 0;
  }

  private getEarliestCooldownMs(accounts: AccountState[]): number | null {
    const now = Date.now();
    const cooldowns = accounts
      .map((account) => account.cooldownUntil)
      .filter((cooldownUntil) => Number.isFinite(cooldownUntil) && cooldownUntil > now)
      .sort((a, b) => a - b);
    if (cooldowns.length === 0) return null;
    return Math.max(cooldowns[0] - now, 0);
  }

  private allAccountsCoolingResponse(accounts: AccountState[]): Response {
    const retryAfterMs = this.getEarliestCooldownMs(accounts);
    const retryAfterSec = retryAfterMs !== null ? Math.max(Math.ceil(retryAfterMs / 1000), 1) : 1;
    return jsonErrorResponse(429, "All accounts are cooling down", "ACCOUNTS_COOLING_DOWN", {
      retryAfterMs: retryAfterMs ?? retryAfterSec * 1000,
      headers: {
        "Retry-After": String(retryAfterSec),
      },
    });
  }

  private accountLabel(account: AccountState, credentials: ProviderCredentials): string {
    const connectionId = credentials.connectionId?.slice(0, 8);
    return connectionId
      ? `${account.fingerprint.slice(0, 8)} connection=${connectionId}`
      : account.fingerprint.slice(0, 8);
  }

  private async bufferFailure(response: Response): Promise<BufferedFailure> {
    const headers = responseHeadersToRecord(response.headers);
    delete headers["content-encoding"];
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    const failure = {
      status: response.status,
      body: await response.text().catch(() => ""),
      headers,
    };
    return {
      ...failure,
      illegalAccess: isMimocodeIllegalAccessFailure(failure),
    };
  }

  private failureResponse(failure: BufferedFailure): Response {
    return new Response(failure.body, {
      status: failure.status,
      headers: failure.headers,
    });
  }

  private illegalAccessFailureResponse(failure: BufferedFailure): Response {
    return new Response(
      TEXT_ENCODER.encode(
        JSON.stringify({
          error: {
            message:
              "MiMo free API rejected chat access after bootstrap. This is upstream access control, not an expired token. Assign a working proxy to this MiMo account or try another fingerprint/account.",
            type: "illegal_access",
            code: "MIMOCODE_ILLEGAL_ACCESS",
            upstream_status: failure.status,
          },
        })
      ),
      {
        status: 403,
        headers: {
          ...failure.headers,
          "Content-Type": "application/json",
        },
      }
    );
  }

  private fetchChat(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    signal?: AbortSignal | null
  ): Promise<Response> {
    return fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: signal ?? undefined,
    });
  }

  private async bufferSuccessfulResponse(
    response: Response,
    stream: boolean
  ): Promise<{ response: Response; summary: OutputSummary }> {
    const bodyText = await response.text();
    const contentType = response.headers.get("content-type") || "";
    if (stream || contentType.includes("text/event-stream")) {
      return {
        response: responseFromText(response, bodyText),
        summary: summarizeSsePayload(bodyText),
      };
    }

    try {
      return {
        response: responseFromText(response, bodyText),
        summary: summarizeChatPayload(JSON.parse(bodyText)),
      };
    } catch {
      return {
        response: responseFromText(response, bodyText),
        summary: emptyOutputSummary(),
      };
    }
  }

  private async autoContinueInvalidOutput(params: {
    response: Response;
    url: string;
    headers: Record<string, string>;
    requestBody: unknown;
    stream: boolean;
    signal?: AbortSignal | null;
    log?: ExecuteInput["log"];
  }): Promise<Response> {
    let response = params.response;
    let requestBody = params.requestBody;

    for (let attempt = 0; attempt <= INVALID_OUTPUT_CONTINUATION_LIMIT; attempt++) {
      if (!response.ok) return response;

      const buffered = await this.bufferSuccessfulResponse(response, params.stream);
      if (!isInvalidOutput(buffered.summary)) return buffered.response;

      if (attempt >= INVALID_OUTPUT_CONTINUATION_LIMIT) {
        return jsonErrorResponse(
          502,
          "MiMo returned only reasoning and no usable answer or tool call after continuation retries",
          "INVALID_OUTPUT"
        );
      }

      params.log?.warn?.(
        "MIMOCODE",
        `Auto-continuing invalid reasoning-only output (attempt ${attempt + 1})`
      );
      requestBody = appendInvalidOutputContinuation(requestBody, buffered.summary);
      response = await this.fetchChat(params.url, params.headers, requestBody, params.signal);
    }

    return response;
  }

  buildUrl(
    _model: string,
    _stream: boolean,
    _urlIndex = 0,
    _credentials?: ProviderCredentials | null
  ): string {
    return `${this.baseUrl.replace(/\/$/, "")}${CHAT_PATH}`;
  }

  buildHeaders(
    _credentials: ProviderCredentials,
    _stream = true,
    _clientHeaders?: Record<string, string> | null,
    _model?: string
  ): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: MIMO_ACCEPT,
      "Content-Type": "application/json",
      "X-Mimo-Source": MIMO_SOURCE,
    };
    setUserAgentHeader(headers, MIMO_USER_AGENT);
    const sessionAffinity = resolveSessionAffinity(_credentials);
    if (sessionAffinity) headers["x-session-affinity"] = sessionAffinity;
    applyConfiguredUserAgent(headers, _credentials.providerSpecificData);
    return headers;
  }

  transformRequest(
    model: string,
    body: unknown,
    _stream: boolean,
    _credentials?: ProviderCredentials | null
  ): unknown {
    if (typeof body === "object" && body !== null) {
      return withMimocodeIdentityPrompt(
        withOfficialRequestDefaults(
          {
            ...(body as Record<string, unknown>),
            model: rewriteModelName(model),
          },
          _stream
        )
      );
    }
    return body;
  }

  async testConnection(
    credentials: ProviderCredentials,
    signal?: AbortSignal | null,
    log?: ExecuteInput["log"]
  ): Promise<boolean> {
    try {
      const accounts = this.getAccountsForCredentials(credentials);
      const cursorKey = this.getAccountCursorKey(credentials, accounts);
      const account = this.pickAccount(accounts, cursorKey) || accounts[0];
      if (!account) return false;
      const jwt = await this.getJwtForAccount(account, signal);
      const body = this.transformRequest(
        "mimo-auto",
        {
          model: "mimo-auto",
          messages: [{ role: "user", content: "ping" }],
          stream: false,
        },
        false,
        credentials
      );
      const resp = await this.fetchChat(
        this.buildUrl("mimo-auto", false),
        { ...this.buildHeaders(credentials, false), Authorization: `Bearer ${jwt}` },
        body,
        signal
      );
      return resp.status === 200;
    } catch {
      log?.warn?.("MIMOCODE", "testConnection network error");
      return false;
    }
  }

  async execute(input: ExecuteInput): Promise<{
    response: Response;
    url: string;
    headers: Record<string, string>;
    transformedBody: unknown;
  }> {
    const { model, stream, body, signal, log } = input;

    if (signal?.aborted) {
      return {
        response: jsonErrorResponse(499, "Request aborted", "ABORTED"),
        url: this.buildUrl(model, stream),
        headers: this.buildHeaders(input.credentials, stream),
        transformedBody: body,
      };
    }

    const url = this.buildUrl(model, stream);
    const reqBody = this.transformRequest(model, body, stream, input.credentials);

    const accounts = this.getAccountsForCredentials(input.credentials);
    const cursorKey = this.getAccountCursorKey(input.credentials, accounts);
    let lastFailure: BufferedFailure | null = null;

    // Try each selected-connection account once. In the normal dashboard flow
    // there is exactly one fingerprint per connection; legacy rows with many
    // fingerprints still rotate inside the row for backward compatibility.
    for (let attempt = 0; attempt < accounts.length; attempt++) {
      const account = this.pickAccount(accounts, cursorKey);
      if (!account) break;
      try {
        const jwt = await this.getJwtForAccount(account, signal);
        const headers = this.buildHeaders(input.credentials, stream);
        headers["Authorization"] = `Bearer ${jwt}`;

        let resp = await this.fetchChat(url, headers, reqBody, signal);

        // On auth failure, re-bootstrap this account and retry once
        if (resp.status === 401 || resp.status === 403) {
          const authFailure = await this.bufferFailure(resp);
          if (authFailure.illegalAccess) {
            log?.warn?.(
              "MIMOCODE",
              `Access rejected (403 illegal_access) on account ${this.accountLabel(
                account,
                input.credentials
              )}; skipping token refresh`
            );
            this.markCooldown(account);
            lastFailure = authFailure;
            continue;
          }

          log?.warn?.(
            "MIMOCODE",
            `Auth failed (${resp.status}) on account ${this.accountLabel(account, input.credentials)}`
          );
          account.jwt = "";
          account.expiresAt = 0;
          account.consecutiveFails = 0;
          const freshJwt = await this.getJwtForAccount(account, signal);
          headers["Authorization"] = `Bearer ${freshJwt}`;
          resp = await this.fetchChat(url, headers, reqBody, signal);
        }

        if (resp.status === 429) {
          this.markCooldown(account);
          lastFailure = await this.bufferFailure(resp);
          log?.warn?.(
            "MIMOCODE",
            `Rate limited on account ${this.accountLabel(account, input.credentials)}, trying next`
          );
          continue;
        }

        if (resp.status === 401 || resp.status === 403) {
          this.markCooldown(account);
          lastFailure = await this.bufferFailure(resp);
          continue;
        }

        if (!resp.ok) {
          const respHeaders = responseHeadersToRecord(resp.headers);
          return {
            response: resp as unknown as Response,
            url,
            headers: respHeaders,
            transformedBody: reqBody,
          };
        }

        resp = await this.autoContinueInvalidOutput({
          response: resp as unknown as Response,
          url,
          headers,
          requestBody: reqBody,
          stream,
          signal,
          log,
        });

        if (resp.status === 429) {
          this.markCooldown(account);
          lastFailure = await this.bufferFailure(resp);
          log?.warn?.(
            "MIMOCODE",
            `Rate limited during invalid-output continuation on account ${this.accountLabel(
              account,
              input.credentials
            )}, trying next`
          );
          continue;
        }

        if (resp.status === 401 || resp.status === 403) {
          this.markCooldown(account);
          lastFailure = await this.bufferFailure(resp);
          continue;
        }

        if (!resp.ok) {
          const respHeaders = responseHeadersToRecord(resp.headers);
          return {
            response: resp as unknown as Response,
            url,
            headers: respHeaders,
            transformedBody: reqBody,
          };
        }

        this.markSuccess(account);
        const respHeaders = responseHeadersToRecord(resp.headers);
        return {
          response: resp as unknown as Response,
          url,
          headers: respHeaders,
          transformedBody: reqBody,
        };
      } catch (err) {
        if (isAbortLikeError(err, signal)) {
          return {
            response: jsonErrorResponse(499, "Request aborted", "ABORTED"),
            url,
            headers: this.buildHeaders(input.credentials, stream),
            transformedBody: reqBody,
          };
        }

        this.markCooldown(account);

        if (err instanceof MimocodeHttpError) {
          lastFailure = {
            status: err.status,
            body:
              err.body ||
              JSON.stringify({
                error: {
                  message: sanitizeErrorMessage(err.message),
                  type: "upstream_error",
                  code: err.status,
                },
              }),
            headers: { "Content-Type": "application/json" },
          };
          log?.warn?.(
            "MIMOCODE",
            `Bootstrap failed on account ${this.accountLabel(
              account,
              input.credentials
            )}: ${err.status}`
          );
          continue;
        }

        const msg = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
        log?.error?.(
          "MIMOCODE",
          `Executor error on account ${this.accountLabel(account, input.credentials)}: ${msg}`
        );
        lastFailure = {
          status: 502,
          body: JSON.stringify({
            error: { message: msg, type: "upstream_error", code: "EXECUTOR_ERROR" },
          }),
          headers: { "Content-Type": "application/json" },
        };
      }
    }

    if (lastFailure) {
      return {
        response: lastFailure.illegalAccess
          ? this.illegalAccessFailureResponse(lastFailure)
          : this.failureResponse(lastFailure),
        url,
        headers: lastFailure.headers,
        transformedBody: reqBody,
      };
    }

    return {
      response: this.allAccountsCoolingResponse(accounts),
      url,
      headers: this.buildHeaders(input.credentials, stream),
      transformedBody: reqBody,
    };
  }
}

export default MimocodeExecutor;
