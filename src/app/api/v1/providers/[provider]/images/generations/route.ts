import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import { getImageProvider, parseImageModel } from "@omniroute/open-sse/config/imageRegistry.ts";
import { POST as generateImages } from "@/app/api/v1/images/generations/route";
import { v1ImageGenerationSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

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
 * POST /v1/providers/{provider}/images/generations
 */
export async function POST(request, { params }) {
  const { provider: rawProvider } = await params;

  // Verify this is a valid image provider
  const imageProvider = getImageProvider(rawProvider);
  if (!imageProvider) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Unknown image provider: ${rawProvider}`);
  }

  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }
  const validation = validateBody(v1ImageGenerationSchema, rawBody);
  if (isValidationFailure(validation)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, validation.error.message);
  }
  const body = validation.data;

  // Ensure model has provider prefix
  if (!body.model.includes("/")) {
    body.model = `${rawProvider}/${body.model}`;
  }

  // Validate provider match
  const modelProvider = parseImageModel(body.model).provider;
  if (modelProvider !== imageProvider.id) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Model "${body.model}" does not belong to image provider "${rawProvider}"`
    );
  }

  // Share authentication, connection restrictions, gateway routing, and output
  // negotiation with the existing general image API.
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return generateImages(
    new Request(request.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
    }),
    { params }
  );
}
