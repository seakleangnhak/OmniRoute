import { getModelInfo } from "../services/model";
import { clearAccountError, markAccountUnavailable } from "../services/auth";
import * as log from "../utils/logger";
import { updateProviderCredentials } from "../services/tokenRefresh";
import {
  detectFormatFromEndpoint,
  getTargetFormat,
} from "@omniroute/open-sse/services/provider.ts";
import {
  getModelTargetFormat,
  PROVIDER_ID_TO_ALIAS,
} from "@omniroute/open-sse/config/providerModels.ts";
import { handleChatCore } from "@omniroute/open-sse/handlers/chatCore.ts";
import {
  errorResponse,
  modelCooldownResponse,
  providerCircuitOpenResponse,
  unavailableResponse,
} from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import {
  runWithProxyContext,
  runWithTlsTracking,
  isTlsFingerprintActive,
} from "@omniroute/open-sse/utils/proxyFetch.ts";
import { resolveProxyForConnection } from "@/lib/localDb";
import {
  isRotatingProxyRequiredError,
  markRotatingProxyFailed,
  markRotatingProxySucceeded,
} from "@/lib/rotatingProxy";
import { CircuitBreakerOpenError, getCircuitBreaker } from "../../shared/utils/circuitBreaker";
import { logProxyEvent } from "../../lib/proxyLogger";
import { logTranslationEvent } from "../../lib/translatorEvents";
import { getRuntimeProviderProfile } from "@omniroute/open-sse/services/accountFallback.ts";

// Models that explicitly cannot run on the codex/ChatGPT-Pro OAuth pool — when
// a caller writes `codex/deepseek-v4-pro` we transparently reroute to the
// canonical provider whose API key is configured. Saves callers from having
// to know about the OAuth-vs-API-key split.
const NON_OAUTH_MODEL_PREFIX = /^(deepseek|qwen|kimi|glm|minimax|mimo)/i;
const PREFERRED_BY_FAMILY: Record<string, string> = {
  deepseek: "deepseek",
  qwen: "bailian",
  kimi: "moonshot",
  glm: "zhipu",
  minimax: "minimax",
  mimo: "moonshot",
};

