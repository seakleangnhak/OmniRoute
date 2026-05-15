import { rotateOneproxyProxy, failOneproxyProxy, succeedOneproxyProxy } from "./oneproxyRotator";

type RotatingProxyStrategy = "random" | "quality" | "sequential";
type RotatingProxyScope = "global" | "provider";
type RotatingProxyProtocol = "http" | "https" | "socks5";
type RotatingProxyStickyMode =
  | "per-request"
  | "per-session"
  | "per-provider"
  | "per-provider-account"
  | "per-api-key"
  | "time-window";

type RotatingProxyPolicyMode = "disabled" | "optional" | "required";
type RotatingProxyFailBehavior = "fail-open" | "fail-closed";

type RotatingProxySettings = {
  enabled?: boolean;
  source?: "oneproxy";
  strategy?: RotatingProxyStrategy;
  scope?: RotatingProxyScope;
  protocol?: RotatingProxyProtocol | null;
  countryCode?: string | null;
  minQuality?: number | null;
  stickyMode?: RotatingProxyStickyMode;
  stickyTtlMinutes?: number;
};

type RotatingProxyPolicyOverride = {
  mode?: RotatingProxyPolicyMode;
  failBehavior?: RotatingProxyFailBehavior;
  protocol?: RotatingProxyProtocol | null;
  countryCode?: string | null;
  minQuality?: number | null;
  stickyMode?: RotatingProxyStickyMode | null;
  stickyTtlMinutes?: number | null;
  maxProxyRetries?: number;
};

type RotatingProxyPolicySettings = RotatingProxyPolicyOverride & {
  defaultMode?: RotatingProxyPolicyMode;
  providerOverrides?: Record<string, RotatingProxyPolicyOverride>;
  accountOverrides?: Record<string, RotatingProxyPolicyOverride>;
};

type EffectiveRotatingProxyPolicy = Required<
  Pick<RotatingProxyPolicyOverride, "mode" | "failBehavior">
> & {
  protocol: RotatingProxyProtocol | null;
  countryCode: string | null;
  minQuality: number | null;
  stickyMode: RotatingProxyStickyMode | null;
  stickyTtlMinutes: number | null;
  maxProxyRetries: number;
};

type ProviderConnectionLike = {
  id?: string;
  provider?: string;
};

type RotatingProxyStickyContext = {
  sessionId?: string | null;
  apiKeyId?: string | null;
  provider?: string | null;
  connectionId?: string | null;
};

type ResolveRotatingProxyOptions = {
  excludeProxyIds?: string[];
  stickyContext?: RotatingProxyStickyContext;
};

type StickyProxyEntry = {
  proxy: RotatedProxy;
  expiresAt: number;
};

