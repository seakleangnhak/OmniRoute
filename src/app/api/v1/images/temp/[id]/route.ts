import { CORS_HEADERS, handleCorsOptions } from "@/shared/utils/cors";
import { readTemporaryImage } from "@/lib/images/tempImageFile";

export async function OPTIONS() {
  return handleCorsOptions();
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const image = await readTemporaryImage(id);
  if (!image) {
    return new Response(JSON.stringify({ error: "Image not found or expired" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  const maxAge = Math.max(0, Math.floor((image.expiresAt - Date.now()) / 1000));
  return new Response(image.bytes, {
    status: 200,
    headers: {
      "Content-Type": image.mime,
      "Content-Length": String(image.bytes.length),
      "Content-Disposition": `inline; filename="omniroute-image.${image.extension}"`,
      "Cache-Control": `private, max-age=${maxAge}`,
      "X-Content-Type-Options": "nosniff",
      ...CORS_HEADERS,
    },
  });
}
