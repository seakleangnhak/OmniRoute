import { randomUUID } from "crypto";
import { getDbInstance } from "./core";
import { backupDbFile } from "./backup";

type JsonRecord = Record<string, unknown>;

export type OneproxyEventType =
  | "selected"
  | "success"
  | "failure"
  | "quarantine"
  | "health_success"
  | "health_failure"
  | "recovery";

export interface OneproxyProxyRecord {
  id: string;
  name: string;
  type: string;
  host: string;
  port: number;
  region: string | null;
  notes: string | null;
  status: string;
  source: string;
  qualityScore: number | null;
  latencyMs: number | null;
  effectiveScore: number;
  anonymity: string | null;
  googleAccess: boolean;
  lastValidated: string | null;
  lastUsedAt: string | null;
  quarantinedUntil: string | null;
  lastError: string | null;
  lastErrorType: string | null;
  lastErrorAt: string | null;
  failureCount: number;
  failureStreak: number;
  successCount: number;
  ewmaLatencyMs: number | null;
  requestCount: number;
  runtimeSuccessCount: number;
  runtimeFailureCount: number;
  avgLatencyMs: number | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  successRate: number | null;
  successRate1h: number | null;
  successRate24h: number | null;
  p95LatencyMs1h: number | null;
  p95LatencyMs24h: number | null;
  countryCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OneproxyStats {
  total: number;
  active: number;
  quarantined: number;
  avgQuality: number | null;
  avgEffectiveScore: number | null;
  lastValidated: string | null;
  requestCount: number;
  runtimeSuccessCount: number;
  runtimeFailureCount: number;
  successRate: number | null;
  avgLatencyMs: number | null;
  lastUsedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  byProtocol: Array<{ protocol: string; count: number }>;
  byCountry: Array<{ countryCode: string; count: number }>;
}

export interface OneproxyProxyEventRecord {
  id: string;
  proxyId: string;
  eventType: string;
  host: string | null;
  port: number | null;
  latencyMs: number | null;
  errorType: string | null;
  errorMessage: string | null;
  metadata: JsonRecord | null;
  createdAt: string;
}

export interface OneproxyPoolAlert {
  code: "low_active_pool" | "low_success_rate" | "high_quarantine_rate";
  severity: "warning" | "critical";
  message: string;
  value: number;
  threshold: number;
  generatedAt: string;
}

interface OneproxyUpsertInput {
  ip: string;
  port: number;
  protocol: string;
  country?: string | null;
  countryCode?: string | null;
  anonymity?: string | null;
  qualityScore?: number | null;
  latencyMs?: number | null;
  googleAccess?: boolean;
  lastValidated?: string | null;
}

interface OneproxyScoreInput {
  qualityScore?: number | null;
  latencyMs?: number | null;
  lastValidated?: string | null;
  quarantinedUntil?: string | null;
  failureCount?: number | null;
  failureStreak?: number | null;
  successCount?: number | null;
  ewmaLatencyMs?: number | null;
  googleAccess?: boolean | number | null;
}

const ONEPROXY_EFFECTIVE_SCORE_SQL = `ROUND(
  MAX(
    0,
    MIN(
      100,
      COALESCE(quality_score, 50)
        - CASE
            WHEN quarantined_until IS NOT NULL
              AND strftime('%s', quarantined_until) > strftime('%s', 'now')
            THEN 100
            ELSE 0
          END
        - (MAX(0, COALESCE(failure_count, 0)) * 8)
        - (MAX(0, COALESCE(failure_streak, 0)) * 10)
        - CASE
            WHEN COALESCE(ewma_latency_ms, latency_ms) IS NULL THEN 5
            WHEN COALESCE(ewma_latency_ms, latency_ms) <= 500 THEN 0
            ELSE MIN(25, (COALESCE(ewma_latency_ms, latency_ms) - 500) / 200.0)
          END
        - CASE
            WHEN last_validated IS NULL THEN 20
            WHEN strftime('%s', 'now') - COALESCE(strftime('%s', last_validated), 0) >= 86400
              THEN 20
            WHEN strftime('%s', 'now') - COALESCE(strftime('%s', last_validated), 0) >= 21600
              THEN 10
            ELSE 0
          END
        + CASE WHEN COALESCE(google_access, 0) = 1 THEN 5 ELSE 0 END
        + MIN(5, MAX(0, COALESCE(success_count, 0)))
    )
  ),
  2
)`;

const ONEPROXY_PROXY_SELECT = `SELECT *, ${ONEPROXY_EFFECTIVE_SCORE_SQL} AS effective_score FROM proxy_registry`;

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 100) / 100));
}