export async function resolveModelOrError(modelStr: string, body: any, endpointPath: string = "") {
  const modelInfo = await getModelInfo(modelStr);

  // Forced-rewrite: codex provider doesn't serve DeepSeek/Qwen/Kimi/etc. Reroute
  // these to their canonical native provider so the request lands on the right
  // upstream API key instead of failing with a 400 on the OAuth account.
  // Ambiguous candidates (e.g. deepseek-v4-pro lives on both ds + opencode-go)
  // resolve to the model-family's native provider via NON_OAUTH_PROVIDER_BY_FAMILY.
  if (
    modelInfo.provider === "codex" &&
    typeof modelInfo.model === "string" &&
    NON_OAUTH_MODEL_PREFIX.test(modelInfo.model)
  ) {
    log.info(
      "ROUTING",
      `codex/${modelInfo.model} → re-resolving via native provider (codex OAuth does not serve this model)`
    );
    const rerouted = await getModelInfo(modelInfo.model);
    if (rerouted.provider && rerouted.provider !== "codex") {
      log.info("ROUTING", `codex/${modelInfo.model} → ${rerouted.provider}/${rerouted.model}`);
      Object.assign(modelInfo, rerouted);
    } else if ((rerouted as any).errorType === "ambiguous_model") {
      const candidates: string[] = (rerouted as any).candidateProviders || [];
      const family = modelInfo.model.match(NON_OAUTH_MODEL_PREFIX)?.[1]?.toLowerCase();
      const pick = family && PREFERRED_BY_FAMILY[family];
      if (pick && candidates.includes(pick)) {
        log.info(
          "ROUTING",
          `codex/${modelInfo.model} → ${pick}/${modelInfo.model} (ambiguity resolved by family)`
        );
        modelInfo.provider = pick;
        modelInfo.model = (rerouted as any).model;
      }
    }
  }

  if (!modelInfo.provider) {
    if ((modelInfo as any).errorType === "ambiguous_model") {
      // Family disambiguation: if the model name begins with a known
      // non-OAuth family prefix, auto-pick the family-native provider
      // from the candidate set instead of returning a 400. Saves callers
      // (codex CLI, hermes, etc.) from having to guess the right alias.
      const candidates: string[] = (modelInfo as any).candidateProviders || [];
      const modelLower = (modelInfo.model || modelStr).toLowerCase();
      const family = modelLower.match(NON_OAUTH_MODEL_PREFIX)?.[1];
      const pick = family && PREFERRED_BY_FAMILY[family];
      if (pick && candidates.includes(pick)) {
        log.info(
          "ROUTING",
          `${modelStr} → ${pick}/${modelInfo.model} (ambiguity auto-resolved by family)`
        );
        modelInfo.provider = pick;
      } else {
        const message =
          (modelInfo as any).errorMessage ||
          `Ambiguous model '${modelStr}'. Use provider/model prefix (ex: gh/${modelStr} or cc/${modelStr}).`;
        log.warn("CHAT", message, {
          model: modelStr,
          candidates:
            (modelInfo as any).candidateAliases || (modelInfo as any).candidateProviders || [],
        });
        return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, message) };
      }
    } else {
      log.warn("CHAT", "Invalid model format", { model: modelStr });
      return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format") };
    }
  }

  const { provider, model, extendedContext } = modelInfo;
  const sourceFormat = detectFormatFromEndpoint(body, endpointPath);
  const providerAlias = PROVIDER_ID_TO_ALIAS[provider] || provider;
  let targetFormat = getModelTargetFormat(providerAlias, model) || getTargetFormat(provider);
  if ((modelInfo as any).apiFormat === "responses") {
    targetFormat = "openai-responses";
    log.info("ROUTING", `Custom model apiFormat=responses → targetFormat=openai-responses`);
  }

  const ctxTag = extendedContext && providerAlias === "claude" ? " [1m]" : "";
  if (modelStr !== `${provider}/${model}`) {
    log.info("ROUTING", `${modelStr} → ${provider}/${model}${ctxTag}`);
  } else {
    log.info("ROUTING", `Provider: ${provider}, Model: ${model}${ctxTag}`);
  }

  return { provider, model, sourceFormat, targetFormat, extendedContext };
}

export async function checkPipelineGates(
  provider: string,
  model: string,
  options: {
    ignoreCircuitBreaker?: boolean;
    ignoreModelCooldown?: boolean;
    bypassReason?: string;
    providerProfile?: {
      circuitBreakerThreshold?: number;
      circuitBreakerReset?: number;
      failureThreshold?: number;
      resetTimeoutMs?: number;
    } | null;
  } = {}
) {
  const bypassReason = options.bypassReason || "pipeline override";
  const providerProfile = options.providerProfile ?? (await getRuntimeProviderProfile(provider));
  const breaker = getCircuitBreaker(provider, {
    failureThreshold: providerProfile.failureThreshold ?? providerProfile.circuitBreakerThreshold,
    resetTimeout: providerProfile.resetTimeoutMs ?? providerProfile.circuitBreakerReset,
    onStateChange: (name: string, from: string, to: string) =>
      log.info("CIRCUIT", `${name}: ${from} → ${to}`),
    isFailure: (error: unknown) => !isProxyUnreachableError(error),
  });
  if (options.ignoreCircuitBreaker && !breaker.canExecute()) {
    log.info("CIRCUIT", `Bypassing OPEN circuit breaker for ${provider} (${bypassReason})`);
  } else if (!breaker.canExecute()) {
    const retryAfterMs = breaker.getRetryAfterMs();
    const retryAfterSec = Math.max(Math.ceil(retryAfterMs / 1000), 1);
    log.warn("CIRCUIT", `Circuit breaker OPEN for ${provider}, rejecting request`);
    return providerCircuitOpenResponse(provider, retryAfterSec);
  }

  return null;
}

