import { handleImageEdit } from "@omniroute/open-sse/handlers/imageGeneration.ts";
import { getProviderCredentials, clearRecoveredProviderState } from "@/sse/services/auth";
import { parseImageModel, getImageProvider } from "@omniroute/open-sse/config/imageRegistry.ts";
import { errorResponse, unavailableResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import * as log from "@/sse/utils/logger";
import { toJsonErrorPayload } from "@/shared/utils/upstreamError";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { enforceClientApiAuth } from "../../_helpers/clientApiAuth";

/**
 * /v1/images/edits — image edit endpoint matching OpenAI's images-edit API.
 *
 * Open WebUI's "Image Edit" toggle (images.edit.engine = "openai") posts multipart
 * with `prompt` + `image` (file). OmniRoute-native clients may also post JSON
 * with `prompt` + `cache_id`. For chatgpt-web, an "edit" only makes sense
 * if the uploaded image was originally generated through OmniRoute — we then
 * have its `{conversationId, parentMessageId}` cached and can continue the
 * saved chatgpt.com conversation node, which is the only way to actually edit
 * the image instead of generating an unrelated one from scratch.
 *
 * Without this route, multipart bodies trip Next.js's Server Action handler
 * (which intercepts ALL POSTs with multipart/form-data content-type) and the
 * client gets a confusing "Failed to find Server Action" 500.
 */

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

const PUBLIC_BASE_URL_HEADER_KEYS = ["host", "x-forwarded-host", "x-forwarded-proto"] as const;

function publicBaseUrlHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PUBLIC_BASE_URL_HEADER_KEYS) {
    const value = headers.get(key);
    if (value !== null) out[key] = value;
  }
  return out;
}

interface ImageEditInput {
  prompt: string;
  model: string | null;
  size: string | null;
  responseFormat: string | null;
  imageCacheId: string | null;
  imageBytes: Buffer | null;
  imageMime: string | null;
  rawBody?: Record<string, unknown>;
}

function isMultipartRequest(request: Request) {
  return (
    request.headers.get("content-type")?.toLowerCase().includes("multipart/form-data") === true
  );
}

function pickString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function pickCacheId(body: Record<string, unknown>): string | null {
  return (
    pickString(body.cache_id) ||
    pickString(body.image_cache_id) ||
    pickString(body.imageCacheId) ||
    pickString(body.image_url) ||
    pickString(body.url)
  );
}

function parseDataUrlImage(value: string): { bytes: Buffer; mime: string } | null {
  const match = value.match(/^data:([^;,]+);base64,(.+)$/i);
  if (!match) return null;
  const bytes = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  if (bytes.length === 0) return null;
  return { bytes, mime: match[1] || "image/png" };
}

function parseJsonImageBytes(body: Record<string, unknown>): {
  imageBytes: Buffer | null;
  imageMime: string | null;
} {
  const image = pickString(body.image);
  if (image) {
    const dataUrl = parseDataUrlImage(image);
    if (dataUrl) return { imageBytes: dataUrl.bytes, imageMime: dataUrl.mime };
  }

  const b64 = pickString(body.b64_json);
  if (!b64) return { imageBytes: null, imageMime: null };
  const bytes = Buffer.from(b64.replace(/\s+/g, ""), "base64");
  if (bytes.length === 0) return { imageBytes: null, imageMime: null };
  const mime = pickString(body.mime_type) || pickString(body.image_mime_type) || "image/png";
  return { imageBytes: bytes, imageMime: mime };
}

async function readMultipartImage(formData: FormData): Promise<ImageEditInput> {
  const promptRaw = formData.get("prompt");
  const prompt = typeof promptRaw === "string" ? promptRaw.trim() : "";
  const modelRaw = formData.get("model");
  const model = typeof modelRaw === "string" ? modelRaw.trim() : null;
  const sizeRaw = formData.get("size");
  const size = typeof sizeRaw === "string" ? sizeRaw.trim() : null;
  const respRaw = formData.get("response_format");
  const responseFormat = typeof respRaw === "string" ? respRaw.trim() : null;
  const cacheIdRaw =
    formData.get("cache_id") ?? formData.get("image_cache_id") ?? formData.get("imageCacheId");
  const imageCacheId = typeof cacheIdRaw === "string" ? cacheIdRaw.trim() : null;

  // OpenAI's API and Open WebUI both accept either a single `image` field or
  // an `image[]` array. We use the first image when multiple are sent — the
  // chatgpt-web edit tool can only edit one image per conversation node.
  const imageEntry = formData.get("image") ?? formData.get("image[]");
  if (!imageEntry || typeof imageEntry === "string") {
    return { prompt, model, size, responseFormat, imageCacheId, imageBytes: null, imageMime: null };
  }
  const file = imageEntry as File;
  const imageBytes = Buffer.from(await file.arrayBuffer());
  const imageMime = file.type || "image/png";
  return { prompt, model, size, responseFormat, imageCacheId, imageBytes, imageMime };
}

