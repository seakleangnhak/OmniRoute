import { clearHealthCheckLogCache } from "@/lib/tokenHealthCheck";

type JsonRecord = Record<string, unknown>;

export type RuntimeReloadSection =
  | "payloadRules"
  | "modelAliases"
  | "backgroundDegradation"
  | "cliCompatProviders"
  | "cacheControl"
  | "usageTracking"
  | "healthCheckLogs"
  | "thoughtSignature"
  | "modelsDevSync"
  | "oneproxyAutoSync"
  | "oneproxyHealthValidator"
  | "oneproxyObservability"
  | "corsOrigins";

export interface RuntimeReloadChange {
  section: RuntimeReloadSection;
  source: string;
}

interface RuntimeSettingsSnapshot {
  payloadRules: unknown;
  modelAliases: Record<string, string>;
  backgroundDegradation: JsonRecord | null;
  cliCompatProviders: string[];
  alwaysPreserveClientCache: string;
  antigravitySignatureCacheMode: string;
  usageTokenBuffer: unknown;
  hideHealthCheckLogs: boolean;
  modelsDevSyncEnabled: boolean;
  modelsDevSyncInterval: number | null;
  oneproxyAutoSyncEnabled: boolean;
  oneproxyAutoSyncIntervalMinutes: number;
  oneproxyAutoSyncMaxProxies: number;
  oneproxyAutoSyncMinQuality: number;
  oneproxyAutoSyncOnStartup: boolean;
  oneproxyHealthEnabled: boolean;
  oneproxyHealthIntervalMinutes: number;
  oneproxyHealthBatchSize: number;
  oneproxyHealthTimeoutMs: number;
  oneproxyHealthTestUrl: string;
  oneproxyHealthRevalidateOlderThanMinutes: number;
  oneproxyHealthMaxFailures: number;
  oneproxyHealthValidateOnStartup: boolean;
  oneproxyObservabilityRetentionDays: number;
  oneproxyObservabilityCleanupIntervalMinutes: number;
  oneproxyObservabilityCleanupOnStartup: boolean;
  oneproxyObservabilityAlertsEnabled: boolean;
  oneproxyObservabilityMinActiveProxies: number;
  oneproxyObservabilityMinSuccessRate: number;
  oneproxyObservabilityMaxQuarantineRate: number;
  corsOrigins: string;
}

const DEFAULT_RUNTIME_SETTINGS_SNAPSHOT: RuntimeSettingsSnapshot = {
  payloadRules: null,
  modelAliases: {},
  backgroundDegradation: null,
  cliCompatProviders: [],
  alwaysPreserveClientCache: "auto",
  antigravitySignatureCacheMode: "enabled",
  usageTokenBuffer: null,
  hideHealthCheckLogs: false,
  modelsDevSyncEnabled: false,
  modelsDevSyncInterval: null,
  oneproxyAutoSyncEnabled: false,
  oneproxyAutoSyncIntervalMinutes: 360,
  oneproxyAutoSyncMaxProxies: 500,
  oneproxyAutoSyncMinQuality: 50,
  oneproxyAutoSyncOnStartup: true,
  oneproxyHealthEnabled: false,
  oneproxyHealthIntervalMinutes: 30,
  oneproxyHealthBatchSize: 25,
  oneproxyHealthTimeoutMs: 8000,
  oneproxyHealthTestUrl: "https://www.google.com/generate_204",
  oneproxyHealthRevalidateOlderThanMinutes: 60,
  oneproxyHealthMaxFailures: 3,
  oneproxyHealthValidateOnStartup: true,
  oneproxyObservabilityRetentionDays: 30,
  oneproxyObservabilityCleanupIntervalMinutes: 360,
  oneproxyObservabilityCleanupOnStartup: true,
  oneproxyObservabilityAlertsEnabled: true,
  oneproxyObservabilityMinActiveProxies: 10,
  oneproxyObservabilityMinSuccessRate: 80,
  oneproxyObservabilityMaxQuarantineRate: 25,
  corsOrigins: "",
};

let lastAppliedSnapshot: RuntimeSettingsSnapshot | null = null;

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (typeof value !== "string") return false;
  return new Set(["1", "true", "yes", "on"]).has(value.trim().toLowerCase());
}

