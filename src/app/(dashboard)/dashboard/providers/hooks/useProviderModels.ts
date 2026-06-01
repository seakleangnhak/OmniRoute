"use client";

import { useState, useEffect } from "react";

export interface ProviderModel {
  id: string;
  /** Display-friendly id (unprefixed) */
  displayId?: string;
  object?: string;
  owned_by?: string;
}

interface UseProviderModelsResult {
  models: ProviderModel[];
  loading: boolean;
  error: string | null;
}

/**
 * useProviderModels — fetch models for a specific provider. When a connection id is
 * available, prefer the connection-backed discovery endpoint so self-hosted providers
 * can populate models from their configured /models endpoint.
 *
 * Falls back to an empty list on error so the playground is still usable.
 * The hook is stable for the lifetime of the component (only re-fetches if
 * `providerId` or `connectionId` changes).
 */
export function useProviderModels(
  providerId: string,
  connectionId?: string | null
): UseProviderModelsResult {
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!providerId) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const providerModelsUrl = `/api/v1/providers/${encodeURIComponent(providerId)}/models`;
        const urls = connectionId
          ? [
              `/api/providers/${encodeURIComponent(connectionId)}/models?refresh=true`,
              providerModelsUrl,
            ]
          : [providerModelsUrl];

        let lastError: string | null = null;
        for (const url of urls) {
          const res = await fetch(url);
          if (!res.ok) {
            const body = (await res.json().catch(() => null)) as {
              error?: string | { message?: string };
            } | null;
            const bodyError = body?.error;
            const msg =
              typeof bodyError === "string"
                ? bodyError
                : (bodyError?.message ?? `HTTP ${res.status}`);
            lastError = msg;
            continue;
          }

          const data = (await res.json()) as { data?: ProviderModel[]; models?: ProviderModel[] };
          const nextModels = data.data ?? data.models ?? [];
          if (cancelled) return;

          if (nextModels.length > 0 || url === providerModelsUrl) {
            setModels(nextModels);
            return;
          }
        }

        if (!cancelled && lastError) {
          setError(lastError);
        }

        if (!cancelled) {
          setModels([]);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load models");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [providerId, connectionId]);

  return { models, loading, error };
}