async function readJsonImage(request: Request): Promise<ImageEditInput> {
  const parsed = await request.json();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON body must be an object");
  }
  const rawBody = parsed as Record<string, unknown>;
  const prompt = pickString(rawBody.prompt) || "";
  const model = pickString(rawBody.model);
  const size = pickString(rawBody.size);
  const responseFormat = pickString(rawBody.response_format) || pickString(rawBody.responseFormat);
  const imageCacheId = pickCacheId(rawBody);
  const { imageBytes, imageMime } = parseJsonImageBytes(rawBody);
  return {
    prompt,
    model,
    size,
    responseFormat,
    imageCacheId,
    imageBytes,
    imageMime,
    rawBody,
  };
}

async function readImageEditInput(request: Request): Promise<ImageEditInput> {
  if (isMultipartRequest(request)) {
    try {
      return await readMultipartImage(await request.formData());
    } catch (err) {
      log.warn(
        "IMAGE",
        `Invalid multipart body: ${err instanceof Error ? err.message : String(err)}`
      );
      throw new Error("Invalid multipart body");
    }
  }

  try {
    return await readJsonImage(request);
  } catch (err) {
    log.warn("IMAGE", `Invalid JSON body: ${err instanceof Error ? err.message : String(err)}`);
    throw new Error("Invalid JSON body");
  }
}

export async function POST(request: Request) {
  const authRejection = await enforceClientApiAuth(request);
  if (authRejection) return authRejection;

  let input: ImageEditInput;
  try {
    input = await readImageEditInput(request);
  } catch (err) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      err instanceof Error ? err.message : "Invalid image edit body"
    );
  }

  const { prompt, model, size, responseFormat, imageCacheId, imageBytes, imageMime, rawBody } =
    input;

  if (!prompt) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: prompt");
  }
  if ((!imageBytes || imageBytes.length === 0) && !imageCacheId) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: image or cache_id");
  }

  const fullModel = model || "cgpt-web/gpt-5.3-instant";

  const policy = await enforceApiKeyPolicy(request, fullModel);
  if (policy.rejection) return policy.rejection;

  const parsed = parseImageModel(fullModel);
  const providerConfig = getImageProvider(parsed.provider);
  if (!providerConfig) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Unknown image provider: ${parsed.provider}`);
  }
  if (providerConfig.format !== "chatgpt-web") {
    // We only implement edit for chatgpt-web today; everything else routes
    // through generations which doesn't accept image inputs. Surface a
    // useful error rather than silently dropping the image.
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Image edit is only supported for chatgpt-web models (got ${parsed.provider})`
    );
  }

  const allowedConnections =
    policy.apiKeyInfo?.allowedConnections && policy.apiKeyInfo.allowedConnections.length > 0
      ? policy.apiKeyInfo.allowedConnections
      : null;
  const credentials = await getProviderCredentials(
    parsed.provider,
    null,
    allowedConnections,
    fullModel
  );
  if (!credentials) {
    return errorResponse(
      HTTP_STATUS.UNAUTHORIZED,
      `No credentials for provider: ${parsed.provider}`
    );
  }
  if (credentials.allRateLimited) {
    return unavailableResponse(
      HTTP_STATUS.RATE_LIMITED,
      `[${parsed.provider}] All accounts rate limited`,
      credentials.retryAfter,
      credentials.retryAfterHuman
    );
  }

  const result = await handleImageEdit({
    provider: parsed.provider,
    model: parsed.model,
    body: {
      ...(rawBody ?? {}),
      prompt,
      size: size ?? undefined,
      response_format: responseFormat ?? undefined,
      cache_id: imageCacheId ?? undefined,
      n: 1,
    },
    imageBytes,
    imageMime,
    credentials,
    apiKeyInfo: policy.apiKeyInfo,
    log,
    signal: request.signal,
    clientHeaders: publicBaseUrlHeaders(request.headers),
  });

  if (result.success) {
    await clearRecoveredProviderState(credentials);
    return new Response(JSON.stringify((result as any).data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const errorPayload = toJsonErrorPayload((result as any).error, "Image edit provider error");
  return new Response(JSON.stringify(errorPayload), {
    status: (result as any).status,
    headers: { "Content-Type": "application/json" },
  });
}
