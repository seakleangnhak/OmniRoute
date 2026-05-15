import {
  getOneproxyProxyForRotation,
  markOneproxyProxyFailed,
  recordOneproxyProxyRuntimeSuccess,
} from "./db/oneproxy";
import type { OneproxyProxyRecord } from "./db/oneproxy";

let sequentialIndex = 0;

export async function rotateOneproxyProxy(options?: {
  strategy?: "random" | "quality" | "sequential";
  protocol?: string;
  countryCode?: string;
  minQuality?: number;
  supportedProtocolsOnly?: boolean;
  excludeIds?: string[];
}): Promise<OneproxyProxyRecord | null> {
  const strategy = options?.strategy || "quality";
  return getOneproxyProxyForRotation({
    strategy,
    protocol: options?.protocol,
    countryCode: options?.countryCode,
    minQuality: options?.minQuality,
    supportedProtocolsOnly: options?.supportedProtocolsOnly,
    excludeIds: options?.excludeIds,
  });
}

export async function failOneproxyProxy(
  host: string,
  port: number,
  options: Parameters<typeof markOneproxyProxyFailed>[2] = {}
): Promise<boolean> {
  return markOneproxyProxyFailed(host, port, options);
}

export async function succeedOneproxyProxy(
  host: string,
  port: number,
  result: Parameters<typeof recordOneproxyProxyRuntimeSuccess>[2] = {}
): Promise<boolean> {
  return recordOneproxyProxyRuntimeSuccess(host, port, result);
}

export function resetSequentialIndex(): void {
  sequentialIndex = 0;
}