function isAutomatedTestProcess(): boolean {
  return (
    typeof process !== "undefined" &&
    (process.env.NODE_ENV === "test" ||
      process.env.VITEST !== undefined ||
      process.argv.some((arg) => arg.includes("test")))
  );
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as JsonRecord)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [key, canonicalize((value as JsonRecord)[key])])
    );
  }

  return value;
}

function parseStoredJson(value: unknown, field: string): unknown {
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch (error) {
    console.warn(
      `[HOT_RELOAD] Failed to parse persisted settings field "${field}":`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return Array.from(
    new Set(
      value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0)
    )
  );
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  const record = toRecord(parseStoredJson(value, "modelAliases"));
  const entries = Object.entries(record)
    .map(([key, entryValue]) => [
      key.trim(),
      typeof entryValue === "string" ? entryValue.trim() : "",
    ])
    .filter(([key, entryValue]) => key.length > 0 && entryValue.length > 0);

  return Object.fromEntries(entries);
}

function normalizeBackgroundDegradation(value: unknown): JsonRecord | null {
  const record = toRecord(parseStoredJson(value, "backgroundDegradation"));
  if (Object.keys(record).length === 0) return null;

  const degradationMap = Object.fromEntries(
    Object.entries(toRecord(record.degradationMap))
      .map(([key, entryValue]) => [
        key.trim(),
        typeof entryValue === "string" ? entryValue.trim() : "",
      ])
      .filter(([key, entryValue]) => key.length > 0 && entryValue.length > 0)
  );
  const detectionPatterns = normalizeStringArray(record.detectionPatterns);

  return {
    enabled: record.enabled === true,
    degradationMap,
    detectionPatterns,
  };
}

function normalizeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeInteger(value: unknown, fallback: number): number {
  const normalized = normalizeNumber(value);
  return normalized === null ? fallback : Math.trunc(normalized);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizePayloadRules(value: unknown): unknown {
  return parseStoredJson(value, "payloadRules");
}

export function buildRuntimeSettingsSnapshot(
  settings: Record<string, unknown>
): RuntimeSettingsSnapshot {
  return {
    payloadRules: normalizePayloadRules(settings.payloadRules),
    modelAliases: normalizeStringRecord(settings.modelAliases),
    backgroundDegradation: normalizeBackgroundDegradation(settings.backgroundDegradation),
    cliCompatProviders: normalizeStringArray(settings.cliCompatProviders),
    alwaysPreserveClientCache:
      typeof settings.alwaysPreserveClientCache === "string"
        ? settings.alwaysPreserveClientCache
        : DEFAULT_RUNTIME_SETTINGS_SNAPSHOT.alwaysPreserveClientCache,
    antigravitySignatureCacheMode:
      typeof settings.antigravitySignatureCacheMode === "string"
        ? settings.antigravitySignatureCacheMode
        : DEFAULT_RUNTIME_SETTINGS_SNAPSHOT.antigravitySignatureCacheMode,
    usageTokenBuffer: settings.usageTokenBuffer ?? null,
    hideHealthCheckLogs: settings.hideHealthCheckLogs === true,
    modelsDevSyncEnabled: settings.modelsDevSyncEnabled === true,
    modelsDevSyncInterval: normalizeNumber(settings.modelsDevSyncInterval),
    oneproxyAutoSyncEnabled: toRecord(settings.oneproxySync).enabled === true,
    oneproxyAutoSyncIntervalMinutes: clampNumber(
      normalizeInteger(toRecord(settings.oneproxySync).intervalMinutes, 360),
      5,
      10080
    ),
    oneproxyAutoSyncMaxProxies: clampNumber(
      normalizeInteger(toRecord(settings.oneproxySync).maxProxies, 500),
      1,
      1000
    ),
    oneproxyAutoSyncMinQuality: clampNumber(
      normalizeInteger(toRecord(settings.oneproxySync).minQuality, 50),
      0,
      100
    ),
    oneproxyAutoSyncOnStartup: toRecord(settings.oneproxySync).syncOnStartup !== false,
    oneproxyHealthEnabled: toRecord(settings.oneproxyHealth).enabled === true,
    oneproxyHealthIntervalMinutes: clampNumber(
      normalizeInteger(toRecord(settings.oneproxyHealth).intervalMinutes, 30),
      5,
      10080
    ),
    oneproxyHealthBatchSize: clampNumber(
      normalizeInteger(toRecord(settings.oneproxyHealth).batchSize, 25),
      1,
      200
    ),
    oneproxyHealthTimeoutMs: clampNumber(
      normalizeInteger(toRecord(settings.oneproxyHealth).timeoutMs, 8000),
      1000,
      30000
    ),
    oneproxyHealthTestUrl:
      typeof toRecord(settings.oneproxyHealth).testUrl === "string"
        ? String(toRecord(settings.oneproxyHealth).testUrl)
        : DEFAULT_RUNTIME_SETTINGS_SNAPSHOT.oneproxyHealthTestUrl,
    oneproxyHealthRevalidateOlderThanMinutes: clampNumber(
      normalizeInteger(toRecord(settings.oneproxyHealth).revalidateOlderThanMinutes, 60),
      5,
      43200
    ),
    oneproxyHealthMaxFailures: clampNumber(
      normalizeInteger(toRecord(settings.oneproxyHealth).maxFailures, 3),
      1,
      10
    ),
    oneproxyHealthValidateOnStartup: toRecord(settings.oneproxyHealth).validateOnStartup !== false,
    oneproxyObservabilityRetentionDays: clampNumber(
      normalizeInteger(toRecord(settings.oneproxyObservability).retentionDays, 30),
      1,
      365
    ),
    oneproxyObservabilityCleanupIntervalMinutes: clampNumber(
      normalizeInteger(toRecord(settings.oneproxyObservability).cleanupIntervalMinutes, 360),
      5,
      10080
    ),
    oneproxyObservabilityCleanupOnStartup:
      toRecord(settings.oneproxyObservability).cleanupOnStartup !== false,
    oneproxyObservabilityAlertsEnabled:
      toRecord(settings.oneproxyObservability).alertsEnabled !== false,
    oneproxyObservabilityMinActiveProxies: clampNumber(
      normalizeInteger(toRecord(settings.oneproxyObservability).minActiveProxies, 10),
      0,
      100000
    ),
    oneproxyObservabilityMinSuccessRate: clampNumber(
      normalizeInteger(toRecord(settings.oneproxyObservability).minSuccessRate, 80),
      0,
      100
    ),
    oneproxyObservabilityMaxQuarantineRate: clampNumber(
      normalizeInteger(toRecord(settings.oneproxyObservability).maxQuarantineRate, 25),
      0,
      100
    ),
    corsOrigins: typeof settings.corsOrigins === "string" ? settings.corsOrigins : "",
  };
}

function getPreviousSnapshot(): RuntimeSettingsSnapshot {
  return lastAppliedSnapshot || DEFAULT_RUNTIME_SETTINGS_SNAPSHOT;
}

async function applyPayloadRulesSection(payloadRules: unknown) {
  const { clearPayloadRulesConfigOverride, setPayloadRulesConfig } =
    await import("@omniroute/open-sse/services/payloadRules.ts");

  if (payloadRules === null || payloadRules === undefined) {
    clearPayloadRulesConfigOverride();
    return;
  }

  setPayloadRulesConfig(payloadRules);
}

async function applyModelAliasesSection(modelAliases: Record<string, string>) {
  const { setCustomAliases } = await import("@omniroute/open-sse/services/modelDeprecation.ts");
  setCustomAliases(modelAliases);
}

async function applyBackgroundDegradationSection(backgroundDegradation: JsonRecord | null) {
  const { getDefaultDegradationMap, getDefaultDetectionPatterns, setBackgroundDegradationConfig } =
    await import("@omniroute/open-sse/services/backgroundTaskDetector.ts");

  if (!backgroundDegradation) {
    setBackgroundDegradationConfig({
      enabled: false,
      degradationMap: getDefaultDegradationMap(),
      detectionPatterns: getDefaultDetectionPatterns(),
    });
    return;
  }

  setBackgroundDegradationConfig({
    enabled: backgroundDegradation.enabled === true,
    degradationMap: {
      ...getDefaultDegradationMap(),
      ...normalizeStringRecord(backgroundDegradation.degradationMap),
    },
    detectionPatterns:
      normalizeStringArray(backgroundDegradation.detectionPatterns).length > 0
        ? normalizeStringArray(backgroundDegradation.detectionPatterns)
        : getDefaultDetectionPatterns(),
  });
}

async function applyCliCompatProvidersSection(cliCompatProviders: string[]) {
  const { setCliCompatProviders } = await import("@omniroute/open-sse/config/cliFingerprints");
  setCliCompatProviders(cliCompatProviders);
}

async function applyCacheControlSection() {
  const { invalidateCacheControlSettingsCache } = await import("@/lib/cacheControlSettings");
  invalidateCacheControlSettingsCache();
}

async function applyUsageTrackingSection() {
  const { invalidateBufferTokensCache } =
    await import("@omniroute/open-sse/utils/usageTracking.ts");
  invalidateBufferTokensCache();
}

async function applyThoughtSignatureSection(mode: string) {
  const { setGeminiThoughtSignatureMode } =
    await import("@omniroute/open-sse/services/geminiThoughtSignatureStore.ts");
  setGeminiThoughtSignatureMode(mode);
}

async function applyCorsOriginsSection(corsOrigins: string) {
  const { setRuntimeAllowedOrigins } = await import("@/server/cors/origins");
  setRuntimeAllowedOrigins(corsOrigins);
}

async function applyOneproxyAutoSyncSection(
  previousSnapshot: RuntimeSettingsSnapshot,
  currentSnapshot: RuntimeSettingsSnapshot,
  force: boolean
) {
  const { startOneproxyAutoSyncScheduler, stopOneproxyAutoSyncScheduler } =
    await import("@/lib/oneproxyAutoSync");
  const skipBackgroundSyncInTests =
    (isAutomatedTestProcess() && process.env.OMNIROUTE_ENABLE_RUNTIME_BACKGROUND_TASKS !== "1") ||
    isTruthyEnvFlag(process.env.OMNIROUTE_DISABLE_BACKGROUND_SERVICES);

  if (skipBackgroundSyncInTests) {
    stopOneproxyAutoSyncScheduler();
    return;
  }

  const wasEnabled = previousSnapshot.oneproxyAutoSyncEnabled === true;
  const isEnabled = currentSnapshot.oneproxyAutoSyncEnabled === true;
  const configChanged =
    previousSnapshot.oneproxyAutoSyncIntervalMinutes !==
      currentSnapshot.oneproxyAutoSyncIntervalMinutes ||
    previousSnapshot.oneproxyAutoSyncMaxProxies !== currentSnapshot.oneproxyAutoSyncMaxProxies ||
    previousSnapshot.oneproxyAutoSyncMinQuality !== currentSnapshot.oneproxyAutoSyncMinQuality ||
    previousSnapshot.oneproxyAutoSyncOnStartup !== currentSnapshot.oneproxyAutoSyncOnStartup;

  if (!isEnabled) {
    if (wasEnabled || force) {
      stopOneproxyAutoSyncScheduler();
    }
    return;
  }

  if (force || !wasEnabled || configChanged) {
    startOneproxyAutoSyncScheduler({
      enabled: true,
      intervalMinutes: currentSnapshot.oneproxyAutoSyncIntervalMinutes,
      maxProxies: currentSnapshot.oneproxyAutoSyncMaxProxies,
      minQuality: currentSnapshot.oneproxyAutoSyncMinQuality,
      syncOnStartup: currentSnapshot.oneproxyAutoSyncOnStartup,
    });
  }
}

async function applyOneproxyHealthValidatorSection(
  previousSnapshot: RuntimeSettingsSnapshot,
  currentSnapshot: RuntimeSettingsSnapshot,
  force: boolean
) {
  const { startOneproxyHealthValidatorScheduler, stopOneproxyHealthValidatorScheduler } =
    await import("@/lib/oneproxyHealthValidator");
  const skipBackgroundSyncInTests =
    (isAutomatedTestProcess() && process.env.OMNIROUTE_ENABLE_RUNTIME_BACKGROUND_TASKS !== "1") ||
    isTruthyEnvFlag(process.env.OMNIROUTE_DISABLE_BACKGROUND_SERVICES);

  if (skipBackgroundSyncInTests) {
    stopOneproxyHealthValidatorScheduler();
    return;
  }

  const wasEnabled = previousSnapshot.oneproxyHealthEnabled === true;
  const isEnabled = currentSnapshot.oneproxyHealthEnabled === true;
  const configChanged =
    previousSnapshot.oneproxyHealthIntervalMinutes !==
      currentSnapshot.oneproxyHealthIntervalMinutes ||
    previousSnapshot.oneproxyHealthBatchSize !== currentSnapshot.oneproxyHealthBatchSize ||
    previousSnapshot.oneproxyHealthTimeoutMs !== currentSnapshot.oneproxyHealthTimeoutMs ||
    previousSnapshot.oneproxyHealthTestUrl !== currentSnapshot.oneproxyHealthTestUrl ||
    previousSnapshot.oneproxyHealthRevalidateOlderThanMinutes !==
      currentSnapshot.oneproxyHealthRevalidateOlderThanMinutes ||
    previousSnapshot.oneproxyHealthMaxFailures !== currentSnapshot.oneproxyHealthMaxFailures ||
    previousSnapshot.oneproxyHealthValidateOnStartup !==
      currentSnapshot.oneproxyHealthValidateOnStartup;

  if (!isEnabled) {
    if (wasEnabled || force) {
      stopOneproxyHealthValidatorScheduler();
    }
    return;
  }

  if (force || !wasEnabled || configChanged) {
    startOneproxyHealthValidatorScheduler({
      enabled: true,
      intervalMinutes: currentSnapshot.oneproxyHealthIntervalMinutes,
      batchSize: currentSnapshot.oneproxyHealthBatchSize,
      timeoutMs: currentSnapshot.oneproxyHealthTimeoutMs,
      testUrl: currentSnapshot.oneproxyHealthTestUrl,
      revalidateOlderThanMinutes: currentSnapshot.oneproxyHealthRevalidateOlderThanMinutes,
      maxFailures: currentSnapshot.oneproxyHealthMaxFailures,
      validateOnStartup: currentSnapshot.oneproxyHealthValidateOnStartup,
    });
  }
}

async function applyOneproxyObservabilitySection(
  previousSnapshot: RuntimeSettingsSnapshot,
  currentSnapshot: RuntimeSettingsSnapshot,
  force: boolean
) {
  const { startOneproxyObservabilityScheduler, stopOneproxyObservabilityScheduler } =
    await import("@/lib/oneproxyObservability");
  const skipBackgroundSyncInTests =
    (isAutomatedTestProcess() && process.env.OMNIROUTE_ENABLE_RUNTIME_BACKGROUND_TASKS !== "1") ||
    isTruthyEnvFlag(process.env.OMNIROUTE_DISABLE_BACKGROUND_SERVICES);

  if (skipBackgroundSyncInTests) {
    stopOneproxyObservabilityScheduler();
    return;
  }

  const configChanged =
    previousSnapshot.oneproxyObservabilityRetentionDays !==
      currentSnapshot.oneproxyObservabilityRetentionDays ||
    previousSnapshot.oneproxyObservabilityCleanupIntervalMinutes !==
      currentSnapshot.oneproxyObservabilityCleanupIntervalMinutes ||
    previousSnapshot.oneproxyObservabilityCleanupOnStartup !==
      currentSnapshot.oneproxyObservabilityCleanupOnStartup ||
    previousSnapshot.oneproxyObservabilityAlertsEnabled !==
      currentSnapshot.oneproxyObservabilityAlertsEnabled ||
    previousSnapshot.oneproxyObservabilityMinActiveProxies !==
      currentSnapshot.oneproxyObservabilityMinActiveProxies ||
    previousSnapshot.oneproxyObservabilityMinSuccessRate !==
      currentSnapshot.oneproxyObservabilityMinSuccessRate ||
    previousSnapshot.oneproxyObservabilityMaxQuarantineRate !==
      currentSnapshot.oneproxyObservabilityMaxQuarantineRate;

  if (force || configChanged) {
    startOneproxyObservabilityScheduler({
      retentionDays: currentSnapshot.oneproxyObservabilityRetentionDays,
      cleanupIntervalMinutes: currentSnapshot.oneproxyObservabilityCleanupIntervalMinutes,
      cleanupOnStartup: currentSnapshot.oneproxyObservabilityCleanupOnStartup,
      alertsEnabled: currentSnapshot.oneproxyObservabilityAlertsEnabled,
      minActiveProxies: currentSnapshot.oneproxyObservabilityMinActiveProxies,
      minSuccessRate: currentSnapshot.oneproxyObservabilityMinSuccessRate,
      maxQuarantineRate: currentSnapshot.oneproxyObservabilityMaxQuarantineRate,
    });
  }
}
async function applyModelsDevSyncSection(
  previousSnapshot: RuntimeSettingsSnapshot,
  currentSnapshot: RuntimeSettingsSnapshot,
  force: boolean
) {
  const { startPeriodicSync, stopPeriodicSync } = await import("@/lib/modelsDevSync");
  const skipBackgroundSyncInTests =
    (isAutomatedTestProcess() && process.env.OMNIROUTE_ENABLE_RUNTIME_BACKGROUND_TASKS !== "1") ||
    isTruthyEnvFlag(process.env.OMNIROUTE_DISABLE_BACKGROUND_SERVICES);

  if (skipBackgroundSyncInTests) {
    stopPeriodicSync();
    return;
  }

  const wasEnabled = previousSnapshot.modelsDevSyncEnabled === true;
  const isEnabled = currentSnapshot.modelsDevSyncEnabled === true;
  const intervalChanged =
    previousSnapshot.modelsDevSyncInterval !== currentSnapshot.modelsDevSyncInterval;

  if (!isEnabled) {
    if (wasEnabled || force) {
      stopPeriodicSync();
    }
    return;
  }

  if (force) {
    stopPeriodicSync();
    startPeriodicSync(currentSnapshot.modelsDevSyncInterval || undefined);
    return;
  }

  if (!wasEnabled) {
    startPeriodicSync(currentSnapshot.modelsDevSyncInterval || undefined);
    return;
  }

  if (intervalChanged) {
    stopPeriodicSync();
    startPeriodicSync(currentSnapshot.modelsDevSyncInterval || undefined);
  }
}

export async function applyRuntimeSettings(
  settings: Record<string, unknown>,
  options: { force?: boolean; source?: string } = {}
): Promise<RuntimeReloadChange[]> {
  const source = options.source || "runtime";
  const force = options.force === true;
  const hasBootstrappedSnapshot = lastAppliedSnapshot !== null;
  const currentSnapshot = buildRuntimeSettingsSnapshot(settings);
  const previousSnapshot = getPreviousSnapshot();
  const changes: RuntimeReloadChange[] = [];

  const markChanged = (section: RuntimeReloadSection) => {
    changes.push({ section, source });
  };

  const hasChanged = <T>(currentValue: T, previousValue: T) =>
    stableSerialize(currentValue) !== stableSerialize(previousValue);

  if (force || hasChanged(currentSnapshot.payloadRules, previousSnapshot.payloadRules)) {
    await applyPayloadRulesSection(currentSnapshot.payloadRules);
    markChanged("payloadRules");
  }

  if (force || hasChanged(currentSnapshot.modelAliases, previousSnapshot.modelAliases)) {
    await applyModelAliasesSection(currentSnapshot.modelAliases);
    markChanged("modelAliases");
  }

  if (
    force ||
    hasChanged(currentSnapshot.backgroundDegradation, previousSnapshot.backgroundDegradation)
  ) {
    await applyBackgroundDegradationSection(currentSnapshot.backgroundDegradation);
    markChanged("backgroundDegradation");
  }

  if (
    force ||
    hasChanged(currentSnapshot.cliCompatProviders, previousSnapshot.cliCompatProviders)
  ) {
    await applyCliCompatProvidersSection(currentSnapshot.cliCompatProviders);
    markChanged("cliCompatProviders");
  }

  if (
    force ||
    hasChanged(
      currentSnapshot.alwaysPreserveClientCache,
      previousSnapshot.alwaysPreserveClientCache
    )
  ) {
    await applyCacheControlSection();
    markChanged("cacheControl");
  }

  if (force || hasChanged(currentSnapshot.usageTokenBuffer, previousSnapshot.usageTokenBuffer)) {
    await applyUsageTrackingSection();
    markChanged("usageTracking");
  }

  if (force || currentSnapshot.hideHealthCheckLogs !== previousSnapshot.hideHealthCheckLogs) {
    clearHealthCheckLogCache();
    markChanged("healthCheckLogs");
  }

  if (
    force ||
    hasChanged(
      currentSnapshot.antigravitySignatureCacheMode,
      previousSnapshot.antigravitySignatureCacheMode
    )
  ) {
    await applyThoughtSignatureSection(currentSnapshot.antigravitySignatureCacheMode);
    markChanged("thoughtSignature");
  }

  if (
    force ||
    (hasBootstrappedSnapshot &&
      (currentSnapshot.modelsDevSyncEnabled !== previousSnapshot.modelsDevSyncEnabled ||
        currentSnapshot.modelsDevSyncInterval !== previousSnapshot.modelsDevSyncInterval))
  ) {
    await applyModelsDevSyncSection(previousSnapshot, currentSnapshot, force);
    markChanged("modelsDevSync");
  }

  if (
    force ||
    (hasBootstrappedSnapshot &&
      (currentSnapshot.oneproxyAutoSyncEnabled !== previousSnapshot.oneproxyAutoSyncEnabled ||
        currentSnapshot.oneproxyAutoSyncIntervalMinutes !==
          previousSnapshot.oneproxyAutoSyncIntervalMinutes ||
        currentSnapshot.oneproxyAutoSyncMaxProxies !==
          previousSnapshot.oneproxyAutoSyncMaxProxies ||
        currentSnapshot.oneproxyAutoSyncMinQuality !==
          previousSnapshot.oneproxyAutoSyncMinQuality ||
        currentSnapshot.oneproxyAutoSyncOnStartup !== previousSnapshot.oneproxyAutoSyncOnStartup))
  ) {
    await applyOneproxyAutoSyncSection(previousSnapshot, currentSnapshot, force);
    markChanged("oneproxyAutoSync");
  }

  if (
    force ||
    (hasBootstrappedSnapshot &&
      (currentSnapshot.oneproxyHealthEnabled !== previousSnapshot.oneproxyHealthEnabled ||
        currentSnapshot.oneproxyHealthIntervalMinutes !==
          previousSnapshot.oneproxyHealthIntervalMinutes ||
        currentSnapshot.oneproxyHealthBatchSize !== previousSnapshot.oneproxyHealthBatchSize ||
        currentSnapshot.oneproxyHealthTimeoutMs !== previousSnapshot.oneproxyHealthTimeoutMs ||
        currentSnapshot.oneproxyHealthTestUrl !== previousSnapshot.oneproxyHealthTestUrl ||
        currentSnapshot.oneproxyHealthRevalidateOlderThanMinutes !==
          previousSnapshot.oneproxyHealthRevalidateOlderThanMinutes ||
        currentSnapshot.oneproxyHealthMaxFailures !== previousSnapshot.oneproxyHealthMaxFailures ||
        currentSnapshot.oneproxyHealthValidateOnStartup !==
          previousSnapshot.oneproxyHealthValidateOnStartup))
  ) {
    await applyOneproxyHealthValidatorSection(previousSnapshot, currentSnapshot, force);
    markChanged("oneproxyHealthValidator");
  }
  if (
    force ||
    (hasBootstrappedSnapshot &&
      (currentSnapshot.oneproxyObservabilityRetentionDays !==
        previousSnapshot.oneproxyObservabilityRetentionDays ||
        currentSnapshot.oneproxyObservabilityCleanupIntervalMinutes !==
          previousSnapshot.oneproxyObservabilityCleanupIntervalMinutes ||
        currentSnapshot.oneproxyObservabilityCleanupOnStartup !==
          previousSnapshot.oneproxyObservabilityCleanupOnStartup ||
        currentSnapshot.oneproxyObservabilityAlertsEnabled !==
          previousSnapshot.oneproxyObservabilityAlertsEnabled ||
        currentSnapshot.oneproxyObservabilityMinActiveProxies !==
          previousSnapshot.oneproxyObservabilityMinActiveProxies ||
        currentSnapshot.oneproxyObservabilityMinSuccessRate !==
          previousSnapshot.oneproxyObservabilityMinSuccessRate ||
        currentSnapshot.oneproxyObservabilityMaxQuarantineRate !==
          previousSnapshot.oneproxyObservabilityMaxQuarantineRate))
  ) {
    await applyOneproxyObservabilitySection(previousSnapshot, currentSnapshot, force);
    markChanged("oneproxyObservability");
  }

  if (force || hasChanged(currentSnapshot.corsOrigins, previousSnapshot.corsOrigins)) {
    await applyCorsOriginsSection(currentSnapshot.corsOrigins);
    markChanged("corsOrigins");
  }

  lastAppliedSnapshot = currentSnapshot;
  return changes;
}

export function getLastAppliedRuntimeSettingsSnapshotForTests() {
  return lastAppliedSnapshot;
}

export function resetRuntimeSettingsStateForTests() {
  lastAppliedSnapshot = null;
}