const stickyProxyCache = new Map<string, StickyProxyEntry>();

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function normalizeInteger(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeStickyMode(value: unknown): RotatingProxyStickyMode {
  return value === "per-session" ||
    value === "per-provider" ||
    value === "per-provider-account" ||
    value === "per-api-key" ||
    value === "time-window"
    ? value
    : "per-request";
}

function normalizePolicyMode(value: unknown): RotatingProxyPolicyMode | undefined {
  return value === "disabled" || value === "optional" || value === "required" ? value : undefined;
}

function normalizeFailBehavior(value: unknown): RotatingProxyFailBehavior | undefined {
  return value === "fail-closed" || value === "fail-open" ? value : undefined;
}

function normalizeProtocol(value: unknown): RotatingProxyProtocol | null | undefined {
  if (value === null) return null;
  return value === "https" || value === "socks5" || value === "http" ? value : undefined;
}

function normalizeCountryCode(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.toUpperCase().slice(0, 2) : null;
}

function normalizeMinQuality(value: unknown): number | null | undefined {
  if (value === null) return null;
  const parsed = normalizeInteger(value, Number.NaN);
  return Number.isFinite(parsed) ? clamp(parsed, 0, 100) : undefined;
}

function normalizePolicyOverride(value: unknown): RotatingProxyPolicyOverride {
  const record = toRecord(value);
  const mode = normalizePolicyMode(record.mode);
  const failBehavior = normalizeFailBehavior(record.failBehavior);
  const protocol = normalizeProtocol(record.protocol);
  const countryCode = normalizeCountryCode(record.countryCode);
  const minQuality = normalizeMinQuality(record.minQuality);
  const stickyMode =
    record.stickyMode === undefined
      ? undefined
      : record.stickyMode === null
        ? null
        : normalizeStickyMode(record.stickyMode);
  const stickyTtlMinutes =
    record.stickyTtlMinutes === undefined
      ? undefined
      : record.stickyTtlMinutes === null
        ? null
        : clamp(normalizeInteger(record.stickyTtlMinutes, 30), 1, 1440);
  const maxProxyRetries =
    record.maxProxyRetries === undefined
      ? undefined
      : clamp(normalizeInteger(record.maxProxyRetries, 3), 1, 5);

  return {
    ...(mode ? { mode } : {}),
    ...(failBehavior ? { failBehavior } : {}),
    ...(protocol !== undefined ? { protocol } : {}),
    ...(countryCode !== undefined ? { countryCode } : {}),
    ...(minQuality !== undefined ? { minQuality } : {}),
    ...(stickyMode !== undefined ? { stickyMode } : {}),
    ...(stickyTtlMinutes !== undefined ? { stickyTtlMinutes } : {}),
    ...(maxProxyRetries !== undefined ? { maxProxyRetries } : {}),
  };
}

function normalizePolicyOverrideMap(value: unknown): Record<string, RotatingProxyPolicyOverride> {
  const record = toRecord(value);
  return Object.fromEntries(
    Object.entries(record)
      .map(([key, entry]) => [key.trim(), normalizePolicyOverride(entry)] as const)
      .filter(([key]) => key.length > 0)
  );
}

export function normalizeRotatingProxyPolicySettings(value: unknown): RotatingProxyPolicySettings {
  const record = toRecord(value);
  const defaults = normalizePolicyOverride(record);
  const defaultMode = normalizePolicyMode(record.defaultMode) || defaults.mode || "optional";

  return {
    ...defaults,
    defaultMode,
    mode: defaultMode,
    failBehavior: defaults.failBehavior || "fail-open",
    maxProxyRetries: defaults.maxProxyRetries || 3,
    providerOverrides: normalizePolicyOverrideMap(record.providerOverrides),
    accountOverrides: normalizePolicyOverrideMap(record.accountOverrides),
  };
}

function mergePolicyOverride(
  base: EffectiveRotatingProxyPolicy,
  override: RotatingProxyPolicyOverride | undefined
): EffectiveRotatingProxyPolicy {
  if (!override) return base;
  return {
    ...base,
    ...(override.mode ? { mode: override.mode } : {}),
    ...(override.failBehavior ? { failBehavior: override.failBehavior } : {}),
    ...(override.protocol !== undefined ? { protocol: override.protocol } : {}),
    ...(override.countryCode !== undefined ? { countryCode: override.countryCode } : {}),
    ...(override.minQuality !== undefined ? { minQuality: override.minQuality } : {}),
    ...(override.stickyMode !== undefined ? { stickyMode: override.stickyMode } : {}),
    ...(override.stickyTtlMinutes !== undefined
      ? { stickyTtlMinutes: override.stickyTtlMinutes }
      : {}),
    ...(override.maxProxyRetries !== undefined
      ? { maxProxyRetries: override.maxProxyRetries }
      : {}),
  };
}

export function resolveRotatingProxyPolicy(
  value: unknown,
  connection: ProviderConnectionLike | null | undefined
): EffectiveRotatingProxyPolicy {
  const normalized = normalizeRotatingProxyPolicySettings(value);
  const base: EffectiveRotatingProxyPolicy = {
    mode: normalized.defaultMode || "optional",
    failBehavior: normalized.failBehavior || "fail-open",
    protocol: normalized.protocol ?? null,
    countryCode: normalized.countryCode ?? null,
    minQuality: normalized.minQuality ?? null,
    stickyMode: normalized.stickyMode ?? null,
    stickyTtlMinutes: normalized.stickyTtlMinutes ?? null,
    maxProxyRetries: normalized.maxProxyRetries || 3,
  };

  const provider = nonEmptyString(connection?.provider);
  const accountId = nonEmptyString(connection?.id);
  return mergePolicyOverride(
    mergePolicyOverride(base, provider ? normalized.providerOverrides?.[provider] : undefined),
    accountId ? normalized.accountOverrides?.[accountId] : undefined
  );
}

export class RotatingProxyRequiredError extends Error {
  code = "ROTATING_PROXY_REQUIRED";
  status = 503;
  policy: EffectiveRotatingProxyPolicy;

  constructor(message: string, policy: EffectiveRotatingProxyPolicy) {
    super(message);
    this.name = "RotatingProxyRequiredError";
    this.policy = policy;
  }
}

export function isRotatingProxyRequiredError(error: unknown): error is RotatingProxyRequiredError {
  return (
    error instanceof RotatingProxyRequiredError ||
    toRecord(error).code === "ROTATING_PROXY_REQUIRED"
  );
}

export function normalizeRotatingProxySettings(value: unknown): RotatingProxySettings {
  const record = toRecord(value);
  return {
    enabled: record.enabled === true,
    source: record.source === "oneproxy" ? "oneproxy" : "oneproxy",
    strategy:
      record.strategy === "quality" ||
      record.strategy === "sequential" ||
      record.strategy === "random"
        ? record.strategy
        : "random",
    scope: record.scope === "provider" ? "provider" : "global",
    protocol: normalizeProtocol(record.protocol) ?? null,
    countryCode: normalizeCountryCode(record.countryCode) ?? null,
    minQuality: normalizeMinQuality(record.minQuality) ?? 50,
    stickyMode: normalizeStickyMode(record.stickyMode),
    stickyTtlMinutes: clamp(normalizeInteger(record.stickyTtlMinutes, 30), 1, 1440),
  };
}

type RotatedProxy = NonNullable<Awaited<ReturnType<typeof rotateOneproxyProxy>>>;

function proxyToContext(proxy: RotatedProxy) {
  return {
    type: proxy.type,
    host: proxy.host,
    port: proxy.port,
    username: "",
    password: "",
  };
}

function getFilterSignature(settings: RotatingProxySettings): string {
  return [
    settings.source || "oneproxy",
    settings.strategy || "random",
    settings.scope || "global",
    settings.protocol || "any",
    settings.countryCode || "any",
    settings.minQuality ?? 50,
  ].join(":");
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function getStickyCacheKey(
  settings: RotatingProxySettings,
  connection: ProviderConnectionLike | null | undefined,
  context: RotatingProxyStickyContext = {}
): { key: string; expiresAt: number } | null {
  const mode = settings.stickyMode || "per-request";
  if (mode === "per-request") return null;

  const ttlMs = Math.max(1, settings.stickyTtlMinutes || 30) * 60 * 1000;
  const now = Date.now();
  const provider = nonEmptyString(context.provider) || nonEmptyString(connection?.provider);
  const accountId = nonEmptyString(context.connectionId) || nonEmptyString(connection?.id);
  const filter = getFilterSignature(settings);

  if (mode === "per-session") {
    const sessionId = nonEmptyString(context.sessionId);
    if (!sessionId) return null;
    const accountKey = accountId
      ? `${provider || "unknown-provider"}:${accountId}`
      : provider || "global";
    return { key: `session:${filter}:${sessionId}:${accountKey}`, expiresAt: now + ttlMs };
  }

  if (mode === "per-provider") {
    if (!provider) return null;
    return { key: `provider:${filter}:${provider}`, expiresAt: now + ttlMs };
  }

  if (mode === "per-provider-account") {
    if (!accountId) return null;
    return {
      key: `provider-account:${filter}:${provider || "unknown-provider"}:${accountId}`,
      expiresAt: now + ttlMs,
    };
  }

  if (mode === "per-api-key") {
    const apiKeyId = nonEmptyString(context.apiKeyId);
    if (!apiKeyId) return null;
    return { key: `api-key:${filter}:${apiKeyId}`, expiresAt: now + ttlMs };
  }

  const bucket = Math.floor(now / ttlMs);
  const bucketExpiresAt = (bucket + 1) * ttlMs;
  return {
    key: `time-window:${filter}:${provider || "global"}:${bucket}`,
    expiresAt: bucketExpiresAt,
  };
}

function isExcludedProxy(proxy: RotatedProxy, excludeProxyIds: string[] | undefined): boolean {
  return Boolean(excludeProxyIds?.includes(proxy.id));
}

function clearStickyEntriesForProxy(proxy: unknown): void {
  const record = toRecord(proxy);
  const host = typeof record.host === "string" ? record.host : null;
  const port = Number(record.port);
  if (!host || !Number.isInteger(port)) return;

  for (const [key, entry] of stickyProxyCache.entries()) {
    if (entry.proxy.host === host && entry.proxy.port === port) {
      stickyProxyCache.delete(key);
    }
  }
}

function buildRotatingProxyResponse(
  proxy: RotatedProxy,
  rotatingProxy: RotatingProxySettings,
  connection: ProviderConnectionLike | null | undefined,
  stickyKey: string | null,
  policy: EffectiveRotatingProxyPolicy
) {
  return {
    proxy: proxyToContext(proxy),
    level: rotatingProxy.scope === "provider" ? "rotating-provider" : "rotating-global",
    levelId: rotatingProxy.scope === "provider" ? connection?.provider || null : null,
    source: "oneproxy-rotation",
    rotation: {
      proxyId: proxy.id,
      strategy: rotatingProxy.strategy,
      source: rotatingProxy.source,
      stickyMode: rotatingProxy.stickyMode,
      stickyKey,
      policyMode: policy.mode,
      failBehavior: policy.failBehavior,
      maxProxyRetries: policy.maxProxyRetries,
    },
  };
}

export async function resolveRotatingProxyForConnection(
  settings: { rotatingProxy?: unknown; rotatingProxyPolicy?: unknown },
  connection: ProviderConnectionLike | null | undefined,
  options: ResolveRotatingProxyOptions = {}
) {
  const rotatingProxy = normalizeRotatingProxySettings(settings.rotatingProxy);
  const policy = resolveRotatingProxyPolicy(settings.rotatingProxyPolicy, connection);

  if (policy.mode === "disabled") return null;
  if (!rotatingProxy.enabled && policy.mode !== "required") return null;
  if (rotatingProxy.scope === "provider" && !connection?.provider) return null;

  const effectiveRotatingProxy: RotatingProxySettings = {
    ...rotatingProxy,
    protocol: policy.protocol ?? rotatingProxy.protocol ?? null,
    countryCode: policy.countryCode ?? rotatingProxy.countryCode ?? null,
    minQuality: policy.minQuality ?? rotatingProxy.minQuality ?? null,
    stickyMode: policy.stickyMode ?? rotatingProxy.stickyMode,
    stickyTtlMinutes: policy.stickyTtlMinutes ?? rotatingProxy.stickyTtlMinutes,
  };

  const sticky = getStickyCacheKey(effectiveRotatingProxy, connection, options.stickyContext);
  if (sticky) {
    const cached = stickyProxyCache.get(sticky.key);
    if (
      cached &&
      cached.expiresAt > Date.now() &&
      !isExcludedProxy(cached.proxy, options.excludeProxyIds)
    ) {
      return buildRotatingProxyResponse(
        cached.proxy,
        effectiveRotatingProxy,
        connection,
        sticky.key,
        policy
      );
    }
    if (cached) stickyProxyCache.delete(sticky.key);
  }

  const proxy = await rotateOneproxyProxy({
    strategy: effectiveRotatingProxy.strategy,
    protocol: effectiveRotatingProxy.protocol || undefined,
    countryCode: effectiveRotatingProxy.countryCode || undefined,
    minQuality: effectiveRotatingProxy.minQuality ?? undefined,
    supportedProtocolsOnly: true,
    excludeIds: options.excludeProxyIds,
  });

  if (!proxy) {
    if (policy.mode === "required" && policy.failBehavior === "fail-closed") {
      throw new RotatingProxyRequiredError(
        "Rotating proxy is required but no eligible proxy is available",
        policy
      );
    }
    return null;
  }

  if (sticky) {
    stickyProxyCache.set(sticky.key, { proxy, expiresAt: sticky.expiresAt });
  }

  return buildRotatingProxyResponse(
    proxy,
    effectiveRotatingProxy,
    connection,
    sticky?.key || null,
    policy
  );
}

export function clearRotatingProxyStickyCacheForTests(): void {
  stickyProxyCache.clear();
}

export async function markRotatingProxyFailed(proxy: unknown, error?: unknown): Promise<boolean> {
  const record = toRecord(proxy);
  const host = typeof record.host === "string" ? record.host : null;
  const port = Number(record.port);
  if (!host || !Number.isInteger(port)) return false;
  clearStickyEntriesForProxy(proxy);
  return failOneproxyProxy(host, port, { error });
}

export async function markRotatingProxySucceeded(
  proxy: unknown,
  result: { latencyMs?: number | null } = {}
): Promise<boolean> {
  const record = toRecord(proxy);
  const host = typeof record.host === "string" ? record.host : null;
  const port = Number(record.port);
  if (!host || !Number.isInteger(port)) return false;
  return succeedOneproxyProxy(host, port, result);
}
