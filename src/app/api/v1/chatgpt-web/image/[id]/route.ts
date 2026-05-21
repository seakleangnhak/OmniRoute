import { CORS_HEADERS, handleCorsOptions } from "@/shared/utils/cors";
import { getChatGptImage } from "@omniroute/open-sse/services/chatgptImageCache.ts";

export async function OPTIONS() {
  return handleCorsOptions();
}

/**
 * Serve a cached ChatGPT-generated image by its opaque cache id.
 *
 * Auth: intentionally unauthenticated. The id is a 128-bit random UUID and
 * the entry expires on the configured image-cache TTL, so the URL is
 * unguessable for its lifetime. We need it open because it's loaded by the user's BROWSER
 * (via an `<img>` tag rendered from markdown) — that fetch doesn't carry
 * the OmniRoute API key. Rate limiting / abuse protection sit at the
 * network layer the same way they do for any other static asset.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const entry = getChatGptImage(id);
  if (!entry) {
    return new Response(JSON.stringify({ error: "Image not found or expired" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
  // entry.bytes is a Buffer (subclass of Uint8Array); pass it directly.
  // Wrapping in `new Uint8Array(...)` would copy the entire payload — up to
  // 8 MB per image — for no benefit.
  const maxAge = Math.max(0, Math.min(86400, Math.floor((entry.expiresAt - Date.now()) / 1000)));
  return new Response(entry.bytes, {
    status: 200,
    headers: {
      "Content-Type": entry.mime,
      // The id is unique-per-image, so browser caching is safe. Cap browser
      // cache to one day even when the persistent cache TTL is longer.
      "Cache-Control": `private, max-age=${maxAge}`,
      "Content-Length": String(entry.bytes.length),
      ...CORS_HEADERS,
    },
  });
}
