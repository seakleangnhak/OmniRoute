import { randomUUID } from "crypto";
import {
  BaseExecutor,
  setUserAgentHeader,
  type ExecuteInput,
  type ProviderCredentials,
} from "./base.ts";
import { PROVIDERS } from "../config/constants.ts";
import { getModelTargetFormat } from "../config/providerModels.ts";
import { runWithProxyContext } from "../utils/proxyFetch.ts";
import { proxyConfigToUrl, proxyUrlForLogs } from "../utils/proxyDispatcher.ts";

const ACCOUNT_COOLDOWN_BASE_MS = 5_000;
const ACCOUNT_COOLDOWN_MAX_MS = 60_000;
const ROTATABLE_STATUS_CODES = new Set([401, 403, 429]);

type AccountProxy = {
  type: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  proxyId?: string;
  proxyName?: string;
  family?: string;
  relayAuth?: string;
} | null;

type AccountProxyConfig = {
  fingerprint: string;
  proxy: AccountProxy;
};

type AccountState = {
  fingerprint: string;
  cooldownUntil: number;
  consecutiveFails: number;
  proxy: AccountProxy;
};

function uniqueFingerprints(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    )
  );
}

function createAccountState(fingerprint: string): AccountState {
  return {
    fingerprint,
    cooldownUntil: 0,
    consecutiveFails: 0,
    proxy: null,
  };
}

function isAccountReady(account: AccountState): boolean {
  return account.cooldownUntil <= Date.now();
}

function getFingerprintLabel(fingerprint: string): string {
  return fingerprint.slice(0, 8);
}

function getAccountProxyLabel(proxy: AccountProxy): string {
  if (!proxy) return "direct connection";
  try {
    const proxyUrl = proxyConfigToUrl(proxy);
    const base = proxyUrl ? proxyUrlForLogs(proxyUrl) : "configured proxy";
    const metadata =
      typeof proxy.proxyName === "string" && proxy.proxyName.trim().length > 0
        ? proxy.proxyName.trim()
        : typeof proxy.proxyId === "string" && proxy.proxyId.trim().length > 0
          ? proxy.proxyId.trim().slice(0, 8)
          : "";
    return metadata ? `${base} (${metadata})` : base;
  } catch {
    return "configured proxy";
  }
}

function parseRetryAfterMs(retryAfter: string | null): number | null {
  if (!retryAfter) return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.max(Math.ceil(seconds * 1000), 1_000);
  }

  const retryTimeMs = Date.parse(retryAfter);
  if (!Number.isFinite(retryTimeMs)) return null;

  return Math.max(retryTimeMs - Date.now(), 1_000);
}

export class OpencodeExecutor extends BaseExecutor {
  _requestFormat: string | null = null;
  private accounts: AccountState[] = [];
  private nextAccountIdx = 0;

  constructor(provider: string) {
    super(provider, PROVIDERS[provider] || PROVIDERS.openai);
  }

  private syncAccountsFromCredentials(credentials: ProviderCredentials | null): string[] {
    const requestedFingerprints = uniqueFingerprints(
      credentials?.providerSpecificData?.fingerprints
    );
    if (requestedFingerprints.length === 0) {
      this.accounts = [];
      this.nextAccountIdx = 0;
      return [];
    }

    const existingByFingerprint = new Map(
      this.accounts.map((account) => [account.fingerprint, account] as const)
    );
    this.accounts = requestedFingerprints.map((fingerprint) => {
      const existing = existingByFingerprint.get(fingerprint);
      return existing ? { ...existing } : createAccountState(fingerprint);
    });

    if (this.nextAccountIdx >= this.accounts.length) {
      this.nextAccountIdx = 0;
    }

    const accountProxies = credentials?.providerSpecificData?.accountProxies as
      | AccountProxyConfig[]
      | undefined;
    const proxyMap = Array.isArray(accountProxies)
      ? new Map(accountProxies.map((entry) => [entry?.fingerprint, entry?.proxy ?? null] as const))
      : null;

    for (const account of this.accounts) {
      account.proxy = proxyMap?.get(account.fingerprint) ?? null;
    }

    return requestedFingerprints;
  }

