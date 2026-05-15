import { z } from "zod";

export const oneproxyFilterSchema = z.object({
  protocol: z.enum(["http", "https", "socks4", "socks5"]).optional(),
  countryCode: z.string().max(2).optional(),
  minQuality: z.coerce.number().int().min(0).max(100).optional(),
  maxProxies: z.coerce.number().int().min(1).max(1000).optional(),
});

export const oneproxySyncSchema = z.object({}).strict();

export const oneproxyRotateSchema = z.object({
  strategy: z.enum(["random", "quality", "sequential"]).optional(),
  protocol: z.enum(["http", "https", "socks4", "socks5"]).optional(),
  countryCode: z.string().max(2).optional(),
  minQuality: z.coerce.number().int().min(0).max(100).optional(),
});

export const oneproxyValidateSchema = z
  .object({
    batchSize: z.coerce.number().int().min(1).max(200).optional(),
    timeoutMs: z.coerce.number().int().min(1000).max(30000).optional(),
    testUrl: z.string().url().max(500).optional(),
    revalidateOlderThanMinutes: z.coerce.number().int().min(5).max(43200).optional(),
    maxFailures: z.coerce.number().int().min(1).max(10).optional(),
  })
  .strict();
