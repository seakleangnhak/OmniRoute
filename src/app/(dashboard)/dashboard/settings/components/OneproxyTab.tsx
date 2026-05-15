"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Button, Card } from "@/shared/components";

type OneproxyItem = {
  id: string;
  name: string;
  host: string;
  port: number;
  type: string;
  countryCode: string | null;
  qualityScore: number | null;
  latencyMs: number | null;
  effectiveScore: number;
  anonymity: string | null;
  googleAccess: boolean;
  status: string;
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
};

type OneproxyStats = {
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
};

type OneproxyEvent = {
  id: string;
  proxyId: string;
  eventType: string;
  host: string | null;
  port: number | null;
  latencyMs: number | null;
  errorType: string | null;
  errorMessage: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

type OneproxyPoolAlert = {
  code: "low_active_pool" | "low_success_rate" | "high_quarantine_rate";
  severity: "warning" | "critical";
  message: string;
  value: number;
  threshold: number;
  generatedAt: string;
};

type SyncStatus = {
  lastSyncSuccess: boolean;
  lastSyncError: string | null;
  lastSyncAt: string | null;
  lastSyncCount: number;
  consecutiveFailures: number;
};

type RotatingProxySettings = {
  enabled: boolean;
  source: "oneproxy";
  strategy: "random" | "quality" | "sequential";
  scope: "global" | "provider";
  protocol: "http" | "https" | "socks5" | null;
  countryCode: string | null;
  minQuality: number | null;
  stickyMode:
    | "per-request"
    | "per-session"
    | "per-provider"
    | "per-provider-account"
    | "per-api-key"
    | "time-window";
  stickyTtlMinutes: number;
};

type RotatingProxyPolicyMode = "disabled" | "optional" | "required";
type RotatingProxyFailBehavior = "fail-open" | "fail-closed";
type RotatingProxyPolicyOverride = {
  mode?: RotatingProxyPolicyMode;
  failBehavior?: RotatingProxyFailBehavior;
  protocol?: "http" | "https" | "socks5" | null;
  countryCode?: string | null;
  minQuality?: number | null;
  stickyMode?:
    | "per-request"
    | "per-session"
    | "per-provider"
    | "per-provider-account"
    | "per-api-key"
    | "time-window"
    | null;
  stickyTtlMinutes?: number | null;
  maxProxyRetries?: number;
};

type RotatingProxyPolicySettings = RotatingProxyPolicyOverride & {
  defaultMode: RotatingProxyPolicyMode;
  failBehavior: RotatingProxyFailBehavior;
  providerOverrides: Record<string, RotatingProxyPolicyOverride>;
  accountOverrides: Record<string, RotatingProxyPolicyOverride>;
};

type OneproxyAutoSyncSettings = {
  enabled: boolean;
  intervalMinutes: number;
  maxProxies: number;
  minQuality: number;
  syncOnStartup: boolean;
};

type OneproxyHealthSettings = {
  enabled: boolean;
  intervalMinutes: number;
  batchSize: number;
  timeoutMs: number;
  testUrl: string;
  revalidateOlderThanMinutes: number;
  maxFailures: number;
  validateOnStartup: boolean;
};

type OneproxyHealthStatus = {
  configured: boolean;
  active: boolean;
  running: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastSuccess: boolean;
  lastError: string | null;
  lastChecked: number;
  lastHealthy: number;
  lastUnhealthy: number;
  lastSkippedProxies: number;
};

type OneproxyObservabilitySettings = {
  retentionDays: number;
  cleanupIntervalMinutes: number;
  cleanupOnStartup: boolean;
  alertsEnabled: boolean;
  minActiveProxies: number;
  minSuccessRate: number;
  maxQuarantineRate: number;
};

type OneproxyObservabilityStatus = OneproxyObservabilitySettings & {
  active: boolean;
  running: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastSuccess: boolean;
  lastError: string | null;
  lastDeleted: number;
};

const DEFAULT_ROTATING_PROXY: RotatingProxySettings = {
  enabled: false,
  source: "oneproxy",
  strategy: "random",
  scope: "global",
  protocol: null,
  countryCode: null,
  minQuality: 50,
  stickyMode: "per-request",
  stickyTtlMinutes: 30,
};

const DEFAULT_ROTATING_PROXY_POLICY: RotatingProxyPolicySettings = {
  defaultMode: "optional",
  mode: "optional",
  failBehavior: "fail-open",
  protocol: null,
  countryCode: null,
  minQuality: null,
  stickyMode: null,
  stickyTtlMinutes: null,
  maxProxyRetries: 3,
  providerOverrides: {},
  accountOverrides: {},
};

const DEFAULT_ONEPROXY_SYNC: OneproxyAutoSyncSettings = {
  enabled: false,
  intervalMinutes: 360,
  maxProxies: 500,
  minQuality: 50,
  syncOnStartup: true,
};

const DEFAULT_ONEPROXY_HEALTH: OneproxyHealthSettings = {
  enabled: false,
  intervalMinutes: 30,
  batchSize: 25,
  timeoutMs: 8000,
  testUrl: "https://www.google.com/generate_204",
  revalidateOlderThanMinutes: 60,
  maxFailures: 3,
  validateOnStartup: true,
};

const DEFAULT_ONEPROXY_OBSERVABILITY: OneproxyObservabilitySettings = {
  retentionDays: 30,
  cleanupIntervalMinutes: 360,
  cleanupOnStartup: true,
  alertsEnabled: true,
  minActiveProxies: 10,
  minSuccessRate: 80,
  maxQuarantineRate: 25,
};

function getResponseErrorMessage(data: unknown, fallback: string): string {
  if (!data || typeof data !== "object") return fallback;
  const record = data as Record<string, unknown>;
  const error = record.error;

  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message;
  }

  const message = record.message;
  return typeof message === "string" && message.trim() ? message : fallback;
}

