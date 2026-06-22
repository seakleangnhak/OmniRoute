import { NextResponse } from "next/server";
import { getProviderConnectionById, updateProviderConnection } from "@/models";
import { listProxies } from "@/lib/localDb";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function getAccountIds(providerSpecificData: unknown, dataKey: string): string[] {
  const raw = asRecord(providerSpecificData)[dataKey];
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(
      raw.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    )
  );
}

function extractRelayAuth(notes: unknown): string | undefined {
  if (typeof notes !== "string" || notes.trim().length === 0) return undefined;
  try {
    const parsed = JSON.parse(notes) as { relayAuth?: unknown };
    return typeof parsed.relayAuth === "string" && parsed.relayAuth.trim().length > 0
      ? parsed.relayAuth
      : undefined;
  } catch {
    return undefined;
  }
}

function toDistributedProxyConfig(proxy: Record<string, unknown>) {
  const base = {
    type: typeof proxy.type === "string" ? proxy.type : "http",
    host: typeof proxy.host === "string" ? proxy.host : "",
    port: typeof proxy.port === "number" ? proxy.port : Number(proxy.port) || 0,
  } as Record<string, unknown>;

  if (typeof proxy.id === "string" && proxy.id.length > 0) {
    base.proxyId = proxy.id;
  }
  if (typeof proxy.name === "string" && proxy.name.length > 0) {
    base.proxyName = proxy.name;
  }

  if (typeof proxy.username === "string" && proxy.username.length > 0) {
    base.username = proxy.username;
  }
  if (typeof proxy.password === "string" && proxy.password.length > 0) {
    base.password = proxy.password;
  }
  if (typeof proxy.family === "string" && proxy.family.length > 0) {
    base.family = proxy.family;
  }

  const relayAuth = extractRelayAuth(proxy.notes);
  if (relayAuth) {
    base.relayAuth = relayAuth;
  }

  return base;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let body: { dataKey?: string } = {};
  try {
    body = (await request.json()) as { dataKey?: string };
  } catch {
    // Optional body — default to fingerprints when omitted/empty.
  }

  try {
    const { id } = await params;
    const connection = (await getProviderConnectionById(id)) as Record<string, unknown> | null;
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const dataKey =
      typeof body.dataKey === "string" && body.dataKey.trim().length > 0
        ? body.dataKey.trim()
        : "fingerprints";
    const providerSpecificData = asRecord(connection.providerSpecificData);
    const accountIds = getAccountIds(providerSpecificData, dataKey);
    if (accountIds.length === 0) {
      return NextResponse.json({ error: "No account fingerprints found" }, { status: 400 });
    }

    const proxies = (await listProxies({ includeSecrets: true })) as Array<Record<string, unknown>>;
    const activeProxies = proxies.filter((proxy) => proxy.status === "active");
    if (activeProxies.length === 0) {
      return NextResponse.json({ error: "No active proxies found" }, { status: 400 });
    }

    const accountProxies = accountIds.map((fingerprint, index) => ({
      fingerprint,
      proxy: toDistributedProxyConfig(activeProxies[index % activeProxies.length]),
    }));

    const updated = await updateProviderConnection(id, {
      providerSpecificData: {
        ...providerSpecificData,
        [dataKey]: accountIds,
        accountProxies,
      },
    });

    return NextResponse.json({
      success: true,
      distributed: accountProxies.length,
      connection: {
        id,
        providerSpecificData:
          (updated as Record<string, unknown> | null)?.providerSpecificData ?? {},
      },
    });
  } catch (error) {
    console.error("Error distributing account proxies:", error);
    return NextResponse.json({ error: "Failed to distribute account proxies" }, { status: 500 });
  }
}
