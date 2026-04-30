const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

export function isApiKeyRevealEnabled(): boolean {
  const raw = String(process.env.ALLOW_API_KEY_REVEAL || "")
    .trim()
    .toLowerCase();
  return ENABLED_VALUES.has(raw);
}

export function maskStoredApiKey(key: unknown): string | null {
  if (typeof key !== "string") return null;
  return key.slice(0, 8) + "****" + key.slice(-4);
}

type ApiKeyLike = Record<string, unknown>;

function getKeyPrefix(record: ApiKeyLike, rawKey: string | null): string | null {
  const keyPrefix = record.keyPrefix ?? record.key_prefix;
  if (typeof keyPrefix === "string" && keyPrefix.trim().length > 0) return keyPrefix;
  return rawKey ? rawKey.slice(0, 12) : null;
}

function getKeyStatus(record: ApiKeyLike): "active" | "disabled" | "revoked" | "expired" {
  const revokedAt = record.revokedAt ?? record.revoked_at;
  if (typeof revokedAt === "string" && revokedAt.trim().length > 0) return "revoked";

  const expiresAt = record.expiresAt ?? record.expires_at;
  if (typeof expiresAt === "string" && expiresAt.trim().length > 0) {
    const expiresMs = Date.parse(expiresAt);
    if (Number.isFinite(expiresMs) && expiresMs <= Date.now()) return "expired";
  }

  if (
    record.isActive === false ||
    record.is_active === false ||
    record.isActive === 0 ||
    record.is_active === 0
  ) {
    return "disabled";
  }

  return "active";
}

export function toSafeApiKeyMetadata(
  record: ApiKeyLike,
  options: { includeRawKey?: boolean } = {}
): ApiKeyLike {
  const rawKey = typeof record.key === "string" ? record.key : null;
  const maskedKey = maskStoredApiKey(rawKey);
  const prefix = getKeyPrefix(record, rawKey);
  const status = getKeyStatus(record);

  return {
    ...record,
    key: options.includeRawKey ? rawKey : maskedKey,
    maskedKey,
    prefix,
    keyPrefix: prefix,
    isActive: status === "active",
    status,
  };
}
