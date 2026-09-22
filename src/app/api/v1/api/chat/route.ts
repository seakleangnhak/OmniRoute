import { handleChat } from "@/sse/handlers/chat";
import { initTranslators } from "@omniroute/open-sse/translator/index.ts";
import { transformToOllama } from "@omniroute/open-sse/utils/ollamaTransform.ts";
import { enforceClientApiAuth } from "../../_helpers/clientApiAuth";
import { withChatAdmission } from "@/shared/middleware/withChatAdmission";

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
    console.log("[SSE] Translators initialized");
  }
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

async function postHandler(request) {
  const authRejection = await enforceClientApiAuth(request);
  if (authRejection) return authRejection;

  await ensureInitialized();

  const clonedReq = request.clone();
  let modelName = "llama3.2";
  try {
    const body = await clonedReq.json();
    modelName = body.model || "llama3.2";
  } catch {}

  const response = await handleChat(request);
  return transformToOllama(response, modelName);
}

export const POST = withChatAdmission(postHandler);