function isProxyUnreachableError(error: any): boolean {
  return error?.code === "PROXY_UNREACHABLE" || /proxy unreachable/i.test(error?.message || "");
}

function getRotatingProxyMaxAttempts(proxyInfo?: any): number {
  const configured = proxyInfo?.rotation?.maxProxyRetries;
  const parsed = Number(configured ?? process.env.ONEPROXY_ROTATING_PROXY_MAX_ATTEMPTS ?? 3);
  if (!Number.isFinite(parsed)) return 3;
  return Math.max(1, Math.min(5, Math.trunc(parsed)));
}

function getRotatingProxyId(proxyInfo: any): string | null {
  const proxyId = proxyInfo?.rotation?.proxyId;
  return typeof proxyId === "string" && proxyId.trim().length > 0 ? proxyId : null;
}

export async function executeChatWithBreaker({
  bypassCircuitBreaker,
  breaker,
  body,
  provider,
  model,
  refreshedCredentials,
  proxyInfo,
  stickyContext,
  log: handlerLog,
  clientRawRequest,
  credentials,
  apiKeyInfo,
  userAgent,
  comboName,
  comboStrategy,
  isCombo,
  comboStepId,
  comboExecutionKey,
  extendedContext,
  providerProfile,
}: any): Promise<{ result: any; tlsFingerprintUsed: boolean; proxyInfo: any }> {
  let activeProxyInfo = proxyInfo;
  const excludedRotatingProxyIds = new Set<string>();
  const maxRotatingProxyAttempts = getRotatingProxyMaxAttempts(activeProxyInfo);
  let rotatingProxyAttempt = 1;

  const executeOnce = async () => {
    const chatFn = () =>
      runWithProxyContext(activeProxyInfo?.proxy || null, () =>
        (handleChatCore as any)({
          body: { ...body, model: `${provider}/${model}` },
          modelInfo: { provider, model, extendedContext },
          credentials: refreshedCredentials,
          log: handlerLog,
          clientRawRequest,
          connectionId: credentials.connectionId,
          apiKeyInfo,
          userAgent,
          comboName,
          comboStrategy,
          isCombo,
          comboStepId,
          comboExecutionKey,
          onCredentialsRefreshed: async (newCreds: any) => {
            await updateProviderCredentials(credentials.connectionId, {
              accessToken: newCreds.accessToken,
              refreshToken: newCreds.refreshToken,
              expiresIn: newCreds.expiresIn,
              expiresAt: newCreds.expiresAt,
              providerSpecificData: newCreds.providerSpecificData,
              // Cookie/session providers (chatgpt-web) rotate the stored
              // apiKey blob mid-request — forward it so the DB credential
              // doesn't go stale after Set-Cookie rotation.
              apiKey: newCreds.apiKey,
              testStatus: "active",
            });
          },
          onRequestSuccess: async () => {
            await clearAccountError(credentials.connectionId, credentials);
          },
          onStreamFailure: async (failure: any) => {
            if (!credentials.connectionId) return;
            await markAccountUnavailable(
              credentials.connectionId,
              Number(failure?.status || HTTP_STATUS.BAD_GATEWAY),
              String(failure?.message || failure?.code || "stream failure"),
              provider,
              model,
              providerProfile
            );
          },
        })
      );

    if (bypassCircuitBreaker) {
      if (!activeProxyInfo?.proxy && isTlsFingerprintActive()) {
        const tracked = await runWithTlsTracking(chatFn);
        return { result: tracked.result, tlsFingerprintUsed: tracked.tlsFingerprintUsed };
      }

      const result = await chatFn();
      return { result, tlsFingerprintUsed: false };
    }

    if (!activeProxyInfo?.proxy && isTlsFingerprintActive()) {
      const tracked = await breaker.execute(async () => runWithTlsTracking(chatFn));
      return { result: tracked.result, tlsFingerprintUsed: tracked.tlsFingerprintUsed };
    }

    const result = await breaker.execute(chatFn);
    return { result, tlsFingerprintUsed: false };
  };

  while (true) {
    const attemptStartedAt = Date.now();
    try {
      const execution = await executeOnce();
      if (activeProxyInfo?.source === "oneproxy-rotation" && execution.result?.success !== false) {
        await markRotatingProxySucceeded(activeProxyInfo.proxy, {
          latencyMs: Date.now() - attemptStartedAt,
        });
      }
      return { ...execution, proxyInfo: activeProxyInfo };
    } catch (cbErr: any) {
      if (cbErr instanceof CircuitBreakerOpenError) {
        log.warn("CIRCUIT", `${provider} circuit open during retry: ${cbErr.message}`);
        return {
          result: {
            success: false,
            response: providerCircuitOpenResponse(provider, Math.ceil(cbErr.retryAfterMs / 1000)),
            status: HTTP_STATUS.SERVICE_UNAVAILABLE,
          },
          tlsFingerprintUsed: false,
          proxyInfo: activeProxyInfo,
        };
      }

      if (!isProxyUnreachableError(cbErr)) {
        throw cbErr;
      }

      const detail = cbErr?.message || "Proxy unreachable";
      log.warn("PROXY", detail);

      if (activeProxyInfo?.source !== "oneproxy-rotation") {
        return {
          result: {
            success: false,
            response: unavailableResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, detail, 2),
            status: HTTP_STATUS.SERVICE_UNAVAILABLE,
            error: detail,
          },
          tlsFingerprintUsed: false,
          proxyInfo: activeProxyInfo,
        };
      }

      const failedProxyId = getRotatingProxyId(activeProxyInfo);
      if (failedProxyId) excludedRotatingProxyIds.add(failedProxyId);
      await markRotatingProxyFailed(activeProxyInfo.proxy, cbErr);

      if (!credentials.connectionId || rotatingProxyAttempt >= maxRotatingProxyAttempts) {
        return {
          result: {
            success: false,
            response: unavailableResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, detail, 2),
            status: HTTP_STATUS.SERVICE_UNAVAILABLE,
            error: detail,
          },
          tlsFingerprintUsed: false,
          proxyInfo: activeProxyInfo,
        };
      }

      const nextProxyInfo = await safeResolveProxy(credentials.connectionId, {
        excludeRotatingProxyIds: Array.from(excludedRotatingProxyIds),
        stickyContext,
      });

      if (nextProxyInfo?.source === "proxy-policy" && nextProxyInfo.error) {
        return {
          result: {
            success: false,
            response: unavailableResponse(
              nextProxyInfo.status || HTTP_STATUS.SERVICE_UNAVAILABLE,
              nextProxyInfo.error,
              2
            ),
            status: nextProxyInfo.status || HTTP_STATUS.SERVICE_UNAVAILABLE,
            error: nextProxyInfo.error,
          },
          tlsFingerprintUsed: false,
          proxyInfo: activeProxyInfo,
        };
      }

      if (nextProxyInfo?.source !== "oneproxy-rotation" || !nextProxyInfo.proxy) {
        return {
          result: {
            success: false,
            response: unavailableResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, detail, 2),
            status: HTTP_STATUS.SERVICE_UNAVAILABLE,
            error: detail,
          },
          tlsFingerprintUsed: false,
          proxyInfo: activeProxyInfo,
        };
      }

      rotatingProxyAttempt += 1;
      activeProxyInfo = nextProxyInfo;
      log.warn(
        "PROXY",
        `Retrying with next rotating proxy (${rotatingProxyAttempt}/${maxRotatingProxyAttempts})`
      );
    }
  }
}

