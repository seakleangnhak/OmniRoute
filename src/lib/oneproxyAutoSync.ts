import { getOneproxySyncStatus, syncOneproxyProxies } from "./oneproxySync";

type OneproxyAutoSyncSettings = {
  enabled?: boolean;
  intervalMinutes?: number | null;
  maxProxies?: number | null;
  minQuality?: number | null;
  syncOnStartup?: boolean;
};

type NormalizedOneproxyAutoSyncSettings = {
  enabled: boolean;
  intervalMinutes: number;
  maxProxies: number;
  minQuality: number;
  syncOnStartup: boolean;
};

const DEFAULT_INTERVAL_MINUTES = 360;
const DEFAULT_MAX_PROXIES = 500;
const DEFAULT_MIN_QUALITY = 50;
const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const STARTUP_DELAY_MS = 5_000;

let schedulerTimer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;
let isRunning = false;
let nextRunAt: string | null = null;
let currentSettings: NormalizedOneproxyAutoSyncSettings = normalizeOneproxyAutoSyncSettings(null);

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

export function normalizeOneproxyAutoSyncSettings(
  value: unknown
): NormalizedOneproxyAutoSyncSettings {
  const record = toRecord(value);
  return {
    enabled: record.enabled === true,
    intervalMinutes: clamp(
      normalizeInteger(record.intervalMinutes, DEFAULT_INTERVAL_MINUTES),
      MIN_INTERVAL_MINUTES,
      MAX_INTERVAL_MINUTES
    ),
    maxProxies: clamp(normalizeInteger(record.maxProxies, DEFAULT_MAX_PROXIES), 1, 1000),
    minQuality: clamp(normalizeInteger(record.minQuality, DEFAULT_MIN_QUALITY), 0, 100),
    syncOnStartup: record.syncOnStartup !== false,
  };
}

function getIntervalMs(settings: NormalizedOneproxyAutoSyncSettings): number {
  return settings.intervalMinutes * 60 * 1000;
}

function scheduleNextRun(settings: NormalizedOneproxyAutoSyncSettings): void {
  const intervalMs = getIntervalMs(settings);
  nextRunAt = new Date(Date.now() + intervalMs).toISOString();
  schedulerTimer = setInterval(() => {
    nextRunAt = new Date(Date.now() + intervalMs).toISOString();
    void runOneproxyAutoSyncCycle(settings);
  }, intervalMs);
  schedulerTimer.unref?.();
}

async function runOneproxyAutoSyncCycle(
  settings: NormalizedOneproxyAutoSyncSettings = currentSettings
): Promise<void> {
  if (!settings.enabled) return;
  if (isRunning) {
    console.log("[OneproxyAutoSync] Skipping cycle - previous run still in progress");
    return;
  }

  isRunning = true;
  const start = Date.now();
  try {
    const result = await syncOneproxyProxies({
      maxProxies: settings.maxProxies,
      minQuality: settings.minQuality,
    });
    if (result.success) {
      console.log(
        `[OneproxyAutoSync] Cycle complete: ${result.total} synced in ${Date.now() - start}ms`
      );
    } else {
      console.warn(`[OneproxyAutoSync] Cycle failed: ${result.error || "unknown error"}`);
    }
  } catch (error) {
    console.warn("[OneproxyAutoSync] Cycle failed:", (error as Error).message);
  } finally {
    isRunning = false;
  }
}

export function startOneproxyAutoSyncScheduler(settings: OneproxyAutoSyncSettings = {}): void {
  const normalized = normalizeOneproxyAutoSyncSettings(settings);

  stopOneproxyAutoSyncScheduler();
  currentSettings = normalized;

  if (!normalized.enabled) {
    return;
  }

  const intervalMs = getIntervalMs(normalized);
  const lastSyncAt = getOneproxySyncStatus().lastSyncAt;
  let initialDelayMs = normalized.syncOnStartup ? STARTUP_DELAY_MS : intervalMs;

  if (!normalized.syncOnStartup && lastSyncAt) {
    const lastRunMs = Date.parse(lastSyncAt);
    if (Number.isFinite(lastRunMs)) {
      const elapsedMs = Date.now() - lastRunMs;
      if (elapsedMs < intervalMs) {
        initialDelayMs = Math.max(intervalMs - elapsedMs, STARTUP_DELAY_MS);
      }
    }
  }

  nextRunAt = new Date(Date.now() + initialDelayMs).toISOString();
  console.log(`[OneproxyAutoSync] Scheduler started - interval: ${normalized.intervalMinutes}m`);

  startupTimer = setTimeout(() => {
    startupTimer = null;
    void runOneproxyAutoSyncCycle(normalized);
    scheduleNextRun(normalized);
  }, initialDelayMs);
  startupTimer.unref?.();
}

export function stopOneproxyAutoSyncScheduler(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }

  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    console.log("[OneproxyAutoSync] Scheduler stopped");
  }

  nextRunAt = null;
  currentSettings = { ...currentSettings, enabled: false };
}

export function getOneproxyAutoSyncStatus() {
  return {
    configured: currentSettings.enabled,
    active: Boolean(startupTimer || schedulerTimer),
    running: isRunning,
    intervalMinutes: currentSettings.intervalMinutes,
    maxProxies: currentSettings.maxProxies,
    minQuality: currentSettings.minQuality,
    syncOnStartup: currentSettings.syncOnStartup,
    nextRunAt,
  };
}
