import type {
  CompressionConfig,
  CompressionMode,
  CompressionPipelineStep,
  CompressionResult,
  CompressionStats,
} from "./types.ts";
import { applyLiteCompression } from "./lite.ts";
import { cavemanCompress } from "./caveman.ts";
import { compressAggressive } from "./aggressive.ts";
import { ultraCompress } from "./ultra.ts";
import { createCompressionStats } from "./stats.ts";
import { registerBuiltinCompressionEngines } from "./engines/index.ts";
import { getCompressionEngine } from "./engines/registry.ts";
import { applyRtkCompression } from "./engines/rtk/index.ts";
import {
  detectCachingContext,
  getCacheAwareStrategy,
  type CachingDetectionContext,
} from "./cachingAware.ts";

type JsonRecord = Record<string, unknown>;

type ResponsesInputMapping =
  | { kind: "input-string" }
  | { kind: "message"; index: number }
  | { kind: "tool-output"; index: number };

type ResponsesInputCompressionAdapter = {
  body: Record<string, unknown>;
  restore: (compressedBody: Record<string, unknown>) => Record<string, unknown>;
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((part) => {
      if (isRecord(part) && typeof part.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function restoreTextContentShape(originalContent: unknown, compressedContent: unknown): unknown {
  if (typeof originalContent === "string") return toTextContent(compressedContent);
  if (!Array.isArray(originalContent) || !Array.isArray(compressedContent))
    return compressedContent;

  let textIndex = 0;
  return originalContent.map((part) => {
    if (!isRecord(part) || typeof part.text !== "string") return part;

    while (
      textIndex < compressedContent.length &&
      (!isRecord(compressedContent[textIndex]) ||
        typeof compressedContent[textIndex].text !== "string")
    ) {
      textIndex += 1;
    }

    const compressedPart = compressedContent[textIndex];
    textIndex += 1;
    return isRecord(compressedPart) && typeof compressedPart.text === "string"
      ? { ...part, text: compressedPart.text }
      : part;
  });
}

function getMessageRole(value: unknown, fallback = "user"): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function createResponsesInputCompressionAdapter(
  body: Record<string, unknown>
): ResponsesInputCompressionAdapter | null {
  if (Array.isArray(body.messages) && body.messages.length > 0) return null;
  if (body.input === undefined) return null;

  const input = body.input;
  const messages: JsonRecord[] = [];
  const mappings: ResponsesInputMapping[] = [];

  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    mappings.push({ kind: "input-string" });
  } else if (Array.isArray(input)) {
    input.forEach((item, index) => {
      if (!isRecord(item)) return;
      const itemType = typeof item.type === "string" ? item.type : item.role ? "message" : "";
      if (itemType === "message") {
        messages.push({
          role: getMessageRole(item.role),
          content: item.content,
        });
        mappings.push({ kind: "message", index });
        return;
      }

      if (itemType === "function_call_output") {
        messages.push({
          role: "tool",
          tool_call_id: item.call_id,
          content: typeof item.output === "string" ? item.output : JSON.stringify(item.output),
        });
        mappings.push({ kind: "tool-output", index });
      }
    });
  }

  if (messages.length === 0) return null;

  return {
    body: { ...body, messages },
    restore(compressedBody) {
      const compressedMessages = Array.isArray(compressedBody.messages)
        ? (compressedBody.messages as JsonRecord[])
        : messages;
      const restored: JsonRecord = { ...compressedBody };

      if (typeof input === "string") {
        const firstMessage = compressedMessages[0];
        restored.input = toTextContent(firstMessage?.content);
      } else if (Array.isArray(input)) {
        const nextInput = [...input];
        mappings.forEach((mapping, messageIndex) => {
          const message = compressedMessages[messageIndex];
          if (!message) return;
          const originalItem = nextInput[mapping.index];
          if (!isRecord(originalItem)) return;

          if (mapping.kind === "message") {
            nextInput[mapping.index] = {
              ...originalItem,
              content: restoreTextContentShape(originalItem.content, message.content),
            };
          } else if (mapping.kind === "tool-output") {
            nextInput[mapping.index] = {
              ...originalItem,
              output: toTextContent(message.content),
            };
          }
        });
        restored.input = nextInput;
      }

      delete restored.messages;
      return restored;
    },
  };
}

function rebaseCompressionStats(
  originalBody: Record<string, unknown>,
  compressedBody: Record<string, unknown>,
  stats: CompressionStats
): CompressionStats {
  const rebased = createCompressionStats(
    originalBody,
    compressedBody,
    stats.mode,
    stats.techniquesUsed,
    stats.rulesApplied,
    stats.durationMs
  );
  return {
    ...stats,
    originalTokens: rebased.originalTokens,
    compressedTokens: rebased.compressedTokens,
    savingsPercent: rebased.savingsPercent,
  };
}

export function checkComboOverride(
  config: CompressionConfig,
  comboId: string | null
): CompressionMode | null {
  if (!comboId || !config.comboOverrides) return null;
  return config.comboOverrides[comboId] ?? null;
}

export function shouldAutoTrigger(config: CompressionConfig, estimatedTokens: number): boolean {
  return config.autoTriggerTokens > 0 && estimatedTokens >= config.autoTriggerTokens;
}

export function getEffectiveMode(
  config: CompressionConfig,
  comboId: string | null,
  estimatedTokens: number
): CompressionMode {
  if (!config.enabled) return "off";

  const comboMode = checkComboOverride(config, comboId);
  if (comboMode) return comboMode;

  if (shouldAutoTrigger(config, estimatedTokens)) return config.autoTriggerMode ?? "lite";

  return config.defaultMode;
}

export function selectCompressionStrategy(
  config: CompressionConfig,
  comboId: string | null,
  estimatedTokens: number,
  body?: Record<string, unknown>,
  context?: CachingDetectionContext
): CompressionMode {
  const selectedMode = getEffectiveMode(config, comboId, estimatedTokens);

  // Apply caching-aware adjustments if body is provided
  if (body) {
    const ctx = detectCachingContext(body, context);
    const cacheAware = getCacheAwareStrategy(selectedMode, ctx);
    return cacheAware.strategy as CompressionMode;
  }

  return selectedMode;
}

export function applyCompression(
  body: Record<string, unknown>,
  mode: CompressionMode,
  options?: { model?: string; supportsVision?: boolean | null; config?: CompressionConfig }
): CompressionResult {
  if (mode === "off") {
    return { body, compressed: false, stats: null };
  }

  const responsesInputAdapter = createResponsesInputCompressionAdapter(body);
  if (responsesInputAdapter) {
    const adaptedResult = applyCompression(responsesInputAdapter.body, mode, options);
    if (!adaptedResult.stats) return { body, compressed: false, stats: null };

    const restoredBody = adaptedResult.compressed
      ? responsesInputAdapter.restore(adaptedResult.body)
      : body;
    return {
      body: restoredBody,
      compressed: adaptedResult.compressed,
      stats: rebaseCompressionStats(body, restoredBody, adaptedResult.stats),
    };
  }

  if (mode === "lite") {
    return applyLiteCompression(body, {
      ...options,
      preserveSystemPrompt: options?.config?.preserveSystemPrompt !== false,
    });
  }
  if (mode === "rtk") {
    return applyRtkCompression(body, {
      config: options?.config?.rtkConfig,
    });
  }
  if (mode === "stacked") {
    return applyStackedCompression(body, options?.config?.stackedPipeline, options);
  }
  if (mode === "standard") {
    const cavemanConfig = {
      ...(options?.config?.cavemanConfig ?? {}),
      ...(options?.config?.languageConfig?.enabled
        ? {
            language: options.config.languageConfig.defaultLanguage,
            autoDetectLanguage: options.config.languageConfig.autoDetect,
            enabledLanguagePacks: options.config.languageConfig.enabledPacks,
          }
        : {}),
      ...(options?.config?.preserveSystemPrompt !== false
        ? {
            compressRoles: (options?.config?.cavemanConfig?.compressRoles ?? ["user"]).filter(
              (role) => role !== "system"
            ),
          }
        : {}),
    };
    return cavemanCompress(body as Parameters<typeof cavemanCompress>[0], cavemanConfig);
  }
  if (mode === "aggressive") {
    const messages = (body.messages ?? []) as Array<{
      role: string;
      content?: string | Array<{ type: string; text?: string }>;
      [key: string]: unknown;
    }>;
    if (!Array.isArray(messages) || messages.length === 0) {
      return { body, compressed: false, stats: null };
    }
    const aggressiveConfig = {
      ...(options?.config?.aggressive ?? {}),
      preserveSystemPrompt: options?.config?.preserveSystemPrompt !== false,
    };
    const result = compressAggressive(messages, aggressiveConfig);
    const compressedBody = { ...body, messages: result.messages };
    return {
      body: compressedBody,
      compressed: result.stats.savingsPercent > 0,
      stats: createCompressionStats(
        body,
        compressedBody,
        mode,
        ["aggressive"],
        result.stats.rulesApplied,
        result.stats.durationMs
      ),
    };
  }
  if (mode === "ultra") {
    const messages = (body.messages ?? []) as Array<{
      role: string;
      content?: string | unknown[];
      [key: string]: unknown;
    }>;
    if (!Array.isArray(messages) || messages.length === 0) {
      return { body, compressed: false, stats: null };
    }
    const ultraConfig = {
      ...(options?.config?.ultra ?? {}),
      preserveSystemPrompt: options?.config?.preserveSystemPrompt !== false,
    };
    const result = ultraCompress(messages, ultraConfig);
    const compressedBody = { ...body, messages: result.messages };
    return {
      body: compressedBody,
      compressed: result.stats.savingsPercent > 0,
      stats: createCompressionStats(
        body,
        compressedBody,
        mode,
        ["ultra"],
        result.stats.rulesApplied,
        result.stats.durationMs
      ),
    };
  }
  return { body, compressed: false, stats: null };
}

function normalizePipelineStep(step: CompressionPipelineStep | string): CompressionPipelineStep {
  if (typeof step !== "string") return step;
  if (step === "standard") return { engine: "caveman" };
  if (step === "rtk") return { engine: "rtk" };
  if (step === "lite" || step === "aggressive" || step === "ultra") return { engine: step };
  return { engine: "caveman" };
}

export function applyStackedCompression(
  body: Record<string, unknown>,
  pipeline?: Array<CompressionPipelineStep | string>,
  options?: {
    model?: string;
    supportsVision?: boolean | null;
    config?: CompressionConfig;
    compressionComboId?: string | null;
  }
): CompressionResult {
  const steps =
    pipeline && pipeline.length > 0
      ? pipeline.map(normalizePipelineStep)
      : [
          { engine: "rtk" as const, intensity: "standard" as const },
          { engine: "caveman" as const, intensity: "full" as const },
        ];
  registerBuiltinCompressionEngines();

  let currentBody = body;
  let compressed = false;
  const techniques = new Set<string>();
  const rules = new Set<string>();
  const breakdown: NonNullable<CompressionStats["engineBreakdown"]> = [];
  const rtkRawOutputPointers: NonNullable<CompressionStats["rtkRawOutputPointers"]> = [];
  const validationWarnings = new Set<string>();
  const validationErrors = new Set<string>();
  let fallbackApplied = false;
  const start = performance.now();

  for (const step of steps) {
    const engine = getCompressionEngine(step.engine);
    if (!engine) continue;
    const result = engine.apply(currentBody, {
      ...options,
      compressionComboId: options?.compressionComboId ?? options?.config?.compressionComboId,
      stepConfig: {
        ...(step.config ?? {}),
        ...(step.intensity ? { intensity: step.intensity } : {}),
      },
    });
    if (result.stats) {
      result.stats.techniquesUsed.forEach((technique) => techniques.add(technique));
      result.stats.rulesApplied?.forEach((rule) => rules.add(rule));
      result.stats.rtkRawOutputPointers?.forEach((pointer) => {
        rtkRawOutputPointers.push(pointer);
      });
      result.stats.validationWarnings?.forEach((warning) => validationWarnings.add(warning));
      result.stats.validationErrors?.forEach((error) => validationErrors.add(error));
      fallbackApplied = fallbackApplied || result.stats.fallbackApplied === true;
      breakdown.push({
        engine: step.engine,
        originalTokens: result.stats.originalTokens,
        compressedTokens: result.stats.compressedTokens,
        savingsPercent: result.stats.savingsPercent,
        techniquesUsed: result.stats.techniquesUsed,
        ...(result.stats.rulesApplied ? { rulesApplied: result.stats.rulesApplied } : {}),
        ...(result.stats.durationMs !== undefined ? { durationMs: result.stats.durationMs } : {}),
      });
    }
    if (result.compressed) {
      currentBody = result.body;
      compressed = true;
    }
  }

  const stats = createCompressionStats(
    body,
    currentBody,
    "stacked",
    Array.from(techniques),
    rules.size > 0 ? Array.from(rules) : undefined,
    Math.round((performance.now() - start) * 100) / 100
  );
  stats.engine = "stacked";
  stats.compressionComboId =
    options?.compressionComboId ?? options?.config?.compressionComboId ?? null;
  stats.engineBreakdown = breakdown;
  if (validationWarnings.size > 0) {
    stats.validationWarnings = Array.from(validationWarnings);
  }
  if (validationErrors.size > 0) {
    stats.validationErrors = Array.from(validationErrors);
  }
  if (fallbackApplied) {
    stats.fallbackApplied = true;
  }
  if (rtkRawOutputPointers.length > 0) {
    const seenPointers = new Set<string>();
    stats.rtkRawOutputPointers = rtkRawOutputPointers.filter((pointer) => {
      if (seenPointers.has(pointer.id)) return false;
      seenPointers.add(pointer.id);
      return true;
    });
  }

  return {
    body: currentBody,
    compressed,
    stats,
  };
}
