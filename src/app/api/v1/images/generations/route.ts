import { handleImageGeneration } from "@omniroute/open-sse/handlers/imageGeneration.ts";
import { getProviderCredentials, clearRecoveredProviderState } from "@/sse/services/auth";
import {
  parseImageModel,
  getAllImageModels,
  getImageProvider,
  getImageModelEntry,
} from "@omniroute/open-sse/config/imageRegistry.ts";
import { errorResponse, unavailableResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import * as log from "@/sse/utils/logger";
import { toJsonErrorPayload } from "@/shared/utils/upstreamError";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { v1ImageGenerationSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { enforceClientApiAuth } from "../../_helpers/clientApiAuth";

import { getAllCustomModels, resolveProxyForConnection } from "@/lib/localDb";
import { resolveImageRouteModel } from "@/lib/images/imageRouteModel";
import { runWithProxyContext } from "@omniroute/open-sse/utils/proxyFetch.ts";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * GET /v1/images/generations — list available image models
 */
export async function GET() {
  const builtInModels = getAllImageModels();
  const timestamp = Math.floor(Date.now() / 1000);

  const data = builtInModels.map((m) => ({
    id: m.id,
    object: "model",
    created: timestamp,
    owned_by: m.provider,
    type: "image",
    supported_sizes: m.supportedSizes,
    input_modalities: m.inputModalities || ["text"],
    output_modalities: ["image"],
    ...(m.description ? { description: m.description } : {}),
  }));

  // Include custom models tagged for images
  try {
    const customModelsMap = (await getAllCustomModels()) as Record<string, any>;
    for (const [providerId, models] of Object.entries(customModelsMap)) {
      if (!Array.isArray(models)) continue;
      for (const model of models) {
        if (!model?.id || !Array.isArray(model.supportedEndpoints)) continue;
        if (!model.supportedEndpoints.includes("images")) continue;
        const fullId = `${providerId}/${model.id}`;
        if (data.some((d) => d.id === fullId)) continue;
        data.push({
          id: fullId,
          object: "model",
          created: timestamp,
          owned_by: providerId,
          type: "image",
          supported_sizes: null,
          input_modalities: ["text"],
          output_modalities: ["image"],
        });
      }
    }
  } catch {}

  return new Response(JSON.stringify({ object: "list", data }), {
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * POST /v1/images/generations — generate images
 */
function hasImageGenerationInput(body: Record<string, unknown>) {
  if (typeof body.image_url === "string" && body.image_url.trim()) return true;
  if (typeof body.image === "string" && body.image.trim()) return true;
  if (Array.isArray(body.imageUrls) && body.imageUrls.some((value) => typeof value === "string")) {
    return true;
  }
  if (
    Array.isArray(body.image_urls) &&
    body.image_urls.some((value) => typeof value === "string")
  ) {
    return true;
  }
  return false;
}

// Forward only the host-shaped headers the chatgpt-web image handler needs
// to derive the browser-facing public base URL. Avoid copying the full
// request header set: it's wider than the handler needs (auth tokens,
// content-type, etc.) and `Headers.forEach` collapses repeated values, which
// would silently drop entries if a wider helper were reused for headers
// that can legitimately repeat (e.g., set-cookie).
const PUBLIC_BASE_URL_HEADER_KEYS = ["host", "x-forwarded-host", "x-forwarded-proto"] as const;

function publicBaseUrlHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PUBLIC_BASE_URL_HEADER_KEYS) {
    const value = headers.get(key);
    if (value !== null) out[key] = value;
  }
  return out;
}

const MULTIPART_IMAGE_URL_FIELDS = ["image_url", "image_urls", "imageUrls"] as const;
const MULTIPART_IMAGE_FILE_FIELDS = ["image", "image[]"] as const;
const MULTIPART_IMAGE_FIELDS = new Set<string>([
  ...MULTIPART_IMAGE_URL_FIELDS,
  ...MULTIPART_IMAGE_FILE_FIELDS,
]);
const MULTIPART_NUMBER_FIELDS = new Set(["n", "timeout_ms", "poll_interval_ms"]);
const CHATGPT_WEB_IMAGE_MAX_ACCOUNT_ATTEMPTS = 5;
const CHATGPT_WEB_RETRYABLE_ACCOUNT_ERROR_CODES = new Set([
  "SENTINEL_BLOCKED",
  "HTTP_401",
  "HTTP_403",
  "HTTP_429",
]);

function isMultipartRequest(request: Request) {
  return (
    request.headers.get("content-type")?.toLowerCase().includes("multipart/form-data") === true
  );
}

function setMultipartField(body: Record<string, unknown>, key: string, value: string) {
  const trimmed = value.trim();
  if (!trimmed) return;

  let parsedValue: unknown = trimmed;
  if (MULTIPART_NUMBER_FIELDS.has(key)) {
    const numeric = Number(trimmed);
    parsedValue = Number.isFinite(numeric) ? numeric : trimmed;
  }

  const existing = body[key];
  if (existing === undefined) {
    body[key] = parsedValue;
  } else if (Array.isArray(existing)) {
    existing.push(parsedValue);
  } else {
    body[key] = [existing, parsedValue];
  }
}

async function fileToDataUrl(file: File): Promise<string> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const mime = file.type || "application/octet-stream";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

async function readMultipartImageGenerationBody(formData: FormData) {
  const body: Record<string, unknown> = {};
  const imageUrls: string[] = [];

  for (const [key, value] of formData.entries()) {
    if (MULTIPART_IMAGE_FIELDS.has(key) || typeof value !== "string") continue;
    setMultipartField(body, key, value);
  }

  for (const key of MULTIPART_IMAGE_URL_FIELDS) {
    for (const value of formData.getAll(key)) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (trimmed) imageUrls.push(trimmed);
    }
  }

  for (const key of MULTIPART_IMAGE_FILE_FIELDS) {
    for (const value of formData.getAll(key)) {
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed) imageUrls.push(trimmed);
        continue;
      }
      imageUrls.push(await fileToDataUrl(value));
    }
  }

  if (imageUrls.length > 0) {
    body.image_url = imageUrls[0];
    body.image_urls = imageUrls;
    body.imageUrls = imageUrls;
  }

  return body;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseErrorString(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getImageGenerationErrorCode(error: unknown): string | null {
  const parsed = typeof error === "string" ? parseErrorString(error) : error;
  const payload = toRecord(parsed);
  const nestedError = toRecord(payload?.error);
  const code = nestedError?.code ?? payload?.code;
  return typeof code === "string" && code.trim() ? code.trim() : null;
}

function getImageGenerationErrorMessage(error: unknown): string {
  const parsed = typeof error === "string" ? parseErrorString(error) : error;
  const payload = toRecord(parsed);
  const nestedError = toRecord(payload?.error);
  const message = nestedError?.message ?? payload?.message;
  if (typeof message === "string") return message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function shouldRetryImageGenerationWithNextAccount(
  result: { success?: unknown; status?: unknown; error?: unknown } | null | undefined,
  providerConfig: { format?: string } | null | undefined,
  credentials: { connectionId?: unknown } | null | undefined
): boolean {
  if (!result || result.success) return false;
  if (providerConfig?.format !== "chatgpt-web") return false;
  if (typeof credentials?.connectionId !== "string" || !credentials.connectionId) return false;

  const status = Number(result.status);
  const code = getImageGenerationErrorCode(result.error);
  if (code && CHATGPT_WEB_RETRYABLE_ACCOUNT_ERROR_CODES.has(code)) return true;
  if (status === HTTP_STATUS.UNAUTHORIZED || status === HTTP_STATUS.RATE_LIMITED) return true;

  const message = getImageGenerationErrorMessage(result.error);
  return status === HTTP_STATUS.FORBIDDEN && /\b(?:sentinel|turnstile)\b/i.test(message);
}

export async function POST(request: Request) {
  const authRejection = await enforceClientApiAuth(request);
  if (authRejection) return authRejection;

  let rawBody: Record<string, unknown>;
  if (isMultipartRequest(request)) {
    try {
      rawBody = await readMultipartImageGenerationBody(await request.formData());
    } catch (err) {
      log.warn(
        "IMAGE",
        `Invalid multipart body: ${err instanceof Error ? err.message : String(err)}`
      );
      return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid multipart body");
    }
  } else {
    try {
      rawBody = await request.json();
    } catch {
      log.warn("IMAGE", "Invalid JSON body");
      return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
    }
  }

  const validation = validateBody(v1ImageGenerationSchema, rawBody);
  if (isValidationFailure(validation)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, validation.error.message);
  }
  const body = validation.data;

  // Enforce API key policies (model restrictions + budget limits)
  const policy = await enforceApiKeyPolicy(request, body.model);
  if (policy.rejection) return policy.rejection;

  // #3205/#3215: resolve a combo/alias name (`image`) or a user-prefixed custom image
  // model (`myImg/gpt-image-2`) to its internal `<nodeId>/<model>` form so the
  // custom-model lookup and handler's resolvedProvider extraction resolve correctly.
  // Built-in and already-internal ids pass through unchanged. Shared with /images/edits.
  body.model = await resolveImageRouteModel(body.model);

  // Parse model to get provider
  let { provider } = parseImageModel(body.model);
  let isCustomModel = false;

  // If not in built-in registry, check custom models tagged for images
  if (!provider) {
    try {
      const customModelsMap = (await getAllCustomModels()) as Record<string, any>;
      for (const [providerId, models] of Object.entries(customModelsMap)) {
        if (!Array.isArray(models)) continue;
        for (const model of models) {
          if (!model?.id || !Array.isArray(model.supportedEndpoints)) continue;
          if (!model.supportedEndpoints.includes("images")) continue;
          const fullId = `${providerId}/${model.id}`;
          if (fullId === body.model) {
            provider = providerId;
            isCustomModel = true;
            break;
          }
        }
        if (provider) break;
      }
    } catch {}
  }

  if (!provider) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Invalid image model: ${body.model}. Use format: provider/model`
    );
  }

  // Check provider config for auth bypass
  const providerConfig = getImageProvider(provider);
  const imageModelEntry = getImageModelEntry(body.model);
  const inputModalities = imageModelEntry?.inputModalities || ["text"];
  const requiresPrompt = inputModalities.includes("text");
  const requiresImageInput = inputModalities.includes("image");
  const hasPrompt = typeof body.prompt === "string" && body.prompt.trim().length > 0;
  const hasImageInput = hasImageGenerationInput(body);

  if (requiresPrompt && !hasPrompt) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Prompt is required for image model: ${body.model}`
    );
  }

  if (requiresImageInput && !hasImageInput) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Image input is required for image model: ${body.model}`
    );
  }

  const needsCredentials = Boolean(
    (providerConfig && providerConfig.authType !== "none") || isCustomModel
  );
  const noCredentialsMessage = isCustomModel
    ? `No credentials for custom image provider: ${provider}`
    : `No credentials for image provider: ${provider}`;
  const maxAttempts =
    providerConfig?.format === "chatgpt-web" ? CHATGPT_WEB_IMAGE_MAX_ACCOUNT_ATTEMPTS : 1;
  const excludedConnectionIds: string[] = [];
  let excludedConnectionId: string | null = null;
  let credentials: any = null;
  let result: any = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (needsCredentials) {
      credentials = await getProviderCredentials(provider, excludedConnectionId, null, null, {
        excludeConnectionIds: excludedConnectionIds,
      });
      if (!credentials) {
        if (result) break;
        return errorResponse(HTTP_STATUS.BAD_REQUEST, noCredentialsMessage);
      }
      if (credentials.allRateLimited) {
        if (result) break;
        return unavailableResponse(
          HTTP_STATUS.RATE_LIMITED,
          `[${provider}] All accounts rate limited`,
          credentials.retryAfter,
          credentials.retryAfterHuman
        );
      }
    }

    // Resolve proxy for the selected connection on each attempt (#1904).
    let proxyInfo = null;
    if (credentials?.connectionId) {
      try {
        proxyInfo = await resolveProxyForConnection(credentials.connectionId);
      } catch {
        log.debug("PROXY", `Failed to resolve proxy for image provider: ${provider}`);
      }
    }

    const generateImage = () =>
      handleImageGeneration({
        body,
        credentials,
        log,
        apiKeyInfo: policy.apiKeyInfo,
        ...(isCustomModel && { resolvedProvider: provider }),
        signal: request.signal,
        clientHeaders: publicBaseUrlHeaders(request.headers),
      });

    // Execute with proxy context when available, direct otherwise (#1904)
    result = await (credentials?.connectionId
      ? runWithProxyContext(proxyInfo?.proxy || null, generateImage).catch((err: any) => ({
          success: false,
          status: err.statusCode || 500,
          error: err.message,
        }))
      : generateImage());

    if (
      attempt < maxAttempts &&
      !request.signal.aborted &&
      shouldRetryImageGenerationWithNextAccount(result, providerConfig, credentials)
    ) {
      const connectionId = credentials.connectionId;
      if (excludedConnectionIds.includes(connectionId)) break;
      excludedConnectionIds.push(connectionId);
      excludedConnectionId = connectionId;
      const code = getImageGenerationErrorCode(result.error) || `HTTP_${result.status}`;
      log.warn(
        "IMAGE",
        `ChatGPT Web image attempt ${attempt} failed with ${code} on ${connectionId.slice(
          0,
          8
        )}; retrying with another account`
      );
      continue;
    }

    break;
  }

  if (result.success) {
    await clearRecoveredProviderState(credentials);
    return new Response(JSON.stringify((result as any).data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const errorPayload = toJsonErrorPayload((result as any).error, "Image generation provider error");
  return new Response(JSON.stringify(errorPayload), {
    status: (result as any).status,
    headers: { "Content-Type": "application/json" },
  });
}
