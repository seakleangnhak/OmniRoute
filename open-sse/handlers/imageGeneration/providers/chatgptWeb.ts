// Auto-extracted from open-sse/handlers/imageGeneration.ts in PR-#4582-batch
// Family: chatgpt-web | Module: chatgptWeb | Lines: 1102-1282 (181 LOC)
// Ref: see open-sse/handlers/imageGeneration.ts top-of-file comment for split rationale

import { ChatGptWebExecutor } from "../../../executors/chatgpt-web.ts";
import { getChatGptImage } from "../../../services/chatgptImageCache.ts";
import {
  saveImageErrorResult,
  saveImageSuccessResult,
  extractImageInputs,
} from "../../imageGeneration.ts";

export const CHATGPT_WEB_IMAGE_MARKDOWN_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g;
export const CHATGPT_WEB_IMAGE_ID_RE =
  /\/v1\/chatgpt-web\/image\/([a-f0-9]{16,64})(?=[?\s"'<>)]|$)/i;

const CHATGPT_WEB_CACHE_ID_RE = /^[a-f0-9]{16,64}$/i;

function extractChatGptWebCacheId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const urlMatch = trimmed.match(CHATGPT_WEB_IMAGE_ID_RE)?.[1];
  if (urlMatch) return urlMatch.toLowerCase();
  if (CHATGPT_WEB_CACHE_ID_RE.test(trimmed)) return trimmed.toLowerCase();
  return null;
}

export function getChatGptWebEditCacheId(body: Record<string, unknown>): string | null {
  return (
    extractChatGptWebCacheId(body.cache_id) ||
    extractChatGptWebCacheId(body.image_cache_id) ||
    extractChatGptWebCacheId(body.imageCacheId) ||
    extractChatGptWebCacheId(body.image_url) ||
    extractChatGptWebCacheId(body.url)
  );
}

export type ChatGptWebImageResult = {
  url?: string;
  b64_json?: string;
  cache_id?: string;
  cache_expires_at?: number;
  cache_ttl_seconds?: number;
};

export function withChatGptWebCacheMetadata<T extends { url?: string; b64_json?: string }>(
  image: T,
  source: unknown
): T & ChatGptWebImageResult {
  const cacheId = extractChatGptWebCacheId(source);
  if (!cacheId) return image;
  const cached = getChatGptImage(cacheId);
  if (!cached) return { ...image, cache_id: cacheId };
  return {
    ...image,
    cache_id: cacheId,
    cache_expires_at: cached.expiresAt,
    cache_ttl_seconds: Math.max(0, Math.floor((cached.expiresAt - Date.now()) / 1000)),
  };
}

const CHATGPT_WEB_NATIVE_LAYOUTS = [
  { aspectRatio: "1:1", size: "1024x1024", label: "square", ratio: 1 },
  { aspectRatio: "3:4", size: "1024x1365", label: "portrait", ratio: 3 / 4 },
  { aspectRatio: "9:16", size: "1024x1792", label: "story", ratio: 9 / 16 },
  { aspectRatio: "4:3", size: "1365x1024", label: "landscape", ratio: 4 / 3 },
  { aspectRatio: "16:9", size: "1792x1024", label: "widescreen", ratio: 16 / 9 },
] as const;

const CHATGPT_WEB_LAYOUT_ALIASES = new Map([
  ["square", "1:1"],
  ["squared", "1:1"],
  ["1:1", "1:1"],
  ["1024x1024", "1:1"],
  ["portrait", "3:4"],
  ["vertical", "3:4"],
  ["tall", "3:4"],
  ["3:4", "3:4"],
  ["2:3", "3:4"],
  ["1024x1365", "3:4"],
  ["1024x1366", "3:4"],
  ["1024x1536", "3:4"],
  ["story", "9:16"],
  ["phone", "9:16"],
  ["9:16", "9:16"],
  ["1024x1792", "9:16"],
  ["landscape", "4:3"],
  ["horizontal", "4:3"],
  ["4:3", "4:3"],
  ["3:2", "4:3"],
  ["1365x1024", "4:3"],
  ["1366x1024", "4:3"],
  ["1536x1024", "4:3"],
  ["wide", "16:9"],
  ["widescreen", "16:9"],
  ["16:9", "16:9"],
  ["1792x1024", "16:9"],
]);

function getChatGptWebRequestedAspectRatio(body) {
  return typeof body.aspect_ratio === "string"
    ? body.aspect_ratio
    : typeof body.aspectRatio === "string"
      ? body.aspectRatio
      : null;
}

function isChatGptWebAutoLayout(value: unknown) {
  return typeof value === "string" && ["auto", "default"].includes(value.trim().toLowerCase());
}

function getChatGptWebImageLayout(body) {
  const requestedAspectRatio = getChatGptWebRequestedAspectRatio(body);
  if (isChatGptWebAutoLayout(requestedAspectRatio)) return null;
  const value = requestedAspectRatio || body.size;
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase().replace(/\s+/g, "-");
  const alias = CHATGPT_WEB_LAYOUT_ALIASES.get(key);
  if (alias)
    return CHATGPT_WEB_NATIVE_LAYOUTS.find((layout) => layout.aspectRatio === alias) || null;
  const dimensions = key.match(/^(\d+)[x:](\d+)$/);
  if (!dimensions) return null;
  const width = Number(dimensions[1]);
  const height = Number(dimensions[2]);
  if (width <= 0 || height <= 0) return null;
  const ratio = width / height;
  return CHATGPT_WEB_NATIVE_LAYOUTS.reduce<(typeof CHATGPT_WEB_NATIVE_LAYOUTS)[number]>(
    (best, layout) =>
      Math.abs(Math.log(ratio / layout.ratio)) < Math.abs(Math.log(ratio / best.ratio))
        ? layout
        : best,
    CHATGPT_WEB_NATIVE_LAYOUTS[0]
  );
}

export function extractMarkdownImageUrls(text: string): string[] {
  const urls: string[] = [];
  // String.prototype.matchAll consumes a fresh iterator and ignores the
  // regex's lastIndex, so no manual reset is required.
  for (const match of text.matchAll(CHATGPT_WEB_IMAGE_MARKDOWN_RE)) {
    if (match[1]) urls.push(match[1]);
  }
  return urls;
}

export function buildChatGptWebImagePrompt(body, referenceImageCount = 0): string {
  const prompt = String(body.prompt || "").trim();
  const details: string[] = [];
  const layout = getChatGptWebImageLayout(body);
  if (referenceImageCount > 0) {
    details.push(
      `Use the attached reference image${referenceImageCount === 1 ? "" : "s"} as visual guidance.`
    );
  }
  details.push(`Create an image for this prompt: ${prompt}`);
  if (layout) {
    details.push(`Requested aspect ratio: ${layout.label} (${layout.aspectRatio}).`);
    details.push(`Requested size: ${layout.size}.`);
  } else if (typeof body.size === "string" && body.size.trim()) {
    details.push(`Requested size: ${body.size.trim()}.`);
  }
  if (typeof body.quality === "string" && body.quality.trim()) {
    details.push(`Requested quality: ${body.quality.trim()}.`);
  }
  if (typeof body.style === "string" && body.style.trim()) {
    details.push(`Requested style: ${body.style.trim()}.`);
  }
  return details.join("\n");
}

export async function handleChatGptWebImageGeneration({
  model,
  provider,
  body,
  credentials,
  log,
  signal,
  clientHeaders,
  apiKeyInfo = null,
  // Injectable so unit tests can drive the handler without a live ChatGPT
  // session; production uses the real executor.
  executorFactory = () => new ChatGptWebExecutor(),
}) {
  const startTime = Date.now();
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return saveImageErrorResult({
      provider,
      model,
      status: 400,
      startTime,
      error: "Prompt is required for ChatGPT Web image generation",
    });
  }

  if (!credentials?.apiKey) {
    return saveImageErrorResult({
      provider,
      model,
      status: 401,
      startTime,
      error: "ChatGPT Web credentials missing session cookie",
    });
  }

  // Each image is one chatgpt.com chat turn (~30s). Cap at 4 (matches OpenAI's
  // own limit for GPT Image models) so a stray n=1000 doesn't pin the
  // executor for hours before the upstream HTTP timeout fires.
  const CHATGPT_WEB_IMAGE_N_MAX = 4;
  const rawCount = Number.isInteger(body.n) && (body.n as number) > 0 ? (body.n as number) : 1;
  if (rawCount > CHATGPT_WEB_IMAGE_N_MAX) {
    return saveImageErrorResult({
      provider,
      model,
      status: 400,
      startTime,
      error: `ChatGPT Web image generation supports n=1..${CHATGPT_WEB_IMAGE_N_MAX} (got ${rawCount}); each n is a separate ~30s chat turn.`,
    });
  }
  const requestedCount = rawCount;
  if (log && requestedCount > 1) {
    log.warn(
      "IMAGE",
      `ChatGPT Web returns one image per chat turn; requested n=${requestedCount} will run sequentially`
    );
  }

  const wantsBase64 = body.response_format === "b64_json";
  const referenceImageUrls = extractImageInputs(body).imageUrls;
  const layout = getChatGptWebImageLayout(body);
  const isAutoLayout = isChatGptWebAutoLayout(getChatGptWebRequestedAspectRatio(body));
  const images: ChatGptWebImageResult[] = [];
  const requestBody = {
    model,
    prompt: prompt.slice(0, 500),
    size: layout?.size || (isAutoLayout ? undefined : body.size) || undefined,
    aspect_ratio: isAutoLayout
      ? "auto"
      : layout?.aspectRatio || body.aspect_ratio || body.aspectRatio || undefined,
    quality: body.quality || undefined,
    reference_images: referenceImageUrls.length || undefined,
  };

  const buildUserContent = () => {
    const text = buildChatGptWebImagePrompt(body, referenceImageUrls.length);
    if (referenceImageUrls.length === 0) return text;
    return [
      { type: "text", text },
      ...referenceImageUrls.map((url) => ({ type: "image_url", image_url: { url } })),
    ];
  };

  for (let i = 0; i < requestedCount; i++) {
    const executor = executorFactory();
    const result = await executor.execute({
      model,
      body: {
        messages: [{ role: "user", content: buildUserContent() }],
      },
      stream: false,
      credentials,
      signal,
      log,
      clientHeaders,
    });

    const responseText = await result.response.text();
    if (result.response.status >= 400) {
      return saveImageErrorResult({
        provider,
        model,
        status: result.response.status,
        startTime,
        error: responseText,
        requestBody,
      });
    }

    let content = "";
    let imageResolutionFailed = false;
    try {
      const json = JSON.parse(responseText);
      content = String(json?.choices?.[0]?.message?.content || "");
      imageResolutionFailed = json?.x_image_resolution_failed === true;
    } catch {
      content = responseText;
    }

    const urls = extractMarkdownImageUrls(content);
    if (urls.length === 0) {
      // Distinguish "image was generated upstream but OmniRoute could not
      // retrieve it" (executor flagged the unresolved asset pointer) from
      // "no image was produced at all" — the former is our bug/limitation,
      // not a failed prompt, so the message must not read as "no image made".
      const error = imageResolutionFailed
        ? `ChatGPT Web generated an image but OmniRoute could not retrieve it (the image asset could not be downloaded — the URL may have expired or ChatGPT changed its image delivery format). Please retry; if it persists, report it. Assistant text: ${content.slice(0, 200)}`
        : `ChatGPT Web completed without returning image markdown: ${content.slice(0, 300)}`;
      return saveImageErrorResult({
        provider,
        model,
        status: 502,
        startTime,
        error,
        requestBody,
      });
    }

    for (const url of urls) {
      if (!wantsBase64) {
        images.push(withChatGptWebCacheMetadata({ url }, url));
        continue;
      }
      const id = url.match(CHATGPT_WEB_IMAGE_ID_RE)?.[1];
      const cached = id ? getChatGptImage(id) : null;
      if (!cached) {
        return saveImageErrorResult({
          provider,
          model,
          status: 502,
          startTime,
          error: "ChatGPT Web image bytes expired before b64_json conversion",
          requestBody,
        });
      }
      images.push(withChatGptWebCacheMetadata({ b64_json: cached.bytes.toString("base64") }, id));
    }
  }

  return saveImageSuccessResult({
    provider,
    model,
    startTime,
    requestBody,
    responseBody: { images_count: images.length },
    images,
    tokens: { images: images.length, image_count: images.length },
    connectionId: credentials?.connectionId || null,
    apiKeyId: apiKeyInfo?.id || null,
    apiKeyName: apiKeyInfo?.name || null,
  });
}
