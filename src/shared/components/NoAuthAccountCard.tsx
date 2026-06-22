"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Card from "./Card";
import Button from "./Button";
import DistributeProxiesButton from "./DistributeProxiesButton";

interface NoAuthAccountCardProps {
  providerId: string;
  providerName: string;
  generateAccountId: () => string;
  dataKey?: string;
  description?: string;
  addLabel?: string;
  allowDeleteAll?: boolean;
}

interface Connection {
  id: string;
  provider: string;
  authType?: string;
  name?: string;
  apiKey?: string;
  providerSpecificData?: Record<string, any>;
  isActive?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

interface AccountProxyConfig {
  fingerprint: string;
  proxy: {
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
}

const PROXY_TYPES = [
  { value: "http", label: "HTTP" },
  { value: "https", label: "HTTPS" },
  { value: "socks5", label: "SOCKS5" },
];
const MAX_BULK_ACCOUNT_CREATE = 100;
const MAX_BULK_CONNECTION_DELETE = 100;

function getAccountProxies(conn: Connection | undefined): AccountProxyConfig[] {
  return (conn?.providerSpecificData?.accountProxies as AccountProxyConfig[]) || [];
}

function getProxyForFingerprint(proxies: AccountProxyConfig[], fp: string) {
  return proxies.find((p) => p.fingerprint === fp)?.proxy ?? null;
}

function getProxyDisplayLabel(proxy: AccountProxyConfig["proxy"]): string {
  if (!proxy) return "Proxy";
  if (typeof proxy.proxyName === "string" && proxy.proxyName.trim().length > 0) {
    return proxy.proxyName.trim();
  }
  if (typeof proxy.proxyId === "string" && proxy.proxyId.trim().length > 0) {
    return `${proxy.type}://${proxy.host} (${proxy.proxyId.trim().slice(0, 8)})`;
  }
  return `${proxy.type}://${proxy.host}`;
}

function getProxyDisplayTitle(proxy: AccountProxyConfig["proxy"]): string {
  if (!proxy) return "Configure proxy";
  const parts = [`${proxy.type}://${proxy.host}:${proxy.port}`];
  if (typeof proxy.proxyName === "string" && proxy.proxyName.trim().length > 0) {
    parts.push(proxy.proxyName.trim());
  }
  if (typeof proxy.proxyId === "string" && proxy.proxyId.trim().length > 0) {
    parts.push(proxy.proxyId.trim());
  }
  return parts.join(" | ");
}

function getAccountIds(conn: Connection | undefined, dataKey: string): string[] {
  const raw = conn?.providerSpecificData?.[dataKey];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0
  );
}

function getUniqueAccountIds(connections: Connection[], dataKey: string): string[] {
  return Array.from(new Set(connections.flatMap((conn) => getAccountIds(conn, dataKey))));
}

function mergeAccountProxies(connections: Connection[]): AccountProxyConfig[] {
  const merged = new Map<string, AccountProxyConfig["proxy"]>();
  for (const conn of connections) {
    for (const entry of getAccountProxies(conn)) {
      if (!entry?.fingerprint || typeof entry.fingerprint !== "string") continue;
      merged.set(entry.fingerprint, entry.proxy ?? null);
    }
  }
  return Array.from(merged.entries()).map(([fingerprint, proxy]) => ({ fingerprint, proxy }));
}

function compareIsoDateAsc(a?: string, b?: string): number {
  const left = typeof a === "string" ? Date.parse(a) : Number.NaN;
  const right = typeof b === "string" ? Date.parse(b) : Number.NaN;
  const safeLeft = Number.isFinite(left) ? left : Number.MAX_SAFE_INTEGER;
  const safeRight = Number.isFinite(right) ? right : Number.MAX_SAFE_INTEGER;
  return safeLeft - safeRight;
}

function pickPrimaryConnection(connections: Connection[], dataKey: string): Connection | undefined {
  if (connections.length === 0) return undefined;

  return [...connections].sort((left, right) => {
    const leftActive = left.isActive !== false ? 1 : 0;
    const rightActive = right.isActive !== false ? 1 : 0;
    if (leftActive !== rightActive) return rightActive - leftActive;

    const leftApiKey = left.authType === "apikey" ? 1 : 0;
    const rightApiKey = right.authType === "apikey" ? 1 : 0;
    if (leftApiKey !== rightApiKey) return rightApiKey - leftApiKey;

    const leftAccounts = getAccountIds(left, dataKey).length;
    const rightAccounts = getAccountIds(right, dataKey).length;
    if (leftAccounts !== rightAccounts) return rightAccounts - leftAccounts;

    return compareIsoDateAsc(left.createdAt, right.createdAt);
  })[0];
}

function buildMergedProviderSpecificData(
  connections: Connection[],
  primary: Connection | undefined,
  dataKey: string
): Record<string, any> {
  const base =
    primary?.providerSpecificData && typeof primary.providerSpecificData === "object"
      ? { ...primary.providerSpecificData }
      : {};
  const accountIds = getUniqueAccountIds(connections, dataKey);
  const accountProxies = mergeAccountProxies(connections);

  if (accountIds.length > 0) {
    base[dataKey] = accountIds;
  } else {
    delete base[dataKey];
  }

  if (accountProxies.length > 0) {
    base.accountProxies = accountProxies;
  } else {
    delete base.accountProxies;
  }

  return base;
}

function promptForAccountCount(providerName: string): number | null {
  const raw = window.prompt(`How many ${providerName} accounts do you want to create?`, "1");
  if (raw === null) return null;

  const value = raw.trim();
  if (!value) return 1;

  const count = Number.parseInt(value, 10);
  if (!Number.isInteger(count) || count < 1 || count > MAX_BULK_ACCOUNT_CREATE) {
    window.alert(`Enter a whole number between 1 and ${MAX_BULK_ACCOUNT_CREATE}.`);
    return null;
  }

  return count;
}

function generateUniqueAccountIds(
  count: number,
  generateAccountId: () => string,
  existingAccountIds: string[]
): string[] {
  const uniqueIds = new Set(existingAccountIds);
  const newAccountIds: string[] = [];

  while (newAccountIds.length < count) {
    const accountId = generateAccountId();
    if (!accountId || uniqueIds.has(accountId)) continue;
    uniqueIds.add(accountId);
    newAccountIds.push(accountId);
  }

  return newAccountIds;
}

async function deleteConnectionsInBatches(ids: string[]) {
  for (let index = 0; index < ids.length; index += MAX_BULK_CONNECTION_DELETE) {
    const chunk = ids.slice(index, index + MAX_BULK_CONNECTION_DELETE);
    const res = await fetch("/api/providers", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: chunk }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const errorMessage =
        typeof data?.error === "string"
          ? data.error
          : "Failed to remove duplicate provider connections";
      throw new Error(errorMessage);
    }
  }
}

