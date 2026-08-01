import { DefaultExecutor } from "./default.ts";
import { ExecuteInput, type ProviderCredentials } from "./base.ts";
import { applyProviderRequestDefaults } from "../services/providerRequestDefaults.ts";
import { NON_ANTHROPIC_THINKING_PLACEHOLDER } from "../translator/helpers/claudeHelper.ts";
type JsonRecord = Record<string, unknown>;
type KimiProtocol = "openai" | "claude";

function hasActiveKimiThinking(body: JsonRecord): boolean {
  const thinking = body.thinking;
  if (thinking && typeof thinking === "object" && !Array.isArray(thinking)) {
    const thinkingRecord = thinking as JsonRecord;
    return thinkingRecord.type === "enabled" || thinkingRecord.type === "adaptive";
  }
  return false;
}

function hasNonEmptyReasoningContent(message: JsonRecord): boolean {
  return (
    typeof message.reasoning_content === "string" && message.reasoning_content.trim().length > 0
  );
}

function isToolUseBlock(value: unknown): value is JsonRecord {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as JsonRecord).type === "tool_use"
  );
}

function isThinkingBlock(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ((value as JsonRecord).type === "thinking" ||
      (value as JsonRecord).type === "redacted_thinking")
  );
}

function hasAssistantToolCalls(message: JsonRecord): boolean {
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
  return Array.isArray(message.content) && message.content.some(isToolUseBlock);
}

function isClaudeProtocolBody(body: JsonRecord): boolean {
  if (Array.isArray(body.system)) return true;

  if (!Array.isArray(body.messages)) return false;
  return body.messages.some((message: unknown) => {
    const msg = asRecord(message);
    if (!msg || !Array.isArray(msg.content)) return false;
    return msg.content.some((part) => {
      const block = asRecord(part);
      return block?.type === "text" || block?.type === "tool_use" || block?.type === "tool_result";
    });
  });
}

function disableKimiPreservedThinking(body: JsonRecord): JsonRecord {
  if (!isClaudeProtocolBody(body)) return body;

  const thinking = asRecord(body.thinking) ?? { type: "enabled" };
  if (thinking.keep === null) return body;

  return {
    ...body,
    thinking: {
      ...thinking,
      keep: null,
    },
  };
}

function ensureKimiThinkingContent(message: JsonRecord): JsonRecord {
  const reasoningContent = hasNonEmptyReasoningContent(message)
    ? String(message.reasoning_content)
    : NON_ANTHROPIC_THINKING_PLACEHOLDER;
  let nextMessage = hasNonEmptyReasoningContent(message)
    ? message
    : { ...message, reasoning_content: reasoningContent };

  if (!Array.isArray(nextMessage.content)) return nextMessage;
  const firstToolUseIndex = nextMessage.content.findIndex(isToolUseBlock);
  if (firstToolUseIndex < 0 || nextMessage.content.some(isThinkingBlock)) return nextMessage;

  const content = [...nextMessage.content];
  content.splice(firstToolUseIndex, 0, {
    type: "thinking",
    thinking: reasoningContent,
  });
  return { ...nextMessage, content };
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function resolveKimiProtocol(
  credentials: ProviderCredentials | null | undefined,
  body?: unknown
): KimiProtocol {
  const targetFormat = credentials?.providerSpecificData?._omnirouteKimiTargetFormat;
  if (targetFormat === FORMATS.OPENAI) return "openai";
  if (targetFormat === FORMATS.CLAUDE) return "claude";

  const record = asRecord(body);
  if (
    record?.system !== undefined ||
    record?.output_config !== undefined ||
    record?.context_management !== undefined
  ) {
    return "claude";
  }
  return "openai";
}

export class KimiExecutor extends DefaultExecutor {
  constructor(provider = "kimi-coding") {
    super(provider);
  }

  buildUrl(
    model: string,
    stream: boolean,
    urlIndex = 0,
    credentials: ProviderCredentials | null = null
  ): string {
    void model;
    void stream;
    void urlIndex;
    return resolveKimiProtocol(credentials) === "claude"
      ? KIMI_CODING_ANTHROPIC_URL
      : KIMI_CODING_OPENAI_URL;
  }

  buildHeaders(
    credentials: ProviderCredentials,
    stream = true,
    clientHeaders?: Record<string, string> | null
  ): Record<string, string> {
    const headers = super.buildHeaders(credentials, stream, clientHeaders);
    const protocol = resolveKimiProtocol(credentials);
    const token = headers["x-api-key"] || credentials.apiKey || credentials.accessToken || "";

    if (protocol === "claude") {
      deleteHeaders(headers, ["authorization"]);
      headers["x-api-key"] = token;
      headers["Anthropic-Version"] = "2023-06-01";
    } else {
      deleteHeaders(headers, ["x-api-key", "anthropic-version", "anthropic-beta"]);
      headers.Authorization = `Bearer ${token}`;
    }

    if (credentials.accessToken && !credentials.apiKey) {
      Object.assign(headers, buildKimiCodeIdentityHeaders(credentials.providerSpecificData || {}), {
        "User-Agent": getKimiCodeCliUserAgent(),
      });
    }
    return headers;
  }

  transformRequest(
    model: string,
    body: unknown,
    stream: boolean,
    credentials: ProviderCredentials
  ): unknown {
    const cleanedBody = super.transformRequest(model, body, stream, credentials);
    const record = asRecord(cleanedBody);
    if (!record) return cleanedBody;
    const policy = getThinkingPolicy(credentials);
    const normalized =
      resolveKimiProtocol(credentials, record) === "claude"
        ? normalizeAnthropicRequest(record, policy)
        : normalizeOpenAIRequest(record, stream, policy);
    return stream ? { ...normalized, stream: true } : normalized;
  }
}

export default KimiExecutor;