function scoreNumber(value: number | null | undefined): number | null {
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function truncateText(value: unknown, maxLength: number): string | null {
  if (value == null) return null;
  const text = value instanceof Error ? value.message : String(value);
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 3)}...` : trimmed;
}

function normalizeCount(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function normalizeLatency(value: unknown): number | null {
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : null;
}

function normalizeIntegerSetting(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const numeric = Number(value);
  const integer = Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
  return Math.min(max, Math.max(min, integer));
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

function successRate(successes: number, failures: number): number | null {
  const attempts = successes + failures;
  if (attempts <= 0) return null;
  return roundPercent((successes / attempts) * 100);
}

function safeStringifyMetadata(metadata?: JsonRecord | null): string | null {
  if (!metadata) return null;
  try {
    return JSON.stringify(metadata);
  } catch {
    return JSON.stringify({ serializationError: true });
  }
}

function parseMetadata(value: unknown): JsonRecord | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : null;
  } catch {
    return null;
  }
}

function mapEventRow(row: unknown): OneproxyProxyEventRecord {
  const r = toRecord(row);
  return {
    id: typeof r.id === "string" ? r.id : "",
    proxyId: typeof r.proxy_id === "string" ? r.proxy_id : "",
    eventType: typeof r.event_type === "string" ? r.event_type : "unknown",
    host: typeof r.host === "string" ? r.host : null,
    port: normalizeLatency(r.port),
    latencyMs: normalizeLatency(r.latency_ms),
    errorType: typeof r.error_type === "string" ? r.error_type : null,
    errorMessage: typeof r.error_message === "string" ? r.error_message : null,
    metadata: parseMetadata(r.metadata),
    createdAt: typeof r.created_at === "string" ? r.created_at : "",
  };
}

function insertOneproxyEvent(
  db: ReturnType<typeof getDbInstance>,
  event: {
    proxyId: string;
    eventType: OneproxyEventType;
    host?: string | null;
    port?: number | null;
    latencyMs?: number | null;
    errorType?: string | null;
    errorMessage?: string | null;
    metadata?: JsonRecord | null;
    createdAt?: string;
  }
): void {
  db.prepare(
    `INSERT INTO oneproxy_events
     (id, proxy_id, event_type, host, port, latency_ms, error_type, error_message, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    event.proxyId,
    event.eventType,
    event.host ?? null,
    event.port ?? null,
    event.latencyMs ?? null,
    event.errorType ?? null,
    event.errorMessage ?? null,
    safeStringifyMetadata(event.metadata),
    event.createdAt ?? new Date().toISOString()
  );
}

function percentile(values: number[], percentileRank: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentileRank / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))] ?? null;
}

function normalizeRollingRate(successes: unknown, attempts: unknown): number | null {
  const successCount = normalizeCount(successes);
  const attemptCount = normalizeCount(attempts);
  if (attemptCount <= 0) return null;
  return roundPercent((successCount / attemptCount) * 100);
}

function classifyOneproxyFailure(error: unknown, explicitType?: string | null): string {
  if (typeof explicitType === "string" && explicitType.trim().length > 0) {
    return explicitType
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "_")
      .slice(0, 64);
  }

  const record = toRecord(error);
  const code = typeof record.code === "string" ? record.code.toLowerCase() : "";
  const message = (error instanceof Error ? error.message : String(error || "")).toLowerCase();

  if (
    code.includes("timeout") ||
    code.includes("etimedout") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("etimedout")
  ) {
    return "timeout";
  }
  if (code.includes("enotfound") || code.includes("eai_again") || message.includes("dns")) {
    return "dns";
  }
  if (
    code.includes("econnrefused") ||
    code.includes("econnreset") ||
    code.includes("socket") ||
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("connection refused") ||
    message.includes("connection reset") ||
    message.includes("socket")
  ) {
    return "connection";
  }
  if (message.includes("tls") || message.includes("certificate") || message.includes("ssl")) {
    return "tls";
  }
  if (message.includes("auth") || message.includes("407")) {
    return "auth";
  }
  if (message.includes("proxy unreachable") || code === "proxy_unreachable") {
    return "proxy_unreachable";
  }

  return "unknown";
}

function getQuarantineMinutes(errorType: string): number {
  switch (errorType) {
    case "timeout":
      return 5;
    case "dns":
    case "connection":
      return 15;
    case "auth":
    case "tls":
      return 30;
    case "proxy_unreachable":
      return 20;
    default:
      return 10;
  }
}