export function handleNoCredentials(
  credentials: any,
  excludeConnectionId: string | null,
  provider: string,
  model: string,
  lastError: string | null,
  lastStatus: number | null
) {
  if (credentials?.allRateLimited) {
    const errorMsg = lastError || credentials.lastError || "Unavailable";
    const status =
      lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
    const cooldownModel =
      typeof credentials.cooldownModel === "string" && credentials.cooldownModel.trim().length > 0
        ? credentials.cooldownModel.trim()
        : model;

    if (credentials.cooldownScope === "model" && Number(status) === HTTP_STATUS.RATE_LIMITED) {
      log.warn(
        "CHAT",
        `[${provider}/${cooldownModel}] all credentials cooling down${
          credentials.retryAfterHuman ? ` (${credentials.retryAfterHuman})` : ""
        }`
      );
      return modelCooldownResponse({
        model: cooldownModel,
        retryAfter: credentials.retryAfter,
      });
    }

    log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
    return unavailableResponse(
      status,
      `[${provider}/${model}] ${errorMsg}`,
      credentials.retryAfter,
      credentials.retryAfterHuman
    );
  }
  if (lastError && lastStatus) {
    log.warn("CHAT", "Preserving last upstream error after credential exhaustion", {
      provider,
      model,
      lastStatus,
    });
    return errorResponse(lastStatus, lastError);
  }
  if (!excludeConnectionId) {
    log.error("AUTH", `No credentials for provider: ${provider}`);
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
  }
  log.warn("CHAT", "No more accounts available", { provider });
  return errorResponse(
    lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE,
    lastError || "All accounts unavailable"
  );
}