export default function NoAuthAccountCard({
  providerId,
  providerName,
  generateAccountId,
  dataKey = "fingerprints",
  description = "Ready to use — no signup needed. Add accounts for rate-limit rotation.",
  addLabel = "Add Account",
  allowDeleteAll = false,
}: NoAuthAccountCardProps) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);
  const [proxyAccountId, setProxyAccountId] = useState<string | null>(null);
  const [proxyType, setProxyType] = useState("socks5");
  const [proxyHost, setProxyHost] = useState("");
  const [proxyPort, setProxyPort] = useState("1080");
  const [proxyUsername, setProxyUsername] = useState("");
  const [proxyPassword, setProxyPassword] = useState("");
  const [savingProxy, setSavingProxy] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const addRequestInFlightRef = useRef(false);
  const consolidationAttemptRef = useRef<string>("");

  const fetchConnections = useCallback(async () => {
    try {
      const res = await fetch("/api/providers");
      if (res.ok) {
        const data = await res.json();
        const filtered = (data.connections || []).filter(
          (c: Connection) => c.provider === providerId
        );
        setConnections(filtered);
      }
    } catch (err) {
      console.error("Failed to fetch connections:", err);
    } finally {
      setLoading(false);
    }
  }, [providerId]);

  useEffect(() => {
    void fetchConnections();
  }, [fetchConnections]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setProxyAccountId(null);
      }
    };
    if (proxyAccountId) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [proxyAccountId]);

  const conn = pickPrimaryConnection(connections, dataKey);
  const allAccountIds = getUniqueAccountIds(connections, dataKey);
  const accountProxies = mergeAccountProxies(connections);

  const consolidateLegacyConnections = useCallback(async () => {
    const primary = pickPrimaryConnection(connections, dataKey);
    if (!primary) return;

    const duplicateIds = connections
      .filter((candidate) => candidate.id !== primary.id)
      .map((c) => c.id);
    if (duplicateIds.length === 0) return;

    const mergedProviderSpecificData = buildMergedProviderSpecificData(
      connections,
      primary,
      dataKey
    );
    const updateRes = await fetch(`/api/providers/${primary.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerSpecificData: mergedProviderSpecificData,
      }),
    });
    if (!updateRes.ok) {
      throw new Error(`Failed to consolidate ${providerName} accounts`);
    }

    await deleteConnectionsInBatches(duplicateIds);

    await fetchConnections();
  }, [connections, dataKey, fetchConnections, providerName]);

  useEffect(() => {
    if (loading || connections.length <= 1) return;

    const signature = connections
      .map((connection) => connection.id)
      .sort()
      .join(",");
    if (consolidationAttemptRef.current === signature) return;
    consolidationAttemptRef.current = signature;

    void consolidateLegacyConnections().catch((error) => {
      console.error(`Failed to consolidate duplicate ${providerName} connections:`, error);
      consolidationAttemptRef.current = "";
    });
  }, [loading, connections, consolidateLegacyConnections, providerName]);

  const handleAddAccount = async () => {
    if (adding || deletingAll || addRequestInFlightRef.current) return;

    const accountCount = promptForAccountCount(providerName);
    if (accountCount === null) return;

    if (addRequestInFlightRef.current) return;
    addRequestInFlightRef.current = true;
    setAdding(true);
    try {
      const newAccountIds = generateUniqueAccountIds(
        accountCount,
        generateAccountId,
        allAccountIds
      );
      if (!conn) {
        const res = await fetch("/api/providers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: providerId,
            name: `${providerName} Account 1`,
            providerSpecificData: { [dataKey]: newAccountIds },
          }),
        });
        if (!res.ok) throw new Error("Failed to create connection");
      } else {
        const mergedProviderSpecificData = buildMergedProviderSpecificData(
          connections,
          conn,
          dataKey
        );
        const res = await fetch(`/api/providers/${conn.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            providerSpecificData: {
              ...mergedProviderSpecificData,
              [dataKey]: Array.from(new Set([...allAccountIds, ...newAccountIds])),
            },
          }),
        });
        if (!res.ok) throw new Error("Failed to update connection");
      }
      await fetchConnections();
    } catch (err) {
      console.error("Failed to add account:", err);
    } finally {
      addRequestInFlightRef.current = false;
      setAdding(false);
    }
  };

  const handleRemoveAccount = async (accountId: string) => {
    if (!conn) return;
    const updated = allAccountIds.filter((id) => id !== accountId);
    const updatedProxies = accountProxies.filter((p) => p.fingerprint !== accountId);
    const mergedProviderSpecificData = buildMergedProviderSpecificData(connections, conn, dataKey);
    try {
      const res = await fetch(`/api/providers/${conn.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerSpecificData: {
            ...mergedProviderSpecificData,
            [dataKey]: updated,
            accountProxies: updatedProxies,
          },
        }),
      });
      if (res.ok) await fetchConnections();
    } catch (err) {
      console.error("Failed to remove account:", err);
    }
  };

  const handleDeleteAllAccounts = async () => {
    if (!conn || allAccountIds.length === 0 || deletingAll) return;

    const confirmed = window.confirm(
      `Delete all ${allAccountIds.length} ${providerName} account(s)? This will also remove their saved proxy assignments.`
    );
    if (!confirmed) return;

    setDeletingAll(true);
    setProxyAccountId(null);

    try {
      const mergedProviderSpecificData = buildMergedProviderSpecificData(
        connections,
        conn,
        dataKey
      );
      const res = await fetch(`/api/providers/${conn.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerSpecificData: {
            ...mergedProviderSpecificData,
            [dataKey]: [],
            accountProxies: [],
          },
        }),
      });
      if (!res.ok) throw new Error("Failed to delete all accounts");

      await fetchConnections();
    } catch (err) {
      console.error("Failed to delete all accounts:", err);
    } finally {
      setDeletingAll(false);
    }
  };

  const openProxyConfig = (accountId: string) => {
    const existing = getProxyForFingerprint(accountProxies, accountId);
    if (existing) {
      setProxyType(existing.type);
      setProxyHost(existing.host);
      setProxyPort(String(existing.port));
      setProxyUsername(existing.username || "");
      setProxyPassword(existing.password || "");
    } else {
      setProxyType("socks5");
      setProxyHost("");
      setProxyPort("1080");
      setProxyUsername("");
      setProxyPassword("");
    }
    setProxyAccountId(accountId);
  };

  const handleSaveProxy = async () => {
    if (!conn || !proxyAccountId) return;
    setSavingProxy(true);
    try {
      const trimmedHost = proxyHost.trim();
      const newProxy: AccountProxyConfig["proxy"] = trimmedHost
        ? {
            type: proxyType,
            host: trimmedHost,
            port: Number(proxyPort) || 1080,
            ...(proxyUsername.trim() ? { username: proxyUsername.trim() } : {}),
            ...(proxyPassword.trim() ? { password: proxyPassword.trim() } : {}),
          }
        : null;

      const existing = accountProxies.filter((p) => p.fingerprint !== proxyAccountId);
      const updatedProxies = newProxy
        ? [...existing, { fingerprint: proxyAccountId, proxy: newProxy }]
        : existing;
      const mergedProviderSpecificData = buildMergedProviderSpecificData(
        connections,
        conn,
        dataKey
      );

      const res = await fetch(`/api/providers/${conn.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerSpecificData: {
            ...mergedProviderSpecificData,
            accountProxies: updatedProxies,
          },
        }),
      });
      if (res.ok) {
        await fetchConnections();
        setProxyAccountId(null);
      }
    } catch (err) {
      console.error("Failed to save proxy:", err);
    } finally {
      setSavingProxy(false);
    }
  };

  const handleDistributeProxies = async () => {
    if (!conn || allAccountIds.length === 0) return;
    const res = await fetch(`/api/providers/${conn.id}/account-proxies/distribute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataKey }),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => null);
      const message =
        payload && typeof payload.error === "string"
          ? payload.error
          : "Failed to distribute proxies";
      throw new Error(message);
    }

    await fetchConnections();
  };

  return (
    <Card>
      <div className="flex items-center gap-3 mb-3">
        <div className="inline-flex shrink-0 items-center justify-center w-10 h-10 rounded-full bg-green-500/10 text-green-500">
          <span className="material-symbols-outlined text-[20px]">lock_open</span>
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium">No authentication required</p>
          <p className="text-xs text-text-muted">{description}</p>
        </div>
      </div>

      <div className="border-t border-border pt-3 mt-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium">
            Accounts ({loading ? "..." : allAccountIds.length})
          </span>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {!loading && allAccountIds.length > 0 && (
              <DistributeProxiesButton
                onDistribute={handleDistributeProxies}
                disabled={adding || deletingAll}
                size="sm"
              />
            )}
            {allowDeleteAll && !loading && allAccountIds.length > 0 && (
              <Button
                size="sm"
                variant="danger"
                icon="delete_sweep"
                onClick={handleDeleteAllAccounts}
                disabled={adding || deletingAll}
              >
                {deletingAll ? "Deleting..." : "Delete All"}
              </Button>
            )}
            <Button
              size="sm"
              icon="add"
              onClick={handleAddAccount}
              disabled={adding || deletingAll}
            >
              {adding ? "Adding..." : addLabel}
            </Button>
          </div>
        </div>

        {!loading && allAccountIds.length === 0 && (
          <p className="text-xs text-text-muted py-2">
            Using auto-generated account. Click &quot;{addLabel}&quot; for rate-limit rotation.
          </p>
        )}

        {!loading && allAccountIds.length > 0 && (
          <div className="space-y-1 relative">
            {allAccountIds.map((id, i) => {
              const proxy = getProxyForFingerprint(accountProxies, id);
              return (
                <div key={id} className="relative">
                  <div className="group flex items-center justify-between p-3 rounded-lg hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-bg text-text-muted text-xs font-medium">
                        {i + 1}
                      </span>
                      <span className="font-mono text-xs text-text-muted truncate">
                        {id.slice(0, 12)}...
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => openProxyConfig(id)}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium transition-colors"
                        title={getProxyDisplayTitle(proxy)}
                      >
                        <span
                          className={`material-symbols-outlined text-[14px] ${proxy ? "text-blue-400" : "text-text-muted"}`}
                        >
                          {proxy ? "shield" : "shield"}
                        </span>
                        <span className={proxy ? "text-blue-400" : "text-text-muted"}>
                          {getProxyDisplayLabel(proxy)}
                        </span>
                      </button>
                      <button
                        onClick={() => handleRemoveAccount(id)}
                        className="p-1 hover:bg-red-500/10 rounded text-text-muted hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                      >
                        <span className="material-symbols-outlined text-[16px]">delete</span>
                      </button>
                    </div>
                  </div>

                  {proxyAccountId === id && (
                    <div
                      ref={popoverRef}
                      className="absolute right-0 top-full z-50 mt-1 w-80 rounded-lg border border-black/10 dark:border-white/10 bg-surface shadow-lg p-4"
                    >
                      <p className="text-sm font-medium mb-3">Proxy for Account {i + 1}</p>
                      <div className="space-y-3">
                        <div className="flex gap-2">
                          <select
                            value={proxyType}
                            onChange={(e) => setProxyType(e.target.value)}
                            className="rounded-md border border-black/10 dark:border-white/10 bg-bg px-2.5 py-1.5 text-xs flex-shrink-0"
                          >
                            {PROXY_TYPES.map((t) => (
                              <option key={t.value} value={t.value}>
                                {t.label}
                              </option>
                            ))}
                          </select>
                          <input
                            type="text"
                            value={proxyHost}
                            onChange={(e) => setProxyHost(e.target.value)}
                            placeholder="Host"
                            className="flex-1 rounded-md border border-black/10 dark:border-white/10 bg-bg px-2.5 py-1.5 text-xs"
                          />
                          <input
                            type="text"
                            value={proxyPort}
                            onChange={(e) => setProxyPort(e.target.value)}
                            placeholder="Port"
                            className="w-16 rounded-md border border-black/10 dark:border-white/10 bg-bg px-2.5 py-1.5 text-xs"
                          />
                        </div>
                        <input
                          type="text"
                          value={proxyUsername}
                          onChange={(e) => setProxyUsername(e.target.value)}
                          placeholder="Username (optional)"
                          className="w-full rounded-md border border-black/10 dark:border-white/10 bg-bg px-2.5 py-1.5 text-xs"
                        />
                        <input
                          type="password"
                          value={proxyPassword}
                          onChange={(e) => setProxyPassword(e.target.value)}
                          placeholder="Password (optional)"
                          className="w-full rounded-md border border-black/10 dark:border-white/10 bg-bg px-2.5 py-1.5 text-xs"
                        />
                        <div className="flex justify-end gap-2 pt-1">
                          <button
                            onClick={() => setProxyAccountId(null)}
                            className="rounded-md px-3 py-1.5 text-xs text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={handleSaveProxy}
                            disabled={savingProxy}
                            className="rounded-md bg-primary/10 px-3 py-1.5 text-xs text-primary hover:bg-primary/20 disabled:opacity-50 transition-colors"
                          >
                            {savingProxy ? "Saving..." : "Save"}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}