export function calculateOneproxyEffectiveScore(
  input: OneproxyScoreInput,
  now: Date = new Date()
): number {
  const quarantineUntil = input.quarantinedUntil ? Date.parse(input.quarantinedUntil) : Number.NaN;
  if (Number.isFinite(quarantineUntil) && quarantineUntil > now.getTime()) {
    return 0;
  }

  const rawQuality = scoreNumber(input.qualityScore);
  let score = rawQuality == null ? 50 : clampScore(rawQuality);

  const failureCount = Math.max(0, Math.trunc(scoreNumber(input.failureCount) ?? 0));
  const failureStreak = Math.max(0, Math.trunc(scoreNumber(input.failureStreak) ?? 0));
  score -= failureCount * 8;
  score -= failureStreak * 10;

  const latencyMs = scoreNumber(input.ewmaLatencyMs) ?? scoreNumber(input.latencyMs);
  if (latencyMs == null) {
    score -= 5;
  } else if (latencyMs > 500) {
    score -= Math.min(25, (latencyMs - 500) / 200);
  }

  const validatedAt = input.lastValidated ? Date.parse(input.lastValidated) : Number.NaN;
  if (!Number.isFinite(validatedAt)) {
    score -= 20;
  } else {
    const validationAgeMs = Math.max(0, now.getTime() - validatedAt);
    if (validationAgeMs >= 24 * 60 * 60 * 1000) {
      score -= 20;
    } else if (validationAgeMs >= 6 * 60 * 60 * 1000) {
      score -= 10;
    }
  }

  if (input.googleAccess === true || input.googleAccess === 1) {
    score += 5;
  }

  const successCount = Math.max(0, Math.trunc(scoreNumber(input.successCount) ?? 0));
  score += Math.min(5, successCount);

  return clampScore(score);
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function mapProxyRow(row: unknown): OneproxyProxyRecord {
  const r = toRecord(row);
  const proxy = {
    id: typeof r.id === "string" ? r.id : "",
    name: typeof r.name === "string" ? r.name : "",
    type: typeof r.type === "string" ? r.type : "http",
    host: typeof r.host === "string" ? r.host : "",
    port: Number(r.port) || 0,
    region: typeof r.region === "string" ? r.region : null,
    notes: typeof r.notes === "string" ? r.notes : null,
    status: typeof r.status === "string" ? r.status : "active",
    source: typeof r.source === "string" ? r.source : "oneproxy",
    qualityScore: typeof r.quality_score === "number" ? r.quality_score : null,
    latencyMs: typeof r.latency_ms === "number" ? r.latency_ms : null,
    anonymity: typeof r.anonymity === "string" ? r.anonymity : null,
    googleAccess: r.google_access === 1 || r.google_access === true,
    lastValidated: typeof r.last_validated === "string" ? r.last_validated : null,
    lastUsedAt: typeof r.last_used_at === "string" ? r.last_used_at : null,
    quarantinedUntil: typeof r.quarantined_until === "string" ? r.quarantined_until : null,
    lastError: typeof r.last_error === "string" ? r.last_error : null,
    lastErrorType: typeof r.last_error_type === "string" ? r.last_error_type : null,
    lastErrorAt: typeof r.last_error_at === "string" ? r.last_error_at : null,
    failureCount: Number(r.failure_count) || 0,
    failureStreak: Number(r.failure_streak) || 0,
    successCount: Number(r.success_count) || 0,
    ewmaLatencyMs: typeof r.ewma_latency_ms === "number" ? r.ewma_latency_ms : null,
    requestCount: normalizeCount(r.request_count),
    runtimeSuccessCount: normalizeCount(r.runtime_success_count),
    runtimeFailureCount: normalizeCount(r.runtime_failure_count),
    avgLatencyMs: normalizeLatency(r.avg_latency_ms),
    lastSuccessAt: typeof r.last_success_at === "string" ? r.last_success_at : null,
    lastFailureAt: typeof r.last_failure_at === "string" ? r.last_failure_at : null,
    successRate: successRate(
      normalizeCount(r.runtime_success_count),
      normalizeCount(r.runtime_failure_count)
    ),
    successRate1h: null,
    successRate24h: null,
    p95LatencyMs1h: null,
    p95LatencyMs24h: null,
    countryCode: typeof r.country_code === "string" ? r.country_code : null,
    createdAt: typeof r.created_at === "string" ? r.created_at : "",
    updatedAt: typeof r.updated_at === "string" ? r.updated_at : "",
  };

  return {
    ...proxy,
    effectiveScore:
      typeof r.effective_score === "number"
        ? clampScore(r.effective_score)
        : calculateOneproxyEffectiveScore(proxy),
  };
}

function mapStatsRow(row: unknown) {
  const r = toRecord(row);
  return {
    total: Number(r.total) || 0,
    active: Number(r.active) || 0,
    quarantined: Number(r.quarantined) || 0,
    avgQuality:
      r.avg_quality !== null && r.avg_quality !== undefined
        ? Math.round(Number(r.avg_quality) * 100) / 100
        : null,
    avgEffectiveScore:
      r.avg_effective_score !== null && r.avg_effective_score !== undefined
        ? Math.round(Number(r.avg_effective_score) * 100) / 100
        : null,
    lastValidated: typeof r.last_validated === "string" ? r.last_validated : null,
    requestCount: normalizeCount(r.request_count),
    runtimeSuccessCount: normalizeCount(r.runtime_success_count),
    runtimeFailureCount: normalizeCount(r.runtime_failure_count),
    successRate: successRate(
      normalizeCount(r.runtime_success_count),
      normalizeCount(r.runtime_failure_count)
    ),
    avgLatencyMs: normalizeLatency(r.avg_latency_ms),
    lastUsedAt: typeof r.last_used_at === "string" ? r.last_used_at : null,
    lastSuccessAt: typeof r.last_success_at === "string" ? r.last_success_at : null,
    lastFailureAt: typeof r.last_failure_at === "string" ? r.last_failure_at : null,
  };
}

function attachOneproxyRuntimeMetrics(proxies: OneproxyProxyRecord[]): OneproxyProxyRecord[] {
  if (proxies.length === 0) return proxies;

  const db = getDbInstance();
  const ids = proxies.map((proxy) => proxy.id).filter(Boolean);
  if (ids.length === 0) return proxies;

  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT
        proxy_id,
        SUM(CASE WHEN event_type = 'success' AND datetime(created_at) >= datetime('now', '-1 hour') THEN 1 ELSE 0 END) as success_1h,
        SUM(CASE WHEN event_type IN ('success', 'failure') AND datetime(created_at) >= datetime('now', '-1 hour') THEN 1 ELSE 0 END) as attempts_1h,
        SUM(CASE WHEN event_type = 'success' AND datetime(created_at) >= datetime('now', '-24 hours') THEN 1 ELSE 0 END) as success_24h,
        SUM(CASE WHEN event_type IN ('success', 'failure') AND datetime(created_at) >= datetime('now', '-24 hours') THEN 1 ELSE 0 END) as attempts_24h
       FROM oneproxy_events
       WHERE proxy_id IN (${placeholders})
       GROUP BY proxy_id`
    )
    .all(...ids) as JsonRecord[];

  const rolling = new Map<
    string,
    { successRate1h: number | null; successRate24h: number | null }
  >();
  for (const row of rows) {
    const proxyId = typeof row.proxy_id === "string" ? row.proxy_id : "";
    if (!proxyId) continue;
    rolling.set(proxyId, {
      successRate1h: normalizeRollingRate(row.success_1h, row.attempts_1h),
      successRate24h: normalizeRollingRate(row.success_24h, row.attempts_24h),
    });
  }

  const latencyRows = db
    .prepare(
      `SELECT proxy_id, latency_ms, created_at
       FROM oneproxy_events
       WHERE proxy_id IN (${placeholders})
         AND event_type IN ('success', 'health_success')
         AND latency_ms IS NOT NULL
         AND datetime(created_at) >= datetime('now', '-24 hours')`
    )
    .all(...ids) as JsonRecord[];

  const latencyByProxy = new Map<string, { oneHour: number[]; twentyFourHours: number[] }>();
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const row of latencyRows) {
    const proxyId = typeof row.proxy_id === "string" ? row.proxy_id : "";
    const latencyMs = normalizeLatency(row.latency_ms);
    const createdAt = typeof row.created_at === "string" ? Date.parse(row.created_at) : Number.NaN;
    if (!proxyId || latencyMs == null) continue;

    const bucket = latencyByProxy.get(proxyId) || { oneHour: [], twentyFourHours: [] };
    bucket.twentyFourHours.push(latencyMs);
    if (Number.isFinite(createdAt) && createdAt >= oneHourAgo) {
      bucket.oneHour.push(latencyMs);
    }
    latencyByProxy.set(proxyId, bucket);
  }

  return proxies.map((proxy) => {
    const rates = rolling.get(proxy.id);
    const latencies = latencyByProxy.get(proxy.id);
    return {
      ...proxy,
      successRate1h: rates?.successRate1h ?? null,
      successRate24h: rates?.successRate24h ?? null,
      p95LatencyMs1h: latencies ? percentile(latencies.oneHour, 95) : null,
      p95LatencyMs24h: latencies ? percentile(latencies.twentyFourHours, 95) : null,
    };
  });
}

export async function listOneproxyProxies(options?: {
  protocol?: string;
  countryCode?: string;
  minQuality?: number;
  limit?: number;
}): Promise<OneproxyProxyRecord[]> {
  const db = getDbInstance();

  let sql = `${ONEPROXY_PROXY_SELECT} WHERE source = 'oneproxy' AND status = 'active'`;
  const params: unknown[] = [];

  if (options?.protocol) {
    sql += " AND type = ?";
    params.push(options.protocol);
  }
  if (options?.countryCode) {
    sql += " AND country_code = ?";
    params.push(options.countryCode);
  }
  if (options?.minQuality != null) {
    sql += " AND quality_score >= ?";
    params.push(options.minQuality);
  }

  sql +=
    " ORDER BY effective_score DESC, quality_score DESC, failure_count ASC, latency_ms ASC, last_validated DESC";

  if (options?.limit) {
    sql += " LIMIT ?";
    params.push(options.limit);
  }

  const rows = db.prepare(sql).all(...params);
  return attachOneproxyRuntimeMetrics(rows.map(mapProxyRow));
}

export async function getOneproxyStats(): Promise<OneproxyStats> {
  const db = getDbInstance();

  const statsRow = db
    .prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
        SUM(CASE
          WHEN quarantined_until IS NOT NULL
            AND strftime('%s', quarantined_until) > strftime('%s', 'now')
          THEN 1 ELSE 0 END) as quarantined,
        AVG(quality_score) as avg_quality,
        AVG(${ONEPROXY_EFFECTIVE_SCORE_SQL}) as avg_effective_score,
        MAX(last_validated) as last_validated,
        SUM(COALESCE(request_count, 0)) as request_count,
        SUM(COALESCE(runtime_success_count, 0)) as runtime_success_count,
        SUM(COALESCE(runtime_failure_count, 0)) as runtime_failure_count,
        AVG(avg_latency_ms) as avg_latency_ms,
        MAX(last_used_at) as last_used_at,
        MAX(last_success_at) as last_success_at,
        MAX(last_failure_at) as last_failure_at
       FROM proxy_registry WHERE source = 'oneproxy'`
    )
    .get();

  const stats = mapStatsRow(statsRow);

  const byProtocol = db
    .prepare(
      "SELECT type as protocol, COUNT(*) as count FROM proxy_registry WHERE source = 'oneproxy' GROUP BY type ORDER BY count DESC"
    )
    .all() as Array<JsonRecord>;

  const byCountry = db
    .prepare(
      "SELECT country_code as countryCode, COUNT(*) as count FROM proxy_registry WHERE source = 'oneproxy' AND country_code IS NOT NULL GROUP BY country_code ORDER BY count DESC LIMIT 20"
    )
    .all() as Array<JsonRecord>;

  return {
    ...stats,
    byProtocol: byProtocol.map((r) => ({
      protocol: String(r.protocol || "unknown"),
      count: Number(r.count) || 0,
    })),
    byCountry: byCountry.map((r) => ({
      countryCode: String(r.countryCode || "unknown"),
      count: Number(r.count) || 0,
    })),
  };
}