export async function safeResolveProxy(
  connectionId: string,
  options: {
    excludeRotatingProxyIds?: string[];
    stickyContext?: {
      sessionId?: string | null;
      apiKeyId?: string | null;
      provider?: string | null;
      connectionId?: string | null;
    };
  } = {}
) {
  try {
    return await resolveProxyForConnection(connectionId, options);
  } catch (proxyErr: any) {
    if (isRotatingProxyRequiredError(proxyErr)) {
      log.warn("PROXY", proxyErr.message);
      return {
        proxy: null,
        level: "rotating-required",
        levelId: connectionId,
        source: "proxy-policy",
        status: proxyErr.status || HTTP_STATUS.SERVICE_UNAVAILABLE,
        error: proxyErr.message,
        policy: proxyErr.policy || null,
      };
    }
    log.debug("PROXY", `Failed to resolve proxy: ${proxyErr.message}`);
    return null;
  }
}

export function safeLogEvents({
  result,
  proxyInfo,
  proxyLatency,
  provider,
  model,
  sourceFormat,
  targetFormat,
  credentials,
  comboName,
  clientRawRequest,
  tlsFingerprintUsed = false,
}) {
  try {
    const rawIp =
      clientRawRequest?.headers?.["x-forwarded-for"] ||
      clientRawRequest?.headers?.["x-real-ip"] ||
      clientRawRequest?.headers?.["cf-connecting-ip"] ||
      null;
    const publicIp = rawIp ? rawIp.split(",")[0].trim() : null;

    logProxyEvent({
      status: result.success
        ? "success"
        : result.status === 408 || result.status === 504
          ? "timeout"
          : "error",
      proxy: proxyInfo?.proxy || null,
      level: proxyInfo?.level || "direct",
      levelId: proxyInfo?.levelId || null,
      provider,
      targetUrl: `${provider}/${model}`,
      publicIp,
      latencyMs: proxyLatency,
      error: result.success ? null : result.error || null,
      connectionId: credentials.connectionId,
      comboId: comboName || null,
      account: credentials.connectionId?.slice(0, 8) || null,
      tlsFingerprint: tlsFingerprintUsed,
    });
  } catch {}

  try {
    logTranslationEvent({
      provider,
      model,
      sourceFormat,
      targetFormat,
      status: result.success ? "success" : "error",
      statusCode: result.success ? 200 : result.status || 500,
      latency: proxyLatency,
      endpoint: clientRawRequest?.endpoint || "/v1/chat/completions",
      connectionId: credentials.connectionId || null,
      comboName: comboName || null,
    });
  } catch {}
}

export function withSessionHeader(response: Response, sessionId: string | null): Response {
  if (!response || !sessionId) return response;

  try {
    response.headers.set("X-OmniRoute-Session-Id", sessionId);
    return response;
  } catch {
    const cloned = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    cloned.headers.set("X-OmniRoute-Session-Id", sessionId);
    return cloned;
  }
}
