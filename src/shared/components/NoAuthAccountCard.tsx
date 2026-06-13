"use client";

import { useState, useEffect, useCallback } from "react";
import Card from "./Card";
import Button from "./Button";

interface NoAuthAccountCardProps {
  providerId: string;
  /** Display name for the provider (e.g. "MiMoCode", "OpenCode") */
  providerName: string;
  /** Generates a unique account identifier (fingerprint, session token, etc.) */
  generateAccountId: () => string;
  /** Key in providerSpecificData where account IDs are stored (default: "fingerprints") */
  dataKey?: string;
  /** Custom description text */
  description?: string;
  /** Custom "add" button label */
  addLabel?: string;
  /** Notify parent views that derive their own connection state. */
  onConnectionsChanged?: () => void | Promise<void>;
}

interface Connection {
  id: string;
  provider: string;
  apiKey?: string;
  providerSpecificData?: Record<string, string[]>;
  isActive?: boolean;
  name?: string;
}

interface AccountEntry {
  accountId: string;
  connectionId: string;
  connectionAccountIds: string[];
}

export default function NoAuthAccountCard({
  providerId,
  providerName,
  generateAccountId,
  dataKey = "fingerprints",
  description = "Ready to use — no signup needed. Add accounts for rate-limit rotation.",
  addLabel = "Add Account",
  onConnectionsChanged,
}: NoAuthAccountCardProps) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

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

  const accountEntries: AccountEntry[] = connections.flatMap((connection) => {
    const ids = connection.providerSpecificData?.[dataKey] || [];
    return ids.map((accountId) => ({
      accountId,
      connectionId: connection.id,
      connectionAccountIds: ids,
    }));
  });
  const allAccountIds = accountEntries.map((entry) => entry.accountId);

  const handleAddAccount = async () => {
    setAdding(true);
    try {
      const accountId = generateAccountId();
      const res = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: providerId,
          name: `${providerName} Account ${accountId.slice(0, 8)}`,
          testStatus: "active",
          providerSpecificData: { [dataKey]: [accountId] },
        }),
      });
      if (!res.ok) throw new Error("Failed to create connection");
      await fetchConnections();
      await onConnectionsChanged?.();
    } catch (err) {
      console.error("Failed to add account:", err);
    } finally {
      setAdding(false);
    }
  };

  const handleRemoveAccount = async (entry: AccountEntry) => {
    const updated = entry.connectionAccountIds.filter((id) => id !== entry.accountId);
    try {
      const res =
        updated.length === 0
          ? await fetch(`/api/providers/${entry.connectionId}`, { method: "DELETE" })
          : await fetch(`/api/providers/${entry.connectionId}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                providerSpecificData: { [dataKey]: updated },
              }),
            });
      if (res.ok) {
        await fetchConnections();
        await onConnectionsChanged?.();
      }
    } catch (err) {
      console.error("Failed to remove account:", err);
    }
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
          <Button size="sm" icon="add" onClick={handleAddAccount} disabled={adding}>
            {adding ? "Adding..." : addLabel}
          </Button>
        </div>

        {!loading && allAccountIds.length === 0 && (
          <p className="text-xs text-text-muted py-2">
            Using auto-generated account. Click &quot;{addLabel}&quot; for rate-limit rotation.
          </p>
        )}

        {!loading && allAccountIds.length > 0 && (
          <div className="space-y-1">
            {accountEntries.map((entry, i) => (
              <div
                key={`${entry.connectionId}:${entry.accountId}`}
                className="flex items-center justify-between rounded-md bg-bg-secondary px-3 py-1.5 text-xs"
              >
                <span className="font-mono text-text-muted">
                  Account {i + 1}: {entry.accountId.slice(0, 12)}...
                </span>
                <button
                  onClick={() => handleRemoveAccount(entry)}
                  className="text-red-500 hover:text-red-400 text-xs"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
