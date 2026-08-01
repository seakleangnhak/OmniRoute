import {
  handleAdobeFireflyImageGeneration,
  handleCodexImageEdit,
  handleImageEdit,
  handleOpenAIImageEdit,
} from "@omniroute/open-sse/handlers/imageGeneration.ts";
import { createInjectionGuard } from "@/middleware/promptInjectionGuard";
import {
  getProviderCredentialsWithQuotaPreflight,
  clearRecoveredProviderState,
} from "@/sse/services/auth";
import {
  parseImageModel,
  getImageProvider,
  getImageModelEntry,
} from "@omniroute/open-sse/config/imageRegistry.ts";
import { errorResponse, unavailableResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import * as log from "@/sse/utils/logger";
import { toJsonErrorPayload } from "@/shared/utils/upstreamError";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { enforceClientApiAuth } from "../../_helpers/clientApiAuth";
import {
  resolveImageRouteModel,
  extractImageEditInputFromJson,
  validateCodexImageEditReferences,
} from "@/lib/images/imageRouteModel";
import { resolveProxyForConnection } from "@/lib/localDb";
import { runWithProxyContext } from "@omniroute/open-sse/utils/proxyFetch.ts";
import { isCodexFreePlan } from "@omniroute/open-sse/executors/codex/tools.ts";
import {
  getBodySizeLimit,
  readRequestBodyWithLimit,
  RequestBodyTooLargeError,
} from "@/shared/middleware/bodySizeGuard";
import { getCachedSettings } from "@/lib/db/readCache";
import { z } from "zod";

// JSON edit body (Open WebUI / OpenAI-style). All fields optional — the prompt
// and resolvable image are enforced after extraction in POST — but the top-level
// shape must be an object with correctly-typed fields, so a malformed body
// (array, string, wrong types) is rejected with 400 instead of silently parsed.
const ImageEditJsonSchema = z
  .object({
    prompt: z.string().optional(),
    model: z.string().optional(),
    size: z.string().optional(),
    response_format: z.string().optional(),
    responseFormat: z.string().optional(),
    cache_id: z.string().optional(),
    image_cache_id: z.string().optional(),
    imageCacheId: z.string().optional(),
    image_url: z.string().optional(),
    url: z.string().optional(),
    b64_json: z.string().optional(),
    mime_type: z.string().optional(),
    image_mime_type: z.string().optional(),
    image: z.unknown().optional(),
    images: z.array(z.unknown()).optional(),
  })
  .passthrough();

/**
 * /v1/images/edits — OpenAI-compatible image-edit endpoint.
 *
 * Two upstream shapes are supported:
 *  - **chatgpt-web**: an "edit" only makes sense if the uploaded image was originally
 *    generated through OmniRoute — we then have its `{conversationId, parentMessageId}`
 *    cached and can continue the saved chatgpt.com conversation node (the only way to
 *    actually edit the image instead of generating an unrelated one).
 *  - **custom OpenAI-compatible providers** (#3214/#3215): forward a multipart edit to
 *    the node's `{base_url}/images/edits`, mirroring how generations forwards.
 *
 * Input is accepted as multipart/form-data (Open WebUI's "Image Edit" toggle) or as JSON
 * with data-URL images (`images: [{ image_url: "data:..." }]`), since some OpenAI-compatible
 * clients send the latter. The model may be a built-in id, a `provider/model`, a custom
 * provider prefix, or a combo/alias name — all resolved the same as generations.
 *
 * Without this route, multipart bodies trip Next.js's Server Action handler (which
 * intercepts ALL multipart POSTs) and the client gets a confusing 500.
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

interface EditInput {
  prompt: string;
  model: string | null;
  size: string | null;
  responseFormat: string | null;
  imageCacheId: string | null;
  imageBytes: Buffer | null;
  imageMime: string | null;
  rawBody?: Record<string, unknown>;
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

const MAX_NON_CODEX_IMAGE_EDIT_REFERENCES = 1;

async function readMultipartImage(formData: FormData): Promise<EditInput> {
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

/** Read the edit input from either multipart/form-data or a JSON/data-URL body. */
async function readEditInput(request: Request): Promise<EditInput | null> {
  const contentType = request.headers.get("content-type") || "";
  let bodySizeSettings: Record<string, unknown> | undefined;
  try {
    bodySizeSettings = await getCachedSettings();
  } catch {
    bodySizeSettings = undefined;
  }
  const bodySizeLimit = getBodySizeLimit("/api/v1/images/edits", bodySizeSettings);
  const rawBody = await readRequestBodyWithLimit(request, bodySizeLimit);
  if (contentType.includes("multipart/form-data")) {
    try {
      const formData = await new Response(rawBody, {
        headers: { "content-type": contentType },
      }).formData();
      return await readMultipartImage(formData);
    } catch (err) {
      log.warn("IMAGE", `Invalid multipart body: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }
  if (contentType.includes("application/json")) {
    try {
      const parsed = ImageEditJsonSchema.safeParse(
        JSON.parse(new TextDecoder().decode(rawBody)) as unknown
      );
      if (!parsed.success) {
        log.warn("IMAGE", `Invalid JSON edit body shape: ${parsed.error.message}`);
        return null;
      }
      const extracted = extractImageEditInputFromJson(parsed.data);
      const rawBody = parsed.data as Record<string, unknown>;
      return {
        ...extracted,
        imageCacheId: pickCacheId(rawBody),
        rawBody,
      };
    } catch (err) {
      log.warn("IMAGE", `Invalid JSON edit body: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }
  return null;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function postHandler(request: Request) {
  const authRejection = await enforceClientApiAuth(request);
  if (authRejection) return authRejection;
  const input = await readEditInput(request);
  if (!input) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      "Invalid request body. Send multipart/form-data or JSON with a data-URL image."
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

  const fullModel = model || "cgpt-web/gpt-5.5";

  const policy = await enforceApiKeyPolicy(request, fullModel);
  if (policy.rejection) return policy.rejection;

  const allowedConnections =
    policy.apiKeyInfo?.allowedConnections && policy.apiKeyInfo.allowedConnections.length > 0
      ? policy.apiKeyInfo.allowedConnections
      : null;

  // Resolve combo/alias, custom-provider prefix, and built-in ids consistently with
  // /v1/images/generations (#3215).
  const resolvedModel = await resolveImageRouteModel(fullModel);
  const parsed = parseImageModel(resolvedModel);
  const providerConfig = parsed.provider ? getImageProvider(parsed.provider) : null;
  // Firefly nano/gpt-image accept multiple reference blobs; other non-Codex stay at 1.
  const maxRefsForProvider =
    providerConfig?.format === "adobe-firefly-image"
      ? 4
      : providerConfig?.format === "codex-responses"
        ? Number.POSITIVE_INFINITY
        : MAX_NON_CODEX_IMAGE_EDIT_REFERENCES;
  if (
    providerConfig?.format !== "codex-responses" &&
    imageInputCount > maxRefsForProvider
  ) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      providerConfig?.format === "adobe-firefly-image"
        ? "Adobe Firefly image edit supports at most 4 reference images"
        : "This image edit provider currently supports only one reference image"
    );
  }
  // chatgpt-web keeps its conversation-continuation edit flow unchanged.
  if (providerConfig?.format === "chatgpt-web") {
    const credentials = await getProviderCredentialsWithQuotaPreflight(
      parsed.provider,
      null,
      allowedConnections,
      resolvedModel
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
      return jsonResponse((result as any).data);
    }
    return jsonResponse(
      toJsonErrorPayload((result as any).error, "Image edit provider error"),
      (result as any).status
    );
  }

  // Built-in Codex uses its native Responses hosted tool for stateless reference-image edits.
  if (providerConfig?.format === "codex-responses") {
    const modelEntry = getImageModelEntry(resolvedModel);
    if (!modelEntry || modelEntry.provider !== "codex" || modelEntry.model !== parsed.model) {
      return errorResponse(
        HTTP_STATUS.BAD_REQUEST,
        `Unsupported Codex image edit model: ${resolvedModel}`
      );
    }
    const imageValidationError = validateCodexImageEditReferences(images);
    if (imageValidationError) {
      return errorResponse(HTTP_STATUS.BAD_REQUEST, imageValidationError);
    }

    const credentials = await getProviderCredentialsWithQuotaPreflight(
      parsed.provider,
      null,
      allowedConnections,
      resolvedModel
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
    const credentialDetails = credentials as {
      connectionId?: unknown;
      providerSpecificData?: unknown;
    };
    if (isCodexFreePlan(credentialDetails.providerSpecificData)) {
      return errorResponse(
        HTTP_STATUS.BAD_REQUEST,
        "Codex image editing requires a paid ChatGPT/Codex plan"
      );
    }

    const connectionId =
      typeof credentialDetails.connectionId === "string" ? credentialDetails.connectionId : null;
    let proxyInfo = null;
    if (connectionId) {
      try {
        proxyInfo = await resolveProxyForConnection(connectionId);
      } catch {
        log.debug("PROXY", `Failed to resolve proxy for image provider: ${parsed.provider}`);
      }
    }

    const editImage = () =>
      handleCodexImageEdit({
        provider: parsed.provider,
        model: parsed.model,
        providerConfig,
        body: {
          prompt,
          size: size ?? undefined,
          response_format: responseFormat ?? undefined,
        },
        referenceImages: images,
        credentials,
        log,
        signal: request.signal,
      });

    const result = await (connectionId
      ? runWithProxyContext(proxyInfo?.proxy || null, editImage).catch(() => ({
          success: false as const,
          status: HTTP_STATUS.SERVICE_UNAVAILABLE,
          error: "Image edit proxy error",
        }))
      : editImage());

    if (result.success === true) {
      await clearRecoveredProviderState(credentials);
      return jsonResponse(result.data);
    }
    return jsonResponse(
      toJsonErrorPayload(result.error, "Image edit provider error"),
      result.status
    );
  }

  // Adobe Firefly: edit = storage upload + generate-async referenceBlobs (same as i2i generate).
  if (providerConfig?.format === "adobe-firefly-image") {
    return handleAdobeFireflyEditRequest({
      parsed,
      providerConfig,
      allowedConnections,
      resolvedModel,
      prompt,
      size,
      responseFormat,
      images,
      imageBytes,
      imageMime,
    });
  }

  // Other built-in providers do not expose an OpenAI-compatible edit endpoint.
  if (providerConfig) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Image edit is not supported for built-in provider "${parsed.provider}". ` +
        `Use adobe-firefly, chatgpt-web, codex, or a custom OpenAI-compatible image provider.`
    );
  }

  // Custom OpenAI-compatible node (no built-in config): forward to {base_url}/images/edits.
  const slash = resolvedModel.indexOf("/");
  const customProviderId = slash > 0 ? resolvedModel.slice(0, slash) : null;
  const customModel = slash > 0 ? resolvedModel.slice(slash + 1) : null;
  if (!customProviderId || !customModel) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Unknown image provider for model "${fullModel}". Use provider/model, a custom ` +
        `provider prefix, or a combo/alias name.`
    );
  }

  const credentials = await getProviderCredentialsWithQuotaPreflight(
    customProviderId,
    null,
    allowedConnections,
    resolvedModel
  );
  if (!credentials) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `No credentials for custom image provider: ${customProviderId}`
    );
  }
  if (credentials.allRateLimited) {
    return unavailableResponse(
      HTTP_STATUS.RATE_LIMITED,
      `[${customProviderId}] All accounts rate limited`,
      credentials.retryAfter,
      credentials.retryAfterHuman
    );
  }

  if (!imageBytes || imageBytes.length === 0) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      "Custom OpenAI-compatible image edits require an image payload"
    );
  }

  const result = await handleOpenAIImageEdit({
    provider: customProviderId,
    model: customModel,
    credentials,
    prompt,
    imageBytes,
    imageMime,
    size,
    responseFormat,
    n: 1,
    log,
    apiKeyInfo: policy.apiKeyInfo,
  });

  if (result.success) {
    await clearRecoveredProviderState(credentials);
    return jsonResponse((result as any).data);
  }
  return jsonResponse(
    toJsonErrorPayload((result as any).error, "Image edit provider error"),
    (result as any).status
  );
}

export const POST = postHandler;
