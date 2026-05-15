import { request as undiciRequest } from "undici";
import {
  createProxyDispatcher,
  isSocks5ProxyEnabled,
  proxyConfigToUrl,
  proxyUrlForLogs,
} from "@omniroute/open-sse/utils/proxyDispatcher.ts";
import {
  listOneproxyProxiesForHealthValidation,
  recordOneproxyProxyHealthResult,
} from "./db/oneproxy";
import type { OneproxyProxyRecord } from "./db/oneproxy";

type OneproxyHealthValidatorSettings = {
  enabled?: boolean;
  intervalMinutes?: number | null;
  batchSize?: number | null;
  timeoutMs?: number | null;
  testUrl?: string | null;
  revalidateOlderThanMinutes?: number | null;
  maxFailures?: number | null;
  validateOnStartup?: boolean;
};

type NormalizedOneproxyHealthValidatorSettings = {
  enabled: boolean;
  intervalMinutes: number;
  batchSize: number;
  timeoutMs: number;
  testUrl: string;
  revalidateOlderThanMinutes: number;
  maxFailures: number;
  validateOnStartup: boolean;
};

type ProxyHealthCheckResult = {
  success: boolean;
  latencyMs: number | null;
  qualityScore?: number | null;
  error?: string | null;
  skipped?: boolean;
};

type ValidationCycleOptions = {
  force?: boolean;
  validateProxy?: (
    proxy: OneproxyProxyRecord,
    settings: NormalizedOneproxyHealthValidatorSettings
  ) => Promise<ProxyHealthCheckResult>;
};

type ValidationCycleResult = {
  success: boolean;
  skipped: boolean;
  checked: number;
  healthy: number;
  unhealthy: number;
  skippedProxies: number;
  deactivated: number;
  durationMs: number;
  error: string | null;
};

const DEFAULT_INTERVAL_MINUTES = 30;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_TEST_URL = "https://www.google.com/generate_204";
const DEFAULT_REVALIDATE_OLDER_THAN_MINUTES = 60;
const DEFAULT_MAX_FAILURES = 3;
const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 200;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 30000;
const MIN_REVALIDATE_OLDER_THAN_MINUTES = 5;
const MAX_REVALIDATE_OLDER_THAN_MINUTES = 30 * 24 * 60;
const MIN_MAX_FAILURES = 1;
const MAX_MAX_FAILURES = 10;
const STARTUP_DELAY_MS = 10_000;

let schedulerTimer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;
let isRunning = false;
let nextRunAt: string | null = null;
let lastRunAt: string | null = null;
let lastSuccess = false;
let lastError: string | null = null;
let lastChecked = 0;
let lastHealthy = 0;
let lastUnhealthy = 0;
let lastSkippedProxies = 0;
let currentSettings: NormalizedOneproxyHealthValidatorSettings =
  normalizeOneproxyHealthValidatorSettings(null);

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeInteger(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeTestUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) return DEFAULT_TEST_URL;

  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {}

  return DEFAULT_TEST_URL;
}

export function normalizeOneproxyHealthValidatorSettings(
  value: unknown
): NormalizedOneproxyHealthValidatorSettings {
  const record = toRecord(value);
  return {
    enabled: record.enabled === true,
    intervalMinutes: clamp(
      normalizeInteger(record.intervalMinutes, DEFAULT_INTERVAL_MINUTES),
      MIN_INTERVAL_MINUTES,
      MAX_INTERVAL_MINUTES
    ),
    batchSize: clamp(
      normalizeInteger(record.batchSize, DEFAULT_BATCH_SIZE),
      MIN_BATCH_SIZE,
      MAX_BATCH_SIZE
    ),
    timeoutMs: clamp(
      normalizeInteger(record.timeoutMs, DEFAULT_TIMEOUT_MS),
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS
    ),
    testUrl: normalizeTestUrl(record.testUrl),
    revalidateOlderThanMinutes: clamp(
      normalizeInteger(record.revalidateOlderThanMinutes, DEFAULT_REVALIDATE_OLDER_THAN_MINUTES),
      MIN_REVALIDATE_OLDER_THAN_MINUTES,
      MAX_REVALIDATE_OLDER_THAN_MINUTES
    ),
    maxFailures: clamp(
      normalizeInteger(record.maxFailures, DEFAULT_MAX_FAILURES),
      MIN_MAX_FAILURES,
      MAX_MAX_FAILURES
    ),
    validateOnStartup: record.validateOnStartup !== false,
  };
}

