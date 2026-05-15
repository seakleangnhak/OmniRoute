import { cleanupOneproxyProxyEvents } from "./db/oneproxy";

type OneproxyObservabilitySettings = {
  retentionDays?: number | null;
  cleanupIntervalMinutes?: number | null;
  cleanupOnStartup?: boolean;
  alertsEnabled?: boolean;
  minActiveProxies?: number | null;
  minSuccessRate?: number | null;
  maxQuarantineRate?: number | null;
};

type NormalizedOneproxyObservabilitySettings = {
  retentionDays: number;
  cleanupIntervalMinutes: number;
  cleanupOnStartup: boolean;
  alertsEnabled: boolean;
  minActiveProxies: number;
  minSuccessRate: number;
  maxQuarantineRate: number;
};

type CleanupCycleResult = {
  success: boolean;
  skipped: boolean;
  deleted: number;
  before: string | null;
  durationMs: number;
  error: string | null;
};

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_CLEANUP_INTERVAL_MINUTES = 360;
const DEFAULT_MIN_ACTIVE_PROXIES = 10;
const DEFAULT_MIN_SUCCESS_RATE = 80;
const DEFAULT_MAX_QUARANTINE_RATE = 25;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 365;
const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const STARTUP_DELAY_MS = 15_000;

let schedulerTimer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;
let isRunning = false;
let nextRunAt: string | null = null;
let lastRunAt: string | null = null;
let lastSuccess = false;
let lastError: string | null = null;
let lastDeleted = 0;
let currentSettings: NormalizedOneproxyObservabilitySettings =
  normalizeOneproxyObservabilitySettings(null);

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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error || "Observability cleanup failed");
}

export function normalizeOneproxyObservabilitySettings(
  value: unknown
): NormalizedOneproxyObservabilitySettings {
  const record = toRecord(value);
  return {
    retentionDays: clamp(
      normalizeInteger(record.retentionDays, DEFAULT_RETENTION_DAYS),
      MIN_RETENTION_DAYS,
      MAX_RETENTION_DAYS
    ),
    cleanupIntervalMinutes: clamp(
      normalizeInteger(record.cleanupIntervalMinutes, DEFAULT_CLEANUP_INTERVAL_MINUTES),
      MIN_INTERVAL_MINUTES,
      MAX_INTERVAL_MINUTES
    ),
    cleanupOnStartup: record.cleanupOnStartup !== false,
    alertsEnabled: record.alertsEnabled !== false,
    minActiveProxies: clamp(
      normalizeInteger(record.minActiveProxies, DEFAULT_MIN_ACTIVE_PROXIES),
      0,
      100000
    ),
    minSuccessRate: clamp(
      normalizeInteger(record.minSuccessRate, DEFAULT_MIN_SUCCESS_RATE),
      0,
      100
    ),
    maxQuarantineRate: clamp(
      normalizeInteger(record.maxQuarantineRate, DEFAULT_MAX_QUARANTINE_RATE),
      0,
      100
    ),
  };
}

function getIntervalMs(settings: NormalizedOneproxyObservabilitySettings): number {
  return settings.cleanupIntervalMinutes * 60 * 1000;
}

export async function runOneproxyObservabilityCleanupCycle(
  settings: OneproxyObservabilitySettings = currentSettings,
  options: { force?: boolean } = {}
): Promise<CleanupCycleResult> {
  const normalized = normalizeOneproxyObservabilitySettings(settings);
  const startedAt = Date.now();

  if (isRunning && !options.force) {
    return {
      success: false,
      skipped: true,
      deleted: 0,
      before: null,
      durationMs: Date.now() - startedAt,
      error: "Observability cleanup already running",
    };
  }

  isRunning = true;
  try {
    const result = await cleanupOneproxyProxyEvents({ retentionDays: normalized.retentionDays });
    const durationMs = Date.now() - startedAt;
    lastRunAt = new Date().toISOString();
    lastSuccess = true;
    lastError = null;
    lastDeleted = result.deleted;

    return {
      success: true,
      skipped: false,
      deleted: result.deleted,
      before: result.before,
      durationMs,
      error: null,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    lastRunAt = new Date().toISOString();
    lastSuccess = false;
    lastError = getErrorMessage(error);

    return {
      success: false,
      skipped: false,
      deleted: 0,
      before: null,
      durationMs,
      error: lastError,
    };
  } finally {
    isRunning = false;
  }
}

function scheduleNextRun(settings: NormalizedOneproxyObservabilitySettings): void {
  const intervalMs = getIntervalMs(settings);
  nextRunAt = new Date(Date.now() + intervalMs).toISOString();
  schedulerTimer = setInterval(() => {
    nextRunAt = new Date(Date.now() + intervalMs).toISOString();
    void runOneproxyObservabilityCleanupCycle(settings);
  }, intervalMs);
  schedulerTimer.unref?.();
}

export function startOneproxyObservabilityScheduler(
  settings: OneproxyObservabilitySettings = {}
): void {
  const normalized = normalizeOneproxyObservabilitySettings(settings);

  stopOneproxyObservabilityScheduler();
  currentSettings = normalized;

  const intervalMs = getIntervalMs(normalized);
  const initialDelayMs = normalized.cleanupOnStartup ? STARTUP_DELAY_MS : intervalMs;
  nextRunAt = new Date(Date.now() + initialDelayMs).toISOString();
  console.log(
    "[OneproxyObservability] Cleanup scheduler started - retention: " +
      normalized.retentionDays +
      "d, interval: " +
      normalized.cleanupIntervalMinutes +
      "m"
  );

  startupTimer = setTimeout(() => {
    startupTimer = null;
    void runOneproxyObservabilityCleanupCycle(normalized);
    scheduleNextRun(normalized);
  }, initialDelayMs);
  startupTimer.unref?.();
}

export function stopOneproxyObservabilityScheduler(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }

  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    console.log("[OneproxyObservability] Cleanup scheduler stopped");
  }

  nextRunAt = null;
}

export function getOneproxyObservabilityStatus() {
  return {
    active: Boolean(startupTimer || schedulerTimer),
    running: isRunning,
    retentionDays: currentSettings.retentionDays,
    cleanupIntervalMinutes: currentSettings.cleanupIntervalMinutes,
    cleanupOnStartup: currentSettings.cleanupOnStartup,
    alertsEnabled: currentSettings.alertsEnabled,
    minActiveProxies: currentSettings.minActiveProxies,
    minSuccessRate: currentSettings.minSuccessRate,
    maxQuarantineRate: currentSettings.maxQuarantineRate,
    nextRunAt,
    lastRunAt,
    lastSuccess,
    lastError,
    lastDeleted,
  };
}
