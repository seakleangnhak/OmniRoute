import { parseImageModel } from "@omniroute/open-sse/config/imageRegistry.ts";
import { getProviderConnectionById } from "@/lib/db/providers";

export interface CodexImageGatewayRoute {
  provider: string;
  model: string;
  connectionIds: string[];
}

/** Keep client-facing Codex image names while using an operator-selected gateway. */
export async function resolveCodexImageGatewayRoute(
  model: string
): Promise<CodexImageGatewayRoute | null> {
  const connectionId = process.env.OMNIROUTE_CODEX_IMAGE_CONNECTION_ID?.trim();
  if (!connectionId || parseImageModel(model).provider !== "codex") return null;

  const connection = await getProviderConnectionById(connectionId);
  if (
    !connection ||
    typeof connection.provider !== "string" ||
    !connection.provider.startsWith("openai-compatible-") ||
    connection.authType !== "apikey" ||
    connection.isActive === false
  ) {
    throw new Error("Codex image gateway requires an active OpenAI-compatible API-key connection");
  }

  return {
    provider: connection.provider,
    model: process.env.OMNIROUTE_CODEX_IMAGE_MODEL?.trim() || "cx/gpt-image-2.5",
    connectionIds: [connectionId],
  };
}