function getIntervalMs(settings: NormalizedOneproxyHealthValidatorSettings): number {
  return settings.intervalMinutes * 60 * 1000;
}

function qualityScoreForLatency(latencyMs: number): number {
  if (latencyMs <= 500) return 100;
  if (latencyMs <= 1000) return 95;
  if (latencyMs <= 2000) return 85;
  if (latencyMs <= 4000) return 70;
  if (latencyMs <= 8000) return 55;
  return 40;
}

function getValidationProtocols(): string[] {
  return isSocks5ProxyEnabled() ? ["http", "https", "socks5"] : ["http", "https"];
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "Validation timeout";
  if (error instanceof Error && error.message) return error.message;
  return String(error || "Validation failed");
}

export async function validateOneproxyProxy(
  proxy: OneproxyProxyRecord,
  settings: NormalizedOneproxyHealthValidatorSettings
): Promise<ProxyHealthCheckResult> {
  const proxyType = String(proxy.type || "http").toLowerCase();
  if (proxyType === "socks4") {
    return {
      success: false,
      skipped: true,
      latencyMs: null,
      error: "SOCKS4 is not supported by the upstream dispatcher",
    };
  }
  if (proxyType === "socks5" && !isSocks5ProxyEnabled()) {
    return {
      success: false,
      skipped: true,
      latencyMs: null,
      error: "SOCKS5 proxy validation is disabled",
    };
  }

  let proxyUrl: string;
  try {
    const normalizedProxyUrl = proxyConfigToUrl(
      {
        type: proxyType,
        host: proxy.host,
        port: proxy.port,
        username: "",
        password: "",
      },
      { allowSocks5: isSocks5ProxyEnabled() }
    );
    if (!normalizedProxyUrl) {
      return { success: false, latencyMs: null, error: "Invalid proxy configuration" };
    }
    proxyUrl = normalizedProxyUrl;
  } catch (error) {
    return { success: false, latencyMs: null, error: getErrorMessage(error) };
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.timeoutMs);

  try {
    const response = await undiciRequest(settings.testUrl, {
      method: "GET",
      dispatcher: createProxyDispatcher(proxyUrl),
      signal: controller.signal,
      headersTimeout: settings.timeoutMs,
      bodyTimeout: settings.timeoutMs,
    });
    await response.body.text().catch(() => "");

    const latencyMs = Date.now() - startedAt;
    const ok = response.statusCode >= 200 && response.statusCode < 400;
    return {
      success: ok,
      latencyMs,
      qualityScore: ok ? qualityScoreForLatency(latencyMs) : null,
      error: ok ? null : `HTTP ${response.statusCode} via ${proxyUrlForLogs(proxyUrl)}`,
    };
  } catch (error) {
    return {
      success: false,
      latencyMs: Date.now() - startedAt,
      error: getErrorMessage(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function runOneproxyHealthValidationCycle(
  settings: OneproxyHealthValidatorSettings = currentSettings,
  options: ValidationCycleOptions = {}
): Promise<ValidationCycleResult> {
  const normalized = normalizeOneproxyHealthValidatorSettings(settings);
  const startedAt = Date.now();

  if (!normalized.enabled && !options.force) {
    return {
      success: false,
      skipped: true,
      checked: 0,
      healthy: 0,
      unhealthy: 0,
      skippedProxies: 0,
      deactivated: 0,
      durationMs: 0,
      error: "Health validator is disabled",
    };
  }

  if (isRunning) {
    return {
      success: false,
      skipped: true,
      checked: 0,
      healthy: 0,
      unhealthy: 0,
      skippedProxies: 0,
      deactivated: 0,
      durationMs: Date.now() - startedAt,
      error: "Health validation already running",
    };
  }

  isRunning = true;
  let checked = 0;
  let healthy = 0;
  let unhealthy = 0;
  let skippedProxies = 0;
  let deactivated = 0;

  try {
    const staleBefore = new Date(
      Date.now() - normalized.revalidateOlderThanMinutes * 60 * 1000
    ).toISOString();
    const proxies = await listOneproxyProxiesForHealthValidation({
      limit: normalized.batchSize,
      staleBefore,
      protocols: getValidationProtocols(),
    });
    const validateProxy = options.validateProxy || validateOneproxyProxy;

    for (const proxy of proxies) {
      const result = await validateProxy(proxy, normalized);
      if (result.skipped) {
        skippedProxies += 1;
        continue;
      }

      checked += 1;
      const updated = await recordOneproxyProxyHealthResult(proxy.id, {
        success: result.success,
        latencyMs: result.latencyMs,
        qualityScore:
          result.qualityScore ??
          (result.success && result.latencyMs != null
            ? qualityScoreForLatency(result.latencyMs)
            : null),
        maxFailures: normalized.maxFailures,
        error: result.error,
      });

      if (result.success) {
        healthy += 1;
      } else {
        unhealthy += 1;
        if (updated?.status === "inactive") deactivated += 1;
      }
    }

    const durationMs = Date.now() - startedAt;
    lastRunAt = new Date().toISOString();
    lastSuccess = true;
    lastError = null;
    lastChecked = checked;
    lastHealthy = healthy;
    lastUnhealthy = unhealthy;
    lastSkippedProxies = skippedProxies;

    return {
      success: true,
      skipped: false,
      checked,
      healthy,
      unhealthy,
      skippedProxies,
      deactivated,
      durationMs,
      error: null,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    lastRunAt = new Date().toISOString();
    lastSuccess = false;
    lastError = getErrorMessage(error);
    lastChecked = checked;
    lastHealthy = healthy;
    lastUnhealthy = unhealthy;
    lastSkippedProxies = skippedProxies;

    return {
      success: false,
      skipped: false,
      checked,
      healthy,
      unhealthy,
      skippedProxies,
      deactivated,
      durationMs,
      error: lastError,
    };
  } finally {
    isRunning = false;
  }
}

function scheduleNextRun(settings: NormalizedOneproxyHealthValidatorSettings): void {
  const intervalMs = getIntervalMs(settings);
  nextRunAt = new Date(Date.now() + intervalMs).toISOString();
  schedulerTimer = setInterval(() => {
    nextRunAt = new Date(Date.now() + intervalMs).toISOString();
    void runOneproxyHealthValidationCycle(settings);
  }, intervalMs);
  schedulerTimer.unref?.();
}

export function startOneproxyHealthValidatorScheduler(
  settings: OneproxyHealthValidatorSettings = {}
): void {
  const normalized = normalizeOneproxyHealthValidatorSettings(settings);

  stopOneproxyHealthValidatorScheduler();
  currentSettings = normalized;

  if (!normalized.enabled) {
    return;
  }

  const intervalMs = getIntervalMs(normalized);
  const initialDelayMs = normalized.validateOnStartup ? STARTUP_DELAY_MS : intervalMs;
  nextRunAt = new Date(Date.now() + initialDelayMs).toISOString();
  console.log(
    `[OneproxyHealthValidator] Scheduler started - interval: ${normalized.intervalMinutes}m, batch: ${normalized.batchSize}`
  );

  startupTimer = setTimeout(() => {
    startupTimer = null;
    void runOneproxyHealthValidationCycle(normalized);
    scheduleNextRun(normalized);
  }, initialDelayMs);
  startupTimer.unref?.();
}

export function stopOneproxyHealthValidatorScheduler(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }

  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    console.log("[OneproxyHealthValidator] Scheduler stopped");
  }

  nextRunAt = null;
  currentSettings = { ...currentSettings, enabled: false };
}

export function getOneproxyHealthValidatorStatus() {
  return {
    configured: currentSettings.enabled,
    active: Boolean(startupTimer || schedulerTimer),
    running: isRunning,
    intervalMinutes: currentSettings.intervalMinutes,
    batchSize: currentSettings.batchSize,
    timeoutMs: currentSettings.timeoutMs,
    testUrl: currentSettings.testUrl,
    revalidateOlderThanMinutes: currentSettings.revalidateOlderThanMinutes,
    maxFailures: currentSettings.maxFailures,
    validateOnStartup: currentSettings.validateOnStartup,
    nextRunAt,
    lastRunAt,
    lastSuccess,
    lastError,
    lastChecked,
    lastHealthy,
    lastUnhealthy,
    lastSkippedProxies,
  };
}