export async function upsertOneproxyProxy(
  input: OneproxyUpsertInput
): Promise<{ proxy: OneproxyProxyRecord | null; action: "created" | "updated" }> {
  const db = getDbInstance();
  const now = new Date().toISOString();

  const name = `${input.protocol?.toUpperCase() || "HTTP"} - ${input.countryCode || "Unknown"} - ${input.ip}`;

  const existing = db
    .prepare("SELECT id FROM proxy_registry WHERE host = ? AND port = ? AND source = 'oneproxy'")
    .get(input.ip, input.port) as { id?: string } | undefined;

  if (existing?.id) {
    db.prepare(
      `UPDATE proxy_registry
       SET status = ?, quality_score = ?, latency_ms = ?, anonymity = ?,
           google_access = ?, last_validated = ?, country_code = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      "active",
      input.qualityScore ?? null,
      input.latencyMs ?? null,
      input.anonymity ?? null,
      input.googleAccess ? 1 : 0,
      input.lastValidated ?? now,
      input.countryCode ?? null,
      now,
      existing.id
    );
    backupDbFile("pre-write");
    const proxy = await getOneproxyProxyById(existing.id);
    return { proxy, action: "updated" };
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO proxy_registry
     (id, name, type, host, port, region, notes, status, source,
      quality_score, latency_ms, anonymity, google_access, last_validated, country_code,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    name,
    input.protocol || "http",
    input.ip,
    input.port,
    input.countryCode ?? null,
    null,
    "active",
    "oneproxy",
    input.qualityScore ?? null,
    input.latencyMs ?? null,
    input.anonymity ?? null,
    input.googleAccess ? 1 : 0,
    input.lastValidated ?? now,
    input.countryCode ?? null,
    now,
    now
  );
  backupDbFile("pre-write");
  const proxy = await getOneproxyProxyById(id);
  return { proxy, action: "created" };
}

export async function getOneproxyProxyById(id: string): Promise<OneproxyProxyRecord | null> {
  const db = getDbInstance();
  const row = db.prepare(`${ONEPROXY_PROXY_SELECT} WHERE id = ? AND source = 'oneproxy'`).get(id);
  if (!row) return null;
  return attachOneproxyRuntimeMetrics([mapProxyRow(row)])[0] ?? null;
}

export async function listOneproxyProxiesForHealthValidation(options?: {
  limit?: number;
  staleBefore?: string;
  protocols?: string[];
}): Promise<OneproxyProxyRecord[]> {
  const db = getDbInstance();
  const limit = Math.max(1, Math.min(200, Math.trunc(Number(options?.limit) || 25)));
  const protocols = Array.from(
    new Set(
      (options?.protocols || [])
        .map((protocol) => protocol.trim().toLowerCase())
        .filter((protocol) => ["http", "https", "socks5"].includes(protocol))
    )
  );

  let sql = `${ONEPROXY_PROXY_SELECT} WHERE source = 'oneproxy' AND status IN ('active', 'inactive')`;
  const params: unknown[] = [];

  if (options?.staleBefore) {
    sql +=
      " AND (last_validated IS NULL OR datetime(last_validated) <= datetime(?) OR (quarantined_until IS NOT NULL AND datetime(quarantined_until) <= datetime(?)))";
    params.push(options.staleBefore, new Date().toISOString());
  }

  if (protocols.length > 0) {
    sql += ` AND type IN (${protocols.map(() => "?").join(", ")})`;
    params.push(...protocols);
  }

  sql +=
    " ORDER BY status = 'inactive' DESC, quarantined_until IS NOT NULL DESC, last_validated IS NOT NULL ASC, datetime(last_validated) ASC, failure_streak DESC, failure_count DESC, quality_score ASC LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...params);
  return attachOneproxyRuntimeMetrics(rows.map(mapProxyRow));
}

export async function recordOneproxyProxyHealthResult(
  id: string,
  result: {
    success: boolean;
    latencyMs?: number | null;
    qualityScore?: number | null;
    maxFailures?: number;
    error?: unknown;
    errorType?: string | null;
    quarantineMinutes?: number | null;
  }
): Promise<OneproxyProxyRecord | null> {
  const db = getDbInstance();
  const now = new Date().toISOString();
  const qualityScore =
    result.qualityScore == null
      ? null
      : Math.max(0, Math.min(100, Math.trunc(Number(result.qualityScore))));
  const latencyMs =
    result.latencyMs == null ? null : Math.max(0, Math.trunc(Number(result.latencyMs)));

  const existing = db
    .prepare(
      "SELECT id, host, port, status, quarantined_until FROM proxy_registry WHERE id = ? AND source = 'oneproxy'"
    )
    .get(id) as JsonRecord | undefined;
  if (!existing) return null;
  const wasUnavailable =
    existing.status === "inactive" ||
    (typeof existing.quarantined_until === "string" &&
      Date.parse(existing.quarantined_until) > Date.now());

  if (result.success) {
    db.prepare(
      `UPDATE proxy_registry
       SET status = 'active', quality_score = COALESCE(?, quality_score), latency_ms = ?,
           ewma_latency_ms = COALESCE(?, ewma_latency_ms), failure_count = 0,
           failure_streak = 0, success_count = COALESCE(success_count, 0) + 1,
           quarantined_until = NULL, last_error = NULL, last_error_type = NULL, last_error_at = NULL,
           last_validated = ?, last_success_at = ?, updated_at = ?
       WHERE id = ? AND source = 'oneproxy'`
    ).run(qualityScore, latencyMs, latencyMs, now, now, now, id);
    insertOneproxyEvent(db, {
      proxyId: id,
      eventType: "health_success",
      host: typeof existing.host === "string" ? existing.host : null,
      port: normalizeLatency(existing.port),
      latencyMs,
      metadata: { qualityScore },
      createdAt: now,
    });
    if (wasUnavailable) {
      insertOneproxyEvent(db, {
        proxyId: id,
        eventType: "recovery",
        host: typeof existing.host === "string" ? existing.host : null,
        port: normalizeLatency(existing.port),
        latencyMs,
        metadata: { source: "health_validator" },
        createdAt: now,
      });
    }
    return getOneproxyProxyById(id);
  }

  const errorType = classifyOneproxyFailure(result.error, result.errorType);
  const quarantineMinutes = Math.max(
    1,
    Math.min(1440, Math.trunc(Number(result.quarantineMinutes) || getQuarantineMinutes(errorType)))
  );
  const quarantinedUntil = new Date(Date.now() + quarantineMinutes * 60 * 1000).toISOString();
  const lastError = truncateText(result.error || errorType, 500);
  const maxFailures = Math.max(1, Math.min(10, Math.trunc(Number(result.maxFailures) || 3)));
  db.prepare(
    `UPDATE proxy_registry
     SET quality_score = MAX(0, COALESCE(quality_score, 50) - 20),
         latency_ms = COALESCE(?, latency_ms),
         ewma_latency_ms = CASE
           WHEN ? IS NULL THEN ewma_latency_ms
           WHEN ewma_latency_ms IS NULL THEN ?
           ELSE ROUND((ewma_latency_ms * 0.7) + (? * 0.3))
         END,
         failure_count = COALESCE(failure_count, 0) + 1,
         failure_streak = COALESCE(failure_streak, 0) + 1,
         quarantined_until = ?,
         last_error = ?,
         last_error_type = ?,
         last_error_at = ?,
         last_failure_at = ?,
         status = CASE
           WHEN COALESCE(failure_streak, 0) + 1 >= ?
             OR MAX(0, COALESCE(quality_score, 50) - 20) <= 10
           THEN 'inactive'
           ELSE status
         END,
         last_validated = ?,
         updated_at = ?
     WHERE id = ? AND source = 'oneproxy'`
  ).run(
    latencyMs,
    latencyMs,
    latencyMs,
    latencyMs,
    quarantinedUntil,
    lastError,
    errorType,
    now,
    now,
    maxFailures,
    now,
    now,
    id
  );
  insertOneproxyEvent(db, {
    proxyId: id,
    eventType: "health_failure",
    host: typeof existing.host === "string" ? existing.host : null,
    port: normalizeLatency(existing.port),
    latencyMs,
    errorType,
    errorMessage: lastError,
    createdAt: now,
  });
  insertOneproxyEvent(db, {
    proxyId: id,
    eventType: "quarantine",
    host: typeof existing.host === "string" ? existing.host : null,
    port: normalizeLatency(existing.port),
    latencyMs,
    errorType,
    errorMessage: lastError,
    metadata: { quarantinedUntil, source: "health_validator" },
    createdAt: now,
  });

  return getOneproxyProxyById(id);
}

export async function deleteOneproxyProxy(id: string): Promise<boolean> {
  const db = getDbInstance();
  db.prepare("DELETE FROM oneproxy_events WHERE proxy_id = ?").run(id);
  const result = db
    .prepare("DELETE FROM proxy_registry WHERE id = ? AND source = 'oneproxy'")
    .run(id);
  backupDbFile("pre-write");
  return result.changes > 0;
}

export async function clearAllOneproxyProxies(): Promise<number> {
  const db = getDbInstance();
  db.prepare(
    "DELETE FROM oneproxy_events WHERE proxy_id IN (SELECT id FROM proxy_registry WHERE source = 'oneproxy')"
  ).run();
  const result = db.prepare("DELETE FROM proxy_registry WHERE source = 'oneproxy'").run();
  backupDbFile("pre-write");
  return result.changes;
}

export async function listOneproxyProxyEvents(options?: {
  proxyId?: string;
  eventType?: string;
  limit?: number;
}): Promise<OneproxyProxyEventRecord[]> {
  const db = getDbInstance();
  const limit = Math.max(1, Math.min(500, Math.trunc(Number(options?.limit) || 50)));
  let sql = "SELECT * FROM oneproxy_events WHERE 1 = 1";
  const params: unknown[] = [];

  if (options?.proxyId) {
    sql += " AND proxy_id = ?";
    params.push(options.proxyId);
  }
  if (options?.eventType) {
    sql += " AND event_type = ?";
    params.push(options.eventType);
  }

  sql += " ORDER BY datetime(created_at) DESC, id DESC LIMIT ?";
  params.push(limit);

  return db
    .prepare(sql)
    .all(...params)
    .map(mapEventRow);
}

export async function cleanupOneproxyProxyEvents(options?: {
  retentionDays?: number | null;
  before?: string | null;
}): Promise<{ deleted: number; before: string }> {
  const db = getDbInstance();
  const retentionDays = normalizeIntegerSetting(options?.retentionDays, 30, 1, 365);
  const parsedBefore = options?.before ? Date.parse(options.before) : Number.NaN;
  const before = Number.isFinite(parsedBefore)
    ? new Date(parsedBefore).toISOString()
    : new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  const result = db
    .prepare("DELETE FROM oneproxy_events WHERE datetime(created_at) < datetime(?)")
    .run(before);
  if (result.changes > 0) {
    backupDbFile("pre-write");
  }

  return { deleted: result.changes, before };
}

export async function getOneproxyPoolAlerts(options?: {
  alertsEnabled?: boolean | null;
  minActiveProxies?: number | null;
  minSuccessRate?: number | null;
  maxQuarantineRate?: number | null;
}): Promise<OneproxyPoolAlert[]> {
  if (options?.alertsEnabled === false) return [];

  const minActiveProxies = normalizeIntegerSetting(options?.minActiveProxies, 10, 0, 100000);
  const minSuccessRate = normalizeIntegerSetting(options?.minSuccessRate, 80, 0, 100);
  const maxQuarantineRate = normalizeIntegerSetting(options?.maxQuarantineRate, 25, 0, 100);
  const stats = await getOneproxyStats();
  const db = getDbInstance();
  const activeAvailableRow = db
    .prepare(
      `SELECT COUNT(*) as count FROM proxy_registry
       WHERE source = 'oneproxy'
         AND status = 'active'
         AND (quarantined_until IS NULL OR strftime('%s', quarantined_until) <= strftime('%s', 'now'))`
    )
    .get() as JsonRecord | undefined;
  const activeAvailable = normalizeCount(activeAvailableRow?.count);
  const generatedAt = new Date().toISOString();
  const alerts: OneproxyPoolAlert[] = [];

  if (minActiveProxies > 0 && activeAvailable < minActiveProxies) {
    alerts.push({
      code: "low_active_pool",
      severity:
        activeAvailable === 0 || activeAvailable <= Math.floor(minActiveProxies * 0.5)
          ? "critical"
          : "warning",
      message:
        "Available 1proxy pool is below target (" + activeAvailable + "/" + minActiveProxies + ").",
      value: activeAvailable,
      threshold: minActiveProxies,
      generatedAt,
    });
  }

  const runtimeAttempts = stats.runtimeSuccessCount + stats.runtimeFailureCount;
  if (minSuccessRate > 0 && runtimeAttempts > 0 && stats.successRate != null) {
    if (stats.successRate < minSuccessRate) {
      alerts.push({
        code: "low_success_rate",
        severity: stats.successRate <= minSuccessRate * 0.75 ? "critical" : "warning",
        message:
          "Runtime proxy success rate is below target (" +
          stats.successRate +
          "%/" +
          minSuccessRate +
          "%).",
        value: stats.successRate,
        threshold: minSuccessRate,
        generatedAt,
      });
    }
  }

  if (stats.total > 0 && maxQuarantineRate < 100) {
    const quarantineRate = roundPercent((stats.quarantined / stats.total) * 100);
    if (quarantineRate > maxQuarantineRate) {
      alerts.push({
        code: "high_quarantine_rate",
        severity:
          quarantineRate >= 50 || quarantineRate >= Math.min(100, maxQuarantineRate * 2)
            ? "critical"
            : "warning",
        message:
          "Quarantined proxy share is above target (" +
          quarantineRate +
          "%/" +
          maxQuarantineRate +
          "%).",
        value: quarantineRate,
        threshold: maxQuarantineRate,
        generatedAt,
      });
    }
  }

  return alerts;
}

export async function getOneproxyProxyForRotation(options?: {
  strategy?: "random" | "quality" | "sequential";
  protocol?: string;
  countryCode?: string;
  minQuality?: number;
  supportedProtocolsOnly?: boolean;
  excludeIds?: string[];
}): Promise<OneproxyProxyRecord | null> {
  const db = getDbInstance();
  const strategy = options?.strategy || "quality";

  let sql = `${ONEPROXY_PROXY_SELECT} WHERE source = 'oneproxy' AND status = 'active'`;
  const params: unknown[] = [];
  sql += " AND (quarantined_until IS NULL OR quarantined_until <= ?)";
  params.push(new Date().toISOString());

  if (options?.protocol) {
    sql += " AND type = ?";
    params.push(options.protocol);
  } else if (options?.supportedProtocolsOnly) {
    sql += " AND type IN ('http', 'https', 'socks5')";
  }
  if (options?.countryCode) {
    sql += " AND country_code = ?";
    params.push(options.countryCode);
  }
  if (options?.minQuality != null) {
    sql += " AND quality_score >= ?";
    params.push(options.minQuality);
  }
  const excludeIds = (options?.excludeIds || []).filter(
    (id): id is string => typeof id === "string" && id.trim().length > 0
  );
  if (excludeIds.length > 0) {
    sql += ` AND id NOT IN (${excludeIds.map(() => "?").join(", ")})`;
    params.push(...excludeIds);
  }

  switch (strategy) {
    case "quality":
      sql +=
        " ORDER BY effective_score DESC, quality_score DESC, failure_count ASC, latency_ms ASC, COALESCE(last_used_at, '') ASC LIMIT 1";
      break;
    case "random":
      sql += " ORDER BY RANDOM() LIMIT 1";
      break;
    case "sequential":
      sql += " ORDER BY last_used_at IS NOT NULL ASC, datetime(last_used_at) ASC LIMIT 1";
      break;
  }

  const row = db.prepare(sql).get(...params);
  if (!row) return null;
  const proxy = mapProxyRow(row);
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE proxy_registry SET last_used_at = ?, request_count = COALESCE(request_count, 0) + 1, updated_at = ? WHERE id = ?"
  ).run(now, now, proxy.id);
  insertOneproxyEvent(db, {
    proxyId: proxy.id,
    eventType: "selected",
    host: proxy.host,
    port: proxy.port,
    metadata: {
      strategy,
      protocol: options?.protocol || null,
      countryCode: options?.countryCode || null,
      minQuality: options?.minQuality ?? null,
      excludeCount: excludeIds.length,
    },
    createdAt: now,
  });
  return (
    (await getOneproxyProxyById(proxy.id)) ||
    ({ ...proxy, lastUsedAt: now, requestCount: proxy.requestCount + 1 } as OneproxyProxyRecord)
  );
}

export async function recordOneproxyProxyRuntimeSuccess(
  host: string,
  port: number,
  result: { latencyMs?: number | null } = {}
): Promise<boolean> {
  const db = getDbInstance();
  const now = new Date().toISOString();
  const latencyMs =
    result.latencyMs == null ? null : Math.max(0, Math.trunc(Number(result.latencyMs)));
  const existing = db
    .prepare("SELECT id FROM proxy_registry WHERE host = ? AND port = ? AND source = 'oneproxy'")
    .get(host, port) as { id?: string } | undefined;
  if (!existing?.id) return false;

  const update = db
    .prepare(
      `UPDATE proxy_registry
       SET quality_score = MIN(100, COALESCE(quality_score, 50) + 2),
           latency_ms = COALESCE(?, latency_ms),
           ewma_latency_ms = CASE
             WHEN ? IS NULL THEN ewma_latency_ms
             WHEN ewma_latency_ms IS NULL THEN ?
             ELSE ROUND((ewma_latency_ms * 0.7) + (? * 0.3))
           END,
           success_count = COALESCE(success_count, 0) + 1,
           runtime_success_count = COALESCE(runtime_success_count, 0) + 1,
           avg_latency_ms = CASE
             WHEN ? IS NULL THEN avg_latency_ms
             WHEN avg_latency_ms IS NULL THEN ?
             ELSE ROUND((avg_latency_ms * 0.8) + (? * 0.2))
           END,
           last_success_at = ?,
           failure_streak = 0,
           failure_count = 0,
           status = 'active',
           quarantined_until = NULL,
           last_error = NULL,
           last_error_type = NULL,
           last_error_at = NULL,
           updated_at = ?
       WHERE host = ? AND port = ? AND source = 'oneproxy'`
    )
    .run(
      latencyMs,
      latencyMs,
      latencyMs,
      latencyMs,
      latencyMs,
      latencyMs,
      latencyMs,
      now,
      now,
      host,
      port
    );
  backupDbFile("pre-write");
  if (update.changes > 0) {
    insertOneproxyEvent(db, {
      proxyId: existing.id,
      eventType: "success",
      host,
      port,
      latencyMs,
      createdAt: now,
    });
  }
  return update.changes > 0;
}

export async function markOneproxyProxyFailed(
  host: string,
  port: number,
  options: {
    error?: unknown;
    errorType?: string | null;
    quarantineMinutes?: number | null;
    maxFailures?: number | null;
  } = {}
): Promise<boolean> {
  const db = getDbInstance();
  const now = new Date().toISOString();
  const existing = db
    .prepare("SELECT id FROM proxy_registry WHERE host = ? AND port = ? AND source = 'oneproxy'")
    .get(host, port) as { id?: string } | undefined;
  if (!existing?.id) return false;

  const errorType = classifyOneproxyFailure(options.error, options.errorType);
  const quarantineMinutes = Math.max(
    1,
    Math.min(1440, Math.trunc(Number(options.quarantineMinutes) || getQuarantineMinutes(errorType)))
  );
  const quarantinedUntil = new Date(Date.now() + quarantineMinutes * 60 * 1000).toISOString();
  const lastError = truncateText(options.error || errorType, 500);
  const maxFailures = Math.max(1, Math.min(10, Math.trunc(Number(options.maxFailures) || 5)));
  const result = db
    .prepare(
      `UPDATE proxy_registry
       SET quality_score = MAX(0, COALESCE(quality_score, 50) - 10),
           failure_count = COALESCE(failure_count, 0) + 1,
           failure_streak = COALESCE(failure_streak, 0) + 1,
           runtime_failure_count = COALESCE(runtime_failure_count, 0) + 1,
           quarantined_until = ?,
           last_error = ?,
           last_error_type = ?,
           last_error_at = ?,
           last_failure_at = ?,
           status = CASE
             WHEN MAX(0, COALESCE(quality_score, 50) - 10) <= 10
               OR COALESCE(failure_streak, 0) + 1 >= ?
             THEN 'inactive'
             ELSE status
           END,
           updated_at = ?
       WHERE host = ? AND port = ? AND source = 'oneproxy'`
    )
    .run(quarantinedUntil, lastError, errorType, now, now, maxFailures, now, host, port);
  backupDbFile("pre-write");
  if (result.changes > 0) {
    insertOneproxyEvent(db, {
      proxyId: existing.id,
      eventType: "failure",
      host,
      port,
      errorType,
      errorMessage: lastError,
      createdAt: now,
    });
    insertOneproxyEvent(db, {
      proxyId: existing.id,
      eventType: "quarantine",
      host,
      port,
      errorType,
      errorMessage: lastError,
      metadata: { quarantinedUntil, source: "runtime" },
      createdAt: now,
    });
  }

  return result.changes > 0;
}