  private getAttemptOrder(): AccountState[] {
    const ready: AccountState[] = [];
    const coolingDown: AccountState[] = [];

    for (let offset = 0; offset < this.accounts.length; offset++) {
      const idx = (this.nextAccountIdx + offset) % this.accounts.length;
      const account = this.accounts[idx];
      if (isAccountReady(account)) {
        ready.push(account);
      } else {
        coolingDown.push(account);
      }
    }

    if (this.accounts.length > 0) {
      this.nextAccountIdx = (this.nextAccountIdx + 1) % this.accounts.length;
    }

    return [...ready, ...coolingDown];
  }

  private markCooldown(account: AccountState, retryAfterMs?: number | null): void {
    account.consecutiveFails++;
    const retryWindow =
      typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? retryAfterMs
        : Math.min(
            ACCOUNT_COOLDOWN_BASE_MS * Math.pow(2, account.consecutiveFails - 1),
            ACCOUNT_COOLDOWN_MAX_MS
          );
    account.cooldownUntil = Date.now() + retryWindow;
  }

  private markSuccess(account: AccountState): void {
    account.consecutiveFails = 0;
    account.cooldownUntil = 0;
  }

  private buildAccountCredentials(
    credentials: ProviderCredentials,
    fingerprint: string
  ): ProviderCredentials {
    return {
      ...credentials,
      providerSpecificData: {
        ...(credentials.providerSpecificData || {}),
        selectedFingerprint: fingerprint,
      },
    };
  }

  async execute(input: ExecuteInput) {
    this._requestFormat = getModelTargetFormat(this.provider, input.model) || "openai";
    try {
      const fingerprints = this.syncAccountsFromCredentials(input.credentials);
      if (fingerprints.length === 0) {
        return await super.execute(input);
      }

      let lastResult: Awaited<ReturnType<BaseExecutor["execute"]>> | null = null;
      let lastError: Error | null = null;

      for (const account of this.getAttemptOrder()) {
        const fingerprintLabel = getFingerprintLabel(account.fingerprint);
        const proxyLabel = getAccountProxyLabel(account.proxy);
        const attemptCredentials = this.buildAccountCredentials(
          input.credentials,
          account.fingerprint
        );

        try {
          input.log?.info?.(
            "OPENCODE",
            `Using managed account ${fingerprintLabel} via ${proxyLabel}`
          );

          const result = await runWithProxyContext(account.proxy, () =>
            super.execute({
              ...input,
              credentials: attemptCredentials,
              skipUpstreamRetry: true,
            })
          );

          if (ROTATABLE_STATUS_CODES.has(result.response.status)) {
            this.markCooldown(
              account,
              result.response.status === 429
                ? parseRetryAfterMs(result.response.headers.get("retry-after"))
                : null
            );
            input.log?.warn?.(
              "OPENCODE",
              `Account ${fingerprintLabel} unavailable (${result.response.status}), trying next`
            );
            lastResult = result;
            continue;
          }

          this.markSuccess(account);
          return result;
        } catch (error) {
          this.markCooldown(account);
          lastError = error instanceof Error ? error : new Error(String(error));
          input.log?.warn?.(
            "OPENCODE",
            `Account ${fingerprintLabel} failed via ${proxyLabel}: ${lastError.message}`
          );
        }
      }

      if (lastResult) {
        return lastResult;
      }
      if (lastError) {
        throw lastError;
      }

      return await super.execute(input);
    } finally {
      this._requestFormat = null;
    }
  }