export default function OneproxyTab() {
  const t = useTranslations("settings");
  const [proxies, setProxies] = useState<OneproxyItem[]>([]);
  const [stats, setStats] = useState<OneproxyStats | null>(null);
  const [events, setEvents] = useState<OneproxyEvent[]>([]);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [filterProtocol, setFilterProtocol] = useState("");
  const [filterCountry, setFilterCountry] = useState("");
  const [minQuality, setMinQuality] = useState("");
  const [rotatingProxy, setRotatingProxy] = useState<RotatingProxySettings>(DEFAULT_ROTATING_PROXY);
  const [rotationSaving, setRotationSaving] = useState(false);
  const [rotationResult, setRotationResult] = useState<string | null>(null);
  const [rotatingProxyPolicy, setRotatingProxyPolicy] = useState<RotatingProxyPolicySettings>(
    DEFAULT_ROTATING_PROXY_POLICY
  );
  const [providerPolicyText, setProviderPolicyText] = useState("{}");
  const [accountPolicyText, setAccountPolicyText] = useState("{}");
  const [oneproxySync, setOneproxySync] = useState<OneproxyAutoSyncSettings>(DEFAULT_ONEPROXY_SYNC);
  const [autoSyncSaving, setAutoSyncSaving] = useState(false);
  const [autoSyncResult, setAutoSyncResult] = useState<string | null>(null);
  const [oneproxyHealth, setOneproxyHealth] =
    useState<OneproxyHealthSettings>(DEFAULT_ONEPROXY_HEALTH);
  const [healthStatus, setHealthStatus] = useState<OneproxyHealthStatus | null>(null);
  const [healthSaving, setHealthSaving] = useState(false);
  const [healthChecking, setHealthChecking] = useState(false);
  const [healthResult, setHealthResult] = useState<string | null>(null);
  const [oneproxyObservability, setOneproxyObservability] = useState<OneproxyObservabilitySettings>(
    DEFAULT_ONEPROXY_OBSERVABILITY
  );
  const [observabilityStatus, setObservabilityStatus] =
    useState<OneproxyObservabilityStatus | null>(null);
  const [poolAlerts, setPoolAlerts] = useState<OneproxyPoolAlert[]>([]);
  const [observabilitySaving, setObservabilitySaving] = useState(false);
  const [observabilityCleaning, setObservabilityCleaning] = useState(false);
  const [observabilityResult, setObservabilityResult] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterProtocol) params.set("protocol", filterProtocol);
      if (filterCountry) params.set("countryCode", filterCountry);
      if (minQuality) params.set("minQuality", minQuality);

      const [proxiesRes, statsRes, eventsRes, settingsRes] = await Promise.all([
        fetch(`/api/settings/oneproxy?${params.toString()}`),
        fetch("/api/settings/oneproxy?action=stats"),
        fetch("/api/settings/oneproxy?action=events&limit=12"),
        fetch("/api/settings"),
      ]);

      if (proxiesRes.ok) {
        const data = await proxiesRes.json();
        setProxies(data.items || []);
      }
      if (statsRes.ok) {
        const data = await statsRes.json();
        setStats(data.stats);
        setStatus(data.status);
        setHealthStatus(data.healthValidator || null);
        setObservabilityStatus(data.observability || null);
        setPoolAlerts(data.alerts || []);
      }
      if (eventsRes.ok) {
        const data = await eventsRes.json();
        setEvents(data.items || []);
      }
      if (settingsRes.ok) {
        const data = await settingsRes.json();
        setRotatingProxy({
          ...DEFAULT_ROTATING_PROXY,
          ...(data.rotatingProxy || {}),
        });
        const loadedPolicy = {
          ...DEFAULT_ROTATING_PROXY_POLICY,
          ...(data.rotatingProxyPolicy || {}),
          providerOverrides: data.rotatingProxyPolicy?.providerOverrides || {},
          accountOverrides: data.rotatingProxyPolicy?.accountOverrides || {},
        };
        setRotatingProxyPolicy(loadedPolicy);
        setProviderPolicyText(JSON.stringify(loadedPolicy.providerOverrides, null, 2));
        setAccountPolicyText(JSON.stringify(loadedPolicy.accountOverrides, null, 2));
        setOneproxySync({
          ...DEFAULT_ONEPROXY_SYNC,
          ...(data.oneproxySync || {}),
        });
        setOneproxyHealth({
          ...DEFAULT_ONEPROXY_HEALTH,
          ...(data.oneproxyHealth || {}),
        });
        setOneproxyObservability({
          ...DEFAULT_ONEPROXY_OBSERVABILITY,
          ...(data.oneproxyObservability || {}),
        });
      }
    } catch {
    } finally {
      setLoading(false);
    }
  }, [filterProtocol, filterCountry, minQuality]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/settings/oneproxy", { method: "POST" });
      const data = await res.json();
      if (res.ok && data.success) {
        setSyncResult(`Synced ${data.total} proxies (${data.added} new, ${data.updated} updated)`);
      } else {
        setSyncResult(
          `Sync failed: ${getResponseErrorMessage(data, res.statusText || "Unknown error")}`
        );
      }
      await loadData();
    } catch (err) {
      setSyncResult(`Sync failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSyncing(false);
    }
  };

  const handleSaveRotation = async () => {
    setRotationSaving(true);
    setRotationResult(null);
    try {
      const payload = {
        ...rotatingProxy,
        countryCode: rotatingProxy.countryCode?.trim() || null,
        minQuality: rotatingProxy.minQuality ?? null,
        stickyTtlMinutes: Math.max(1, Math.min(1440, Number(rotatingProxy.stickyTtlMinutes) || 30)),
      };
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rotatingProxy: payload }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRotationResult(
          `Save failed: ${getResponseErrorMessage(data, res.statusText || "Unknown error")}`
        );
        return;
      }
      setRotatingProxy(payload);
      setRotationResult(
        payload.enabled
          ? `Rotating proxy enabled (${payload.strategy}, ${payload.stickyMode})`
          : "Rotating proxy disabled"
      );
    } catch (err) {
      setRotationResult(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRotationSaving(false);
    }
  };

  const handleSaveProxyPolicy = async () => {
    setRotationSaving(true);
    setRotationResult(null);
    try {
      let providerOverrides: Record<string, RotatingProxyPolicyOverride>;
      let accountOverrides: Record<string, RotatingProxyPolicyOverride>;
      try {
        providerOverrides = JSON.parse(providerPolicyText || "{}");
        accountOverrides = JSON.parse(accountPolicyText || "{}");
      } catch {
        setRotationResult("Save failed: provider/account overrides must be valid JSON objects");
        return;
      }

      const payload = {
        ...rotatingProxyPolicy,
        mode: rotatingProxyPolicy.defaultMode,
        protocol: rotatingProxyPolicy.protocol || null,
        countryCode: rotatingProxyPolicy.countryCode?.trim().toUpperCase() || null,
        minQuality: rotatingProxyPolicy.minQuality ?? null,
        stickyTtlMinutes:
          rotatingProxyPolicy.stickyTtlMinutes == null
            ? null
            : Math.max(1, Math.min(1440, Number(rotatingProxyPolicy.stickyTtlMinutes) || 30)),
        maxProxyRetries: Math.max(1, Math.min(5, Number(rotatingProxyPolicy.maxProxyRetries) || 3)),
        providerOverrides,
        accountOverrides,
      };

      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rotatingProxyPolicy: payload }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRotationResult(
          `Save failed: ${getResponseErrorMessage(data, res.statusText || "Unknown error")}`
        );
        return;
      }
      setRotatingProxyPolicy(payload);
      setRotationResult(
        `Proxy policy saved (${payload.defaultMode}, ${payload.failBehavior}, ${payload.maxProxyRetries} attempts)`
      );
    } catch (err) {
      setRotationResult(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRotationSaving(false);
    }
  };
  const handleSaveAutoSync = async () => {
    setAutoSyncSaving(true);
    setAutoSyncResult(null);
    try {
      const payload = {
        ...oneproxySync,
        intervalMinutes: Math.max(5, Math.min(10080, Number(oneproxySync.intervalMinutes) || 360)),
        maxProxies: Math.max(1, Math.min(1000, Number(oneproxySync.maxProxies) || 500)),
        minQuality: Math.max(0, Math.min(100, Number(oneproxySync.minQuality) || 0)),
      };
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oneproxySync: payload }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAutoSyncResult(
          `Save failed: ${getResponseErrorMessage(data, res.statusText || "Unknown error")}`
        );
        return;
      }
      setOneproxySync(payload);
      setAutoSyncResult(
        payload.enabled
          ? `Auto sync enabled every ${payload.intervalMinutes} minutes`
          : "Auto sync disabled"
      );
    } catch (err) {
      setAutoSyncResult(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAutoSyncSaving(false);
    }
  };

  const handleSaveHealth = async () => {
    setHealthSaving(true);
    setHealthResult(null);
    try {
      const payload = {
        ...oneproxyHealth,
        intervalMinutes: Math.max(5, Math.min(10080, Number(oneproxyHealth.intervalMinutes) || 30)),
        batchSize: Math.max(1, Math.min(200, Number(oneproxyHealth.batchSize) || 25)),
        timeoutMs: Math.max(1000, Math.min(30000, Number(oneproxyHealth.timeoutMs) || 8000)),
        revalidateOlderThanMinutes: Math.max(
          5,
          Math.min(43200, Number(oneproxyHealth.revalidateOlderThanMinutes) || 60)
        ),
        maxFailures: Math.max(1, Math.min(10, Number(oneproxyHealth.maxFailures) || 3)),
        testUrl: oneproxyHealth.testUrl.trim() || DEFAULT_ONEPROXY_HEALTH.testUrl,
      };
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oneproxyHealth: payload }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setHealthResult(
          `Save failed: ${getResponseErrorMessage(data, res.statusText || "Unknown error")}`
        );
        return;
      }
      setOneproxyHealth(payload);
      setHealthResult(
        payload.enabled
          ? `Health validator enabled every ${payload.intervalMinutes} minutes`
          : "Health validator disabled"
      );
      await loadData();
    } catch (err) {
      setHealthResult(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setHealthSaving(false);
    }
  };

  const handleValidateNow = async () => {
    setHealthChecking(true);
    setHealthResult(null);
    try {
      const res = await fetch("/api/settings/oneproxy?action=validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batchSize: oneproxyHealth.batchSize,
          timeoutMs: oneproxyHealth.timeoutMs,
          testUrl: oneproxyHealth.testUrl,
          revalidateOlderThanMinutes: oneproxyHealth.revalidateOlderThanMinutes,
          maxFailures: oneproxyHealth.maxFailures,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) {
        setHealthResult(
          `Validation failed: ${getResponseErrorMessage(data, res.statusText || "Unknown error")}`
        );
        return;
      }
      setHealthResult(
        `Validated ${data.checked || 0} proxies (${data.healthy || 0} healthy, ${data.unhealthy || 0} unhealthy, ${data.deactivated || 0} deactivated)`
      );
      await loadData();
    } catch (err) {
      setHealthResult(`Validation failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setHealthChecking(false);
    }
  };

  const handleSaveObservability = async () => {
    setObservabilitySaving(true);
    setObservabilityResult(null);
    try {
      const payload = {
        ...oneproxyObservability,
        retentionDays: Math.max(
          1,
          Math.min(365, Number(oneproxyObservability.retentionDays) || 30)
        ),
        cleanupIntervalMinutes: Math.max(
          5,
          Math.min(10080, Number(oneproxyObservability.cleanupIntervalMinutes) || 360)
        ),
        minActiveProxies: Math.max(
          0,
          Math.min(100000, Number(oneproxyObservability.minActiveProxies) || 0)
        ),
        minSuccessRate: Math.max(
          0,
          Math.min(100, Number(oneproxyObservability.minSuccessRate) || 0)
        ),
        maxQuarantineRate: Math.max(
          0,
          Math.min(100, Number(oneproxyObservability.maxQuarantineRate) || 0)
        ),
      };
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oneproxyObservability: payload }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setObservabilityResult(
          `Save failed: ${getResponseErrorMessage(data, res.statusText || "Unknown error")}`
        );
        return;
      }
      setOneproxyObservability(payload);
      setObservabilityResult(
        `Observability saved: ${payload.retentionDays}d retention, cleanup every ${payload.cleanupIntervalMinutes} minutes`
      );
      await loadData();
    } catch (err) {
      setObservabilityResult(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setObservabilitySaving(false);
    }
  };

  const handleCleanupEvents = async () => {
    setObservabilityCleaning(true);
    setObservabilityResult(null);
    try {
      const res = await fetch("/api/settings/oneproxy?action=cleanup-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) {
        setObservabilityResult(
          `Cleanup failed: ${getResponseErrorMessage(data, res.statusText || "Unknown error")}`
        );
        return;
      }
      setObservabilityResult(`Cleaned up ${data.deleted || 0} old proxy events`);
      await loadData();
    } catch (err) {
      setObservabilityResult(`Cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setObservabilityCleaning(false);
    }
  };
  const handleClearAll = async () => {
    if (!confirm("Clear all 1proxy proxies?")) return;
    try {
      await fetch("/api/settings/oneproxy?clearAll=1", { method: "DELETE" });
      await loadData();
    } catch {
      // ignore
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await fetch(`/api/settings/oneproxy?id=${id}`, { method: "DELETE" });
      setProxies((prev) => prev.filter((p) => p.id !== id));
      if (stats) setStats({ ...stats, total: stats.total - 1, active: stats.active - 1 });
    } catch {
      // ignore
    }
  };

  const qualityColor = (score: number | null) => {
    if (score == null) return "bg-gray-500";
    if (score >= 80) return "bg-green-500";
    if (score >= 50) return "bg-yellow-500";
    return "bg-red-500";
  };

  const protocolBadge = (type: string) => {
    const colors: Record<string, string> = {
      http: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
      https: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
      socks4: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
      socks5: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
    };
    return colors[type] || "bg-gray-100 text-gray-800";
  };

  const isProxyQuarantined = (proxy: OneproxyItem) => {
    if (!proxy.quarantinedUntil) return false;
    const until = Date.parse(proxy.quarantinedUntil);
    return Number.isFinite(until) && until > Date.now();
  };

  const formatQuarantine = (value: string | null) => {
    if (!value) return "";
    const until = Date.parse(value);
    if (!Number.isFinite(until)) return "";
    const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60000));
    return `${minutes}m`;
  };

  const formatPercent = (value: number | null) => (value == null ? "—" : `${value.toFixed(1)}%`);

  const formatLatency = (value: number | null) => (value == null ? "—" : `${value}ms`);

  const formatShortDateTime = (value: string | null) => {
    if (!value) return "—";
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : "—";
  };

  const eventBadge = (eventType: string) => {
    if (eventType.includes("success") || eventType === "recovery") {
      return "bg-green-500/10 text-green-600";
    }
    if (eventType.includes("failure") || eventType === "quarantine") {
      return "bg-red-500/10 text-red-600";
    }
    return "bg-blue-500/10 text-blue-600";
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text-main">1proxy Free Proxy Marketplace</h2>
          <p className="text-sm text-text-muted mt-1">
            Fetch and rotate free validated proxies from the 1proxy community platform
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={handleSync} disabled={syncing} variant="primary">
            {syncing ? "Syncing..." : "Sync Now"}
          </Button>
          {proxies.length > 0 && (
            <Button onClick={handleClearAll} variant="danger">
              Clear All
            </Button>
          )}
        </div>
      </div>

      {syncResult && (
        <div
          className={`p-3 rounded-lg text-sm ${
            syncResult.startsWith("Synced")
              ? "bg-green-50 text-green-800 dark:bg-green-900/30 dark:text-green-300"
              : "bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-300"
          }`}
        >
          {syncResult}
        </div>
      )}

      {poolAlerts.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-text-main">Pool Degradation Alerts</h3>
          {poolAlerts.map((alert) => (
            <div
              key={alert.code}
              className={`rounded-lg border p-3 text-sm ${
                alert.severity === "critical"
                  ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
              }`}
            >
              <div className="font-medium">{alert.message}</div>
              <div className="mt-1 text-xs opacity-80">
                Current {alert.value} / threshold {alert.threshold}
              </div>
            </div>
          ))}
        </div>
      )}
      <Card className="p-4 space-y-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <h3 className="text-sm font-semibold text-text-main">Auto Sync Interval</h3>
            <p className="mt-1 text-sm text-text-muted">
              Keep the 1proxy pool fresh in the background so rotating proxy has active candidates.
            </p>
          </div>
          <label className="inline-flex items-center gap-2 text-sm text-text-main">
            <input
              type="checkbox"
              checked={oneproxySync.enabled}
              onChange={(e) => setOneproxySync((prev) => ({ ...prev, enabled: e.target.checked }))}
            />
            Enable auto sync
          </label>
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          <label className="text-xs text-text-muted">
            Interval minutes
            <input
              type="number"
              min={5}
              max={10080}
              value={oneproxySync.intervalMinutes}
              onChange={(e) =>
                setOneproxySync((prev) => ({
                  ...prev,
                  intervalMinutes: Number(e.target.value) || DEFAULT_ONEPROXY_SYNC.intervalMinutes,
                }))
              }
              className="mt-1 w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border"
            />
          </label>
          <label className="text-xs text-text-muted">
            Max proxies
            <input
              type="number"
              min={1}
              max={1000}
              value={oneproxySync.maxProxies}
              onChange={(e) =>
                setOneproxySync((prev) => ({
                  ...prev,
                  maxProxies: Number(e.target.value) || DEFAULT_ONEPROXY_SYNC.maxProxies,
                }))
              }
              className="mt-1 w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border"
            />
          </label>
          <label className="text-xs text-text-muted">
            Min quality
            <input
              type="number"
              min={0}
              max={100}
              value={oneproxySync.minQuality}
              onChange={(e) =>
                setOneproxySync((prev) => ({
                  ...prev,
                  minQuality: Number(e.target.value),
                }))
              }
              className="mt-1 w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border"
            />
          </label>
          <label className="flex items-end gap-2 pb-2 text-sm text-text-main">
            <input
              type="checkbox"
              checked={oneproxySync.syncOnStartup}
              onChange={(e) =>
                setOneproxySync((prev) => ({ ...prev, syncOnStartup: e.target.checked }))
              }
            />
            Sync after startup
          </label>
        </div>

        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <p className="text-xs text-text-muted">
            Minimum interval is 5 minutes. Manual Sync Now still works and updates the same pool.
          </p>
          <Button onClick={handleSaveAutoSync} disabled={autoSyncSaving} variant="secondary">
            {autoSyncSaving ? "Saving..." : "Save Auto Sync"}
          </Button>
        </div>

        {autoSyncResult && (
          <div
            className={`p-3 rounded-lg text-sm ${
              autoSyncResult.startsWith("Save failed")
                ? "bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-300"
                : "bg-green-50 text-green-800 dark:bg-green-900/30 dark:text-green-300"
            }`}
          >
            {autoSyncResult}
          </div>
        )}
      </Card>

      <Card className="p-4 space-y-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <h3 className="text-sm font-semibold text-text-main">Proxy Health Validator</h3>
            <p className="mt-1 text-sm text-text-muted">
              Periodically tests stale 1proxy entries, refreshes latency and quality, and
              deactivates repeated failures before rotation selects them.
            </p>
          </div>
          <label className="inline-flex items-center gap-2 text-sm text-text-main">
            <input
              type="checkbox"
              checked={oneproxyHealth.enabled}
              onChange={(e) =>
                setOneproxyHealth((prev) => ({ ...prev, enabled: e.target.checked }))
              }
            />
            Enable validator
          </label>
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          <label className="text-xs text-text-muted">
            Interval minutes
            <input
              type="number"
              min={5}
              max={10080}
              value={oneproxyHealth.intervalMinutes}
              onChange={(e) =>
                setOneproxyHealth((prev) => ({
                  ...prev,
                  intervalMinutes:
                    Number(e.target.value) || DEFAULT_ONEPROXY_HEALTH.intervalMinutes,
                }))
              }
              className="mt-1 w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border"
            />
          </label>
          <label className="text-xs text-text-muted">
            Batch size
            <input
              type="number"
              min={1}
              max={200}
              value={oneproxyHealth.batchSize}
              onChange={(e) =>
                setOneproxyHealth((prev) => ({
                  ...prev,
                  batchSize: Number(e.target.value) || DEFAULT_ONEPROXY_HEALTH.batchSize,
                }))
              }
              className="mt-1 w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border"
            />
          </label>
          <label className="text-xs text-text-muted">
            Timeout ms
            <input
              type="number"
              min={1000}
              max={30000}
              value={oneproxyHealth.timeoutMs}
              onChange={(e) =>
                setOneproxyHealth((prev) => ({
                  ...prev,
                  timeoutMs: Number(e.target.value) || DEFAULT_ONEPROXY_HEALTH.timeoutMs,
                }))
              }
              className="mt-1 w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border"
            />
          </label>
          <label className="text-xs text-text-muted">
            Revalidate older than
            <input
              type="number"
              min={5}
              max={43200}
              value={oneproxyHealth.revalidateOlderThanMinutes}
              onChange={(e) =>
                setOneproxyHealth((prev) => ({
                  ...prev,
                  revalidateOlderThanMinutes:
                    Number(e.target.value) || DEFAULT_ONEPROXY_HEALTH.revalidateOlderThanMinutes,
                }))
              }
              className="mt-1 w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border"
            />
          </label>
          <label className="text-xs text-text-muted">
            Max failures
            <input
              type="number"
              min={1}
              max={10}
              value={oneproxyHealth.maxFailures}
              onChange={(e) =>
                setOneproxyHealth((prev) => ({
                  ...prev,
                  maxFailures: Number(e.target.value) || DEFAULT_ONEPROXY_HEALTH.maxFailures,
                }))
              }
              className="mt-1 w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border"
            />
          </label>
          <label className="text-xs text-text-muted md:col-span-2">
            Test URL
            <input
              value={oneproxyHealth.testUrl}
              onChange={(e) => setOneproxyHealth((prev) => ({ ...prev, testUrl: e.target.value }))}
              className="mt-1 w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border"
            />
          </label>
          <label className="flex items-end gap-2 pb-2 text-sm text-text-main">
            <input
              type="checkbox"
              checked={oneproxyHealth.validateOnStartup}
              onChange={(e) =>
                setOneproxyHealth((prev) => ({ ...prev, validateOnStartup: e.target.checked }))
              }
            />
            Validate after startup
          </label>
        </div>

        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <p className="text-xs text-text-muted">
            Last run:{" "}
            {healthStatus?.lastRunAt ? new Date(healthStatus.lastRunAt).toLocaleString() : "Never"}
            {healthStatus
              ? ` | checked ${healthStatus.lastChecked}, healthy ${healthStatus.lastHealthy}, unhealthy ${healthStatus.lastUnhealthy}`
              : ""}
          </p>
          <div className="flex gap-2">
            <Button onClick={handleValidateNow} disabled={healthChecking} variant="secondary">
              {healthChecking ? "Validating..." : "Validate Now"}
            </Button>
            <Button onClick={handleSaveHealth} disabled={healthSaving} variant="secondary">
              {healthSaving ? "Saving..." : "Save Validator"}
            </Button>
          </div>
        </div>

        {healthResult && (
          <div
            className={`p-3 rounded-lg text-sm ${
              healthResult.startsWith("Save failed") || healthResult.startsWith("Validation failed")
                ? "bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-300"
                : "bg-green-50 text-green-800 dark:bg-green-900/30 dark:text-green-300"
            }`}
          >
            {healthResult}
          </div>
        )}
      </Card>

      <Card className="p-4 space-y-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <h3 className="text-sm font-semibold text-text-main">Proxy Observability Retention</h3>
            <p className="mt-1 text-sm text-text-muted">
              Retain enough proxy events for scoring and troubleshooting, while pruning old noise
              automatically.
            </p>
          </div>
          <label className="inline-flex items-center gap-2 text-sm text-text-main">
            <input
              type="checkbox"
              checked={oneproxyObservability.alertsEnabled}
              onChange={(e) =>
                setOneproxyObservability((prev) => ({
                  ...prev,
                  alertsEnabled: e.target.checked,
                }))
              }
            />
            Enable pool alerts
          </label>
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          <label className="text-xs text-text-muted">
            Retention days
            <input
              type="number"
              min={1}
              max={365}
              value={oneproxyObservability.retentionDays}
              onChange={(e) =>
                setOneproxyObservability((prev) => ({
                  ...prev,
                  retentionDays:
                    Number(e.target.value) || DEFAULT_ONEPROXY_OBSERVABILITY.retentionDays,
                }))
              }
              className="mt-1 w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border"
            />
          </label>
          <label className="text-xs text-text-muted">
            Cleanup interval
            <input
              type="number"
              min={5}
              max={10080}
              value={oneproxyObservability.cleanupIntervalMinutes}
              onChange={(e) =>
                setOneproxyObservability((prev) => ({
                  ...prev,
                  cleanupIntervalMinutes:
                    Number(e.target.value) || DEFAULT_ONEPROXY_OBSERVABILITY.cleanupIntervalMinutes,
                }))
              }
              className="mt-1 w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border"
            />
          </label>
          <label className="text-xs text-text-muted">
            Min active pool
            <input
              type="number"
              min={0}
              max={100000}
              value={oneproxyObservability.minActiveProxies}
              onChange={(e) =>
                setOneproxyObservability((prev) => ({
                  ...prev,
                  minActiveProxies: Number(e.target.value) || 0,
                }))
              }
              className="mt-1 w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border"
            />
          </label>
          <label className="text-xs text-text-muted">
            Min success %
            <input
              type="number"
              min={0}
              max={100}
              value={oneproxyObservability.minSuccessRate}
              onChange={(e) =>
                setOneproxyObservability((prev) => ({
                  ...prev,
                  minSuccessRate: Number(e.target.value) || 0,
                }))
              }
              className="mt-1 w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border"
            />
          </label>
          <label className="text-xs text-text-muted">
            Max quarantine %
            <input
              type="number"
              min={0}
              max={100}
              value={oneproxyObservability.maxQuarantineRate}
              onChange={(e) =>
                setOneproxyObservability((prev) => ({
                  ...prev,
                  maxQuarantineRate: Number(e.target.value) || 0,
                }))
              }
              className="mt-1 w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border"
            />
          </label>
          <label className="flex items-end gap-2 pb-2 text-sm text-text-main">
            <input
              type="checkbox"
              checked={oneproxyObservability.cleanupOnStartup}
              onChange={(e) =>
                setOneproxyObservability((prev) => ({
                  ...prev,
                  cleanupOnStartup: e.target.checked,
                }))
              }
            />
            Cleanup after startup
          </label>
        </div>

        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <p className="text-xs text-text-muted">
            Last cleanup: {formatShortDateTime(observabilityStatus?.lastRunAt || null)}
            {observabilityStatus ? ` | deleted ${observabilityStatus.lastDeleted}` : ""}
          </p>
          <div className="flex gap-2">
            <Button
              onClick={handleCleanupEvents}
              disabled={observabilityCleaning}
              variant="secondary"
            >
              {observabilityCleaning ? "Cleaning..." : "Cleanup Now"}
            </Button>
            <Button
              onClick={handleSaveObservability}
              disabled={observabilitySaving}
              variant="secondary"
            >
              {observabilitySaving ? "Saving..." : "Save Observability"}
            </Button>
          </div>
        </div>

        {observabilityResult && (
          <div
            className={`p-3 rounded-lg text-sm ${
              observabilityResult.startsWith("Save failed") ||
              observabilityResult.startsWith("Cleanup failed")
                ? "bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-300"
                : "bg-green-50 text-green-800 dark:bg-green-900/30 dark:text-green-300"
            }`}
          >
            {observabilityResult}
          </div>
        )}
      </Card>
      <Card className="p-4 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-text-main">Proxy Policy Profile</h3>
          <p className="mt-1 text-sm text-text-muted">
            Control whether rotating proxy is bypassed, optional, or required globally, with
            provider/account overrides for sensitive or fragile upstreams.
          </p>
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          <label className="text-xs text-text-muted">
            Global policy
            <select
              value={rotatingProxyPolicy.defaultMode}
              onChange={(e) =>
                setRotatingProxyPolicy((prev) => ({
                  ...prev,
                  defaultMode: e.target.value as RotatingProxyPolicyMode,
                  mode: e.target.value as RotatingProxyPolicyMode,
                }))
              }
              className="mt-1 w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border"
            >
              <option value="optional">Optional</option>
              <option value="required">Required</option>
              <option value="disabled">Disabled / bypass</option>
            </select>
          </label>
          <label className="text-xs text-text-muted">
            Required failure
            <select
              value={rotatingProxyPolicy.failBehavior}
              onChange={(e) =>
                setRotatingProxyPolicy((prev) => ({
                  ...prev,
                  failBehavior: e.target.value as RotatingProxyFailBehavior,
                }))
              }
              className="mt-1 w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border"
            >
              <option value="fail-open">Fail open</option>
              <option value="fail-closed">Fail closed</option>
            </select>
          </label>
          <label className="text-xs text-text-muted">
            Policy protocol
            <select
              value={rotatingProxyPolicy.protocol || ""}
              onChange={(e) =>
                setRotatingProxyPolicy((prev) => ({
                  ...prev,
                  protocol: (e.target.value || null) as RotatingProxyPolicySettings["protocol"],
                }))
              }
              className="mt-1 w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border"
            >
              <option value="">Use rotation setting</option>
              <option value="http">HTTP</option>
              <option value="https">HTTPS</option>
              <option value="socks5">SOCKS5</option>
            </select>
          </label>
          <label className="text-xs text-text-muted">
            Max proxy attempts
            <input
              type="number"
              min={1}
              max={5}
              value={rotatingProxyPolicy.maxProxyRetries ?? 3}
              onChange={(e) =>
                setRotatingProxyPolicy((prev) => ({
                  ...prev,
                  maxProxyRetries: Number(e.target.value) || 3,
                }))
              }
              className="mt-1 w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border"
            />
          </label>
          <label className="text-xs text-text-muted">
            Policy country
            <input
              value={rotatingProxyPolicy.countryCode || ""}
              onChange={(e) =>
                setRotatingProxyPolicy((prev) => ({
                  ...prev,
                  countryCode: e.target.value.trim().toUpperCase() || null,
                }))
              }
              placeholder="Use rotation setting"
              maxLength={2}
              className="mt-1 w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border"
            />
          </label>
          <label className="text-xs text-text-muted">
            Policy min quality
            <input
              type="number"
              min={0}
              max={100}
              value={rotatingProxyPolicy.minQuality ?? ""}
              onChange={(e) =>
                setRotatingProxyPolicy((prev) => ({
                  ...prev,
                  minQuality: e.target.value ? Number(e.target.value) : null,
                }))
              }
              placeholder="Use rotation setting"
              className="mt-1 w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border"
            />
          </label>
          <label className="text-xs text-text-muted">
            Policy sticky mode
            <select
              value={rotatingProxyPolicy.stickyMode || ""}
              onChange={(e) =>
                setRotatingProxyPolicy((prev) => ({
                  ...prev,
                  stickyMode: (e.target.value || null) as RotatingProxyPolicySettings["stickyMode"],
                }))
              }
              className="mt-1 w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border"
            >
              <option value="">Use rotation setting</option>
              <option value="per-request">Per request</option>
              <option value="per-session">Per session + provider account</option>
              <option value="per-provider">Per provider</option>
              <option value="per-provider-account">Per provider account</option>
              <option value="per-api-key">Per API key</option>
              <option value="time-window">Time window</option>
            </select>
          </label>
          <label className="text-xs text-text-muted">
            Policy sticky TTL
            <input
              type="number"
              min={1}
              max={1440}
              value={rotatingProxyPolicy.stickyTtlMinutes ?? ""}
              onChange={(e) =>
                setRotatingProxyPolicy((prev) => ({
                  ...prev,
                  stickyTtlMinutes: e.target.value ? Number(e.target.value) || 30 : null,
                }))
              }
              className="mt-1 w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border"
            />
          </label>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-xs text-text-muted">
            Provider overrides JSON
            <textarea
              value={providerPolicyText}
              onChange={(e) => setProviderPolicyText(e.target.value)}
              rows={5}
              spellCheck={false}
              className="mt-1 w-full rounded-lg border border-border bg-black/5 px-3 py-2 font-mono text-xs text-text-main dark:bg-white/5"
            />
          </label>
          <label className="text-xs text-text-muted">
            Account overrides JSON
            <textarea
              value={accountPolicyText}
              onChange={(e) => setAccountPolicyText(e.target.value)}
              rows={5}
              spellCheck={false}
              className="mt-1 w-full rounded-lg border border-border bg-black/5 px-3 py-2 font-mono text-xs text-text-main dark:bg-white/5"
            />
          </label>
        </div>

        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <p className="text-xs text-text-muted">
            Override example:{" "}
            {`{"openai":{"mode":"disabled"},"anthropic":{"mode":"required","failBehavior":"fail-closed","maxProxyRetries":2}}`}
          </p>
          <Button onClick={handleSaveProxyPolicy} disabled={rotationSaving} variant="secondary">
            {rotationSaving ? "Saving..." : "Save Policy"}
          </Button>
        </div>
      </Card>
      <Card className="p-4 space-y-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <h3 className="text-sm font-semibold text-text-main">Request-time Rotating Proxy</h3>
            <p className="mt-1 text-sm text-text-muted">
              When enabled, OmniRoute selects a fresh 1proxy entry for upstream provider requests
              before falling back to fixed proxy assignments.
            </p>
          </div>
          <label className="inline-flex items-center gap-2 text-sm text-text-main">
            <input
              type="checkbox"
              checked={rotatingProxy.enabled}
              onChange={(e) => setRotatingProxy((prev) => ({ ...prev, enabled: e.target.checked }))}
            />
            Enable rotation
          </label>
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          <label className="text-xs text-text-muted">
            Strategy
            <select
              value={rotatingProxy.strategy}
              onChange={(e) =>
                setRotatingProxy((prev) => ({
                  ...prev,
                  strategy: e.target.value as RotatingProxySettings["strategy"],
                }))
              }
              className="mt-1 w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border"
            >
              <option value="random">Random</option>
              <option value="quality">Quality</option>
              <option value="sequential">Sequential</option>
            </select>
          </label>
          <label className="text-xs text-text-muted">
            Scope
            <select
              value={rotatingProxy.scope}
              onChange={(e) =>
                setRotatingProxy((prev) => ({
                  ...prev,
                  scope: e.target.value as RotatingProxySettings["scope"],
                }))
              }
              className="mt-1 w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border"
            >
              <option value="global">Global</option>
              <option value="provider">Provider requests</option>
            </select>
          </label>
          <label className="text-xs text-text-muted">
            Protocol
            <select
              value={rotatingProxy.protocol || ""}
              onChange={(e) =>
                setRotatingProxy((prev) => ({
                  ...prev,
                  protocol: (e.target.value || null) as RotatingProxySettings["protocol"],
                }))
              }
              className="mt-1 w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border"
            >
              <option value="">Any supported</option>
              <option value="http">HTTP</option>
              <option value="https">HTTPS</option>
              <option value="socks5">SOCKS5</option>
            </select>
          </label>
          <label className="text-xs text-text-muted">
            Country
            <input
              value={rotatingProxy.countryCode || ""}
              onChange={(e) =>
                setRotatingProxy((prev) => ({
                  ...prev,
                  countryCode: e.target.value.trim().toUpperCase() || null,
                }))
              }
              placeholder="US"
              maxLength={2}
              className="mt-1 w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border"
            />
          </label>
          <label className="text-xs text-text-muted">
            Min quality
            <input
              type="number"
              min={0}
              max={100}
              value={rotatingProxy.minQuality ?? ""}
              onChange={(e) =>
                setRotatingProxy((prev) => ({
                  ...prev,
                  minQuality: e.target.value ? Number(e.target.value) : null,
                }))
              }
              className="mt-1 w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border"
            />
          </label>
          <label className="text-xs text-text-muted">
            Sticky mode
            <select
              value={rotatingProxy.stickyMode}
              onChange={(e) =>
                setRotatingProxy((prev) => ({
                  ...prev,
                  stickyMode: e.target.value as RotatingProxySettings["stickyMode"],
                }))
              }
              className="mt-1 w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border"
            >
              <option value="per-request">Per request</option>
              <option value="per-session">Per session + provider account</option>
              <option value="per-provider">Per provider</option>
              <option value="per-provider-account">Per provider account</option>
              <option value="per-api-key">Per API key</option>
              <option value="time-window">Time window</option>
            </select>
          </label>
          <label className="text-xs text-text-muted">
            Sticky TTL minutes
            <input
              type="number"
              min={1}
              max={1440}
              value={rotatingProxy.stickyTtlMinutes}
              onChange={(e) =>
                setRotatingProxy((prev) => ({
                  ...prev,
                  stickyTtlMinutes:
                    Number(e.target.value) || DEFAULT_ROTATING_PROXY.stickyTtlMinutes,
                }))
              }
              className="mt-1 w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border"
            />
          </label>
        </div>

        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <p className="text-xs text-text-muted">
            Sticky modes reuse the same proxy for a provider account, API key, or fixed time window.
            Per-session sticky is account-aware, so different provider accounts do not share the
            same IP. Same-request retry still excludes failed proxies.
          </p>
          <Button onClick={handleSaveRotation} disabled={rotationSaving} variant="secondary">
            {rotationSaving ? "Saving..." : "Save Rotation"}
          </Button>
        </div>

        {rotationResult && (
          <div
            className={`p-3 rounded-lg text-sm ${
              rotationResult.startsWith("Save failed")
                ? "bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-300"
                : "bg-green-50 text-green-800 dark:bg-green-900/30 dark:text-green-300"
            }`}
          >
            {rotationResult}
          </div>
        )}
      </Card>

      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 xl:grid-cols-9 gap-4">
          <Card className="p-4">
            <div className="text-2xl font-bold text-text-main">{stats.total}</div>
            <div className="text-sm text-text-muted">Total Proxies</div>
          </Card>
          <Card className="p-4">
            <div className="text-2xl font-bold text-green-600">{stats.active}</div>
            <div className="text-sm text-text-muted">Active</div>
          </Card>
          <Card className="p-4">
            <div className="text-2xl font-bold text-amber-600">{stats.quarantined}</div>
            <div className="text-sm text-text-muted">Quarantined</div>
          </Card>
          <Card className="p-4">
            <div className="text-2xl font-bold text-text-main">{stats.requestCount || 0}</div>
            <div className="text-sm text-text-muted">Requests</div>
          </Card>
          <Card className="p-4">
            <div className="text-2xl font-bold text-text-main">
              {formatPercent(stats.successRate)}
            </div>
            <div className="text-sm text-text-muted">Success Rate</div>
          </Card>
          <Card className="p-4">
            <div className="text-2xl font-bold text-text-main">
              {formatLatency(stats.avgLatencyMs)}
            </div>
            <div className="text-sm text-text-muted">Avg Runtime</div>
          </Card>
          <Card className="p-4">
            <div className="text-2xl font-bold text-text-main">
              {stats.avgQuality != null ? `${stats.avgQuality}` : "—"}
            </div>
            <div className="text-sm text-text-muted">Avg Quality</div>
          </Card>
          <Card className="p-4">
            <div className="text-2xl font-bold text-text-main">
              {stats.avgEffectiveScore != null ? `${stats.avgEffectiveScore}` : "—"}
            </div>
            <div className="text-sm text-text-muted">Avg Pool Score</div>
          </Card>
          <Card className="p-4">
            <div className="text-2xl font-bold text-text-main">
              {status?.lastSyncAt ? new Date(status.lastSyncAt).toLocaleTimeString() : "Never"}
            </div>
            <div className="text-sm text-text-muted">Last Sync</div>
          </Card>
        </div>
      )}

      <Card className="p-4">
        <div className="flex flex-wrap gap-3">
          <select
            value={filterProtocol}
            onChange={(e) => setFilterProtocol(e.target.value)}
            className="px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border"
          >
            <option value="">All Protocols</option>
            <option value="http">HTTP</option>
            <option value="https">HTTPS</option>
            <option value="socks4">SOCKS4</option>
            <option value="socks5">SOCKS5</option>
          </select>
          <input
            type="text"
            placeholder="Country code (e.g. US)"
            value={filterCountry}
            onChange={(e) => setFilterCountry(e.target.value)}
            className="px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border w-40"
          />
          <input
            type="number"
            placeholder="Min quality"
            value={minQuality}
            onChange={(e) => setMinQuality(e.target.value)}
            className="px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-text-main text-sm border border-border w-32"
          />
        </div>
      </Card>

      <Card className="p-4">
        {loading ? (
          <div className="text-center py-8 text-text-muted">Loading proxies...</div>
        ) : proxies.length === 0 ? (
          <div className="text-center py-8 text-text-muted">
            No 1proxy proxies found. Click &quot;Sync Now&quot; to fetch free proxies.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 px-3 text-text-muted font-medium">Host</th>
                  <th className="text-left py-2 px-3 text-text-muted font-medium">Protocol</th>
                  <th className="text-left py-2 px-3 text-text-muted font-medium">Country</th>
                  <th className="text-left py-2 px-3 text-text-muted font-medium">Pool Score</th>
                  <th className="text-left py-2 px-3 text-text-muted font-medium">Quality</th>
                  <th className="text-left py-2 px-3 text-text-muted font-medium">Latency</th>
                  <th className="text-left py-2 px-3 text-text-muted font-medium">Requests</th>
                  <th className="text-left py-2 px-3 text-text-muted font-medium">Success</th>
                  <th className="text-left py-2 px-3 text-text-muted font-medium">Avg Runtime</th>
                  <th className="text-left py-2 px-3 text-text-muted font-medium">Last Used</th>
                  <th className="text-left py-2 px-3 text-text-muted font-medium">Anonymity</th>
                  <th className="text-left py-2 px-3 text-text-muted font-medium">Google</th>
                  <th className="text-left py-2 px-3 text-text-muted font-medium">State</th>
                  <th className="text-left py-2 px-3 text-text-muted font-medium">Streak</th>
                  <th className="text-left py-2 px-3 text-text-muted font-medium">Last Error</th>
                  <th className="text-left py-2 px-3 text-text-muted font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {proxies.map((proxy) => (
                  <tr
                    key={proxy.id}
                    className="border-b border-border/50 hover:bg-black/5 dark:hover:bg-white/5"
                  >
                    <td className="py-2 px-3 font-mono text-text-main">
                      {proxy.host}:{proxy.port}
                    </td>
                    <td className="py-2 px-3">
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${protocolBadge(proxy.type)}`}
                      >
                        {proxy.type.toUpperCase()}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-text-main">{proxy.countryCode || "—"}</td>
                    <td className="py-2 px-3">
                      <div className="flex items-center gap-2">
                        <div
                          className={`w-3 h-3 rounded-full ${qualityColor(proxy.effectiveScore)}`}
                        />
                        <span className="text-text-main">{proxy.effectiveScore}</span>
                      </div>
                    </td>
                    <td className="py-2 px-3">
                      <div className="flex items-center gap-2">
                        <div
                          className={`w-3 h-3 rounded-full ${qualityColor(proxy.qualityScore)}`}
                        />
                        <span className="text-text-main">{proxy.qualityScore ?? "—"}</span>
                      </div>
                    </td>
                    <td className="py-2 px-3 text-text-main">
                      {proxy.latencyMs != null ? `${proxy.latencyMs}ms` : "—"}
                    </td>
                    <td className="py-2 px-3 text-text-main">{proxy.requestCount || 0}</td>
                    <td className="py-2 px-3 text-text-main">
                      <div>{formatPercent(proxy.successRate)}</div>
                      <div className="text-xs text-text-muted">
                        1h {formatPercent(proxy.successRate1h)} / 24h{" "}
                        {formatPercent(proxy.successRate24h)}
                      </div>
                    </td>
                    <td className="py-2 px-3 text-text-main">
                      {formatLatency(proxy.avgLatencyMs)}
                    </td>
                    <td className="py-2 px-3 text-text-muted">
                      {formatShortDateTime(proxy.lastUsedAt)}
                    </td>
                    <td className="py-2 px-3 text-text-main">{proxy.anonymity || "—"}</td>
                    <td className="py-2 px-3">
                      {proxy.googleAccess ? (
                        <span className="text-green-600">&#10003;</span>
                      ) : (
                        <span className="text-red-600">&#10007;</span>
                      )}
                    </td>
                    <td className="py-2 px-3">
                      {isProxyQuarantined(proxy) ? (
                        <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600">
                          Quarantine {formatQuarantine(proxy.quarantinedUntil)}
                        </span>
                      ) : proxy.status === "inactive" ? (
                        <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-600">
                          Inactive
                        </span>
                      ) : (
                        <span className="rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-600">
                          Active
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-text-main">{proxy.failureStreak}</td>
                    <td
                      className="py-2 px-3 max-w-52 truncate text-text-muted"
                      title={proxy.lastError || ""}
                    >
                      {proxy.lastErrorType || proxy.lastError || "—"}
                    </td>
                    <td className="py-2 px-3">
                      <button
                        onClick={() => handleDelete(proxy.id)}
                        className="text-red-500 hover:text-red-700 text-xs"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {events.length > 0 && (
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-text-main">Recent Proxy Events</h3>
            <span className="text-xs text-text-muted">Latest runtime and validator signals</span>
          </div>
          <div className="space-y-2">
            {events.map((event) => (
              <div
                key={event.id}
                className="flex flex-col gap-2 rounded-lg border border-border/60 p-3 text-sm md:flex-row md:items-center md:justify-between"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${eventBadge(event.eventType)}`}
                  >
                    {event.eventType.replace(/_/g, " ")}
                  </span>
                  <span className="font-mono text-text-main">
                    {event.host || "unknown"}
                    {event.port ? `:${event.port}` : ""}
                  </span>
                  {event.latencyMs != null && (
                    <span className="text-text-muted">{event.latencyMs}ms</span>
                  )}
                  {(event.errorType || event.errorMessage) && (
                    <span className="max-w-md truncate text-red-600">
                      {event.errorType || event.errorMessage}
                    </span>
                  )}
                </div>
                <span className="text-xs text-text-muted">
                  {formatShortDateTime(event.createdAt)}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {status && (
        <Card className="p-4">
          <h3 className="text-sm font-semibold text-text-main mb-2">Sync Status</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <div>
              <span className="text-text-muted">Last sync: </span>
              <span className={status.lastSyncSuccess ? "text-green-600" : "text-red-600"}>
                {status.lastSyncSuccess ? "Success" : "Failed"}
              </span>
            </div>
            <div>
              <span className="text-text-muted">Proxies fetched: </span>
              <span className="text-text-main">{status.lastSyncCount}</span>
            </div>
            <div>
              <span className="text-text-muted">Consecutive failures: </span>
              <span className="text-text-main">{status.consecutiveFailures}</span>
            </div>
            {status.lastSyncError && (
              <div className="col-span-full">
                <span className="text-text-muted">Error: </span>
                <span className="text-red-600 text-xs">{status.lastSyncError}</span>
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