  buildUrl(
    model: string,
    stream: boolean,
    urlIndex = 0,
    credentials: ProviderCredentials | null = null
  ) {
    void urlIndex;
    void credentials;

    const base = this.config.baseUrl;
    switch (this._requestFormat) {
      case "claude":
        return `${base}/messages`;
      case "openai-responses":
        return `${base}/responses`;
      case "gemini":
        return `${base}/models/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
      default:
        return `${base}/chat/completions`;
    }
  }

  buildHeaders(
    credentials: ProviderCredentials | null,
    stream = true,
    clientHeaders?: Record<string, string> | null,
    model?: string
  ) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const key = credentials?.apiKey || credentials?.accessToken;

    if (key) {
      if (this._requestFormat === "claude") {
        headers["x-api-key"] = key;
      } else {
        headers["Authorization"] = `Bearer ${key}`;
      }
    }

    if (this._requestFormat === "claude") {
      headers["anthropic-version"] = "2023-06-01";
    }

    if (stream) {
      headers["Accept"] = "text/event-stream";
    }

    if (clientHeaders) {
      const clientUA = clientHeaders["User-Agent"] || clientHeaders["user-agent"];
      if (clientUA) {
        setUserAgentHeader(headers, clientUA);
      }

      // Forward OpenCode request metadata headers from client
      const findClientHeader = (name: string) =>
        Object.entries(clientHeaders).find(
          ([key]) => key.toLowerCase() === name.toLowerCase()
        )?.[1];

      const opencodeHeaderKeys = [
        "x-opencode-session",
        "x-opencode-request",
        "x-opencode-project",
        "x-opencode-client",
      ];
      for (const headerName of opencodeHeaderKeys) {
        const value = findClientHeader(headerName);
        if (value) {
          headers[headerName] = value;
        }
      }

      // #4022: OpenCode CLI only emits x-opencode-* headers when the provider id
      // starts with "opencode". For a custom-named provider (e.g. "omniroute") it
      // instead sends x-session-affinity / X-Session-Id, which both carry the same
      // OpenCode sessionID. Map that session id onto x-opencode-session so session
      // continuity to the opencode.ai upstream works regardless of how the user
      // named the provider. Scoped to this executor (opencode.ai/zen upstreams
      // only) — the generic DefaultExecutor intentionally does NOT do this, to
      // avoid leaking the client session id to arbitrary third-party upstreams.
      if (!headers["x-opencode-session"]) {
        const sessionAffinity =
          findClientHeader("x-session-affinity") || findClientHeader("x-session-id");
        if (sessionAffinity) {
          headers["x-opencode-session"] = sessionAffinity;

          // #4465: a custom-named provider only reaches this fallback because the
          // OpenCode CLI did NOT emit the x-opencode-* set (it only does so when the
          // provider id starts with "opencode"). It therefore also dropped
          // x-opencode-request, a per-request correlation id. Synthesize one so these
          // users are not disadvantaged versus opencode-prefixed providers on the
          // opencode.ai upstream. x-opencode-client / x-opencode-project are NOT
          // fabricated: their valid values are opencode-internal and inventing them
          // could be rejected upstream — they remain forward-only above. Scoped to this
          // executor (opencode.ai/zen) and only to the fallback path, so the direct
          // OpenCode CLI flow (which controls its own request id) is untouched.
          if (!headers["x-opencode-request"]) {
            headers["x-opencode-request"] = randomUUID();
          }
        }
      }
    }

    const selectedFingerprint =
      typeof credentials?.providerSpecificData?.selectedFingerprint === "string" &&
      credentials.providerSpecificData.selectedFingerprint.trim().length > 0
        ? credentials.providerSpecificData.selectedFingerprint.trim()
        : "";
    if (selectedFingerprint && !headers["x-opencode-session"]) {
      headers["x-opencode-session"] = selectedFingerprint;
      if (!headers["x-opencode-request"]) {
        headers["x-opencode-request"] = randomUUID();
      }
    }

    void model;

    return headers;
  }

  transformRequest(
    model: string,
    body: any,
    stream: boolean,
    credentials: ProviderCredentials
  ): any {
    const modifiedBody = super.transformRequest(model, body, stream, credentials);
    if (
      modifiedBody &&
      typeof modifiedBody === "object" &&
      Array.isArray(modifiedBody.tools) &&
      modifiedBody.tools.length > 128
    ) {
      modifiedBody.tools = modifiedBody.tools.slice(0, 128);
    }
    if (modifiedBody && typeof modifiedBody === "object" && !Array.isArray(modifiedBody)) {
      const mb = modifiedBody as Record<string, unknown>;
      const m = String(model || "");
      const effortLevels = ["low", "medium", "high", "max"] as const;
      const matchedLevel = effortLevels.find((level) => m.endsWith(`-${level}`));
      if (matchedLevel) {
        const base = m.slice(0, -matchedLevel.length - 1);
        if (base.toLowerCase() === "deepseek-v4-pro") {
          mb.model = "deepseek-v4-pro";
          if (mb.reasoning_effort === undefined) {
            mb.reasoning_effort = matchedLevel;
          }
        }
      }
    }
    return modifiedBody;
  }
}
