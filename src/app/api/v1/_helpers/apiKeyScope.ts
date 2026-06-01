import { getApiKeyMetadata } from "@/lib/db/apiKeys";
import { extractApiKey } from "@/sse/services/auth";
import { isDashboardSessionAuthenticated } from "@/shared/utils/apiAuth";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";

export interface ApiKeyRequestScope {
  apiKey: string | null;
  apiKeyId: string | null;
  apiKeyMetadata: Awaited<ReturnType<typeof getApiKeyMetadata>>;
  rejection: Response | null;
  isSessionAuth: boolean;
}

export async function getApiKeyRequestScope(request: Request): Promise<ApiKeyRequestScope> {
  const isSessionAuth = await isDashboardSessionAuthenticated(request);
  const apiKey = extractApiKey(request);
  if (!apiKey) {
    const rejection =
      process.env.REQUIRE_API_KEY === "true" && !isSessionAuth
        ? errorResponse(HTTP_STATUS.UNAUTHORIZED, "Authentication required")
        : null;
    return { apiKey: null, apiKeyId: null, apiKeyMetadata: null, rejection, isSessionAuth };
  }

  let apiKeyMetadata: Awaited<ReturnType<typeof getApiKeyMetadata>>;
  try {
    apiKeyMetadata = await getApiKeyMetadata(apiKey);
  } catch {
    return {
      apiKey,
      apiKeyId: null,
      apiKeyMetadata: null,
      rejection: errorResponse(
        HTTP_STATUS.SERVICE_UNAVAILABLE,
        "API key authentication unavailable"
      ),
      isSessionAuth,
    };
  }

  if (!apiKeyMetadata) {
    return {
      apiKey,
      apiKeyId: null,
      apiKeyMetadata: null,
      rejection: errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key"),
      isSessionAuth,
    };
  }

  if (apiKeyMetadata.isActive === false) {
    return {
      apiKey,
      apiKeyId: apiKeyMetadata.id || null,
      apiKeyMetadata,
      rejection: errorResponse(HTTP_STATUS.FORBIDDEN, "This API key is disabled"),
      isSessionAuth,
    };
  }

  if (apiKeyMetadata.isBanned === true) {
    return {
      apiKey,
      apiKeyId: apiKeyMetadata.id || null,
      apiKeyMetadata,
      rejection: errorResponse(
        HTTP_STATUS.FORBIDDEN,
        "This API key is banned due to policy violations"
      ),
      isSessionAuth,
    };
  }

  if (apiKeyMetadata.revokedAt) {
    return {
      apiKey,
      apiKeyId: apiKeyMetadata.id || null,
      apiKeyMetadata,
      rejection: errorResponse(HTTP_STATUS.FORBIDDEN, "This API key has been revoked"),
      isSessionAuth,
    };
  }

  if (apiKeyMetadata.expiresAt) {
    const expiry = new Date(apiKeyMetadata.expiresAt).getTime();
    if (Number.isFinite(expiry) && Date.now() > expiry) {
      return {
        apiKey,
        apiKeyId: apiKeyMetadata.id || null,
        apiKeyMetadata,
        rejection: errorResponse(HTTP_STATUS.FORBIDDEN, "This API key has expired"),
        isSessionAuth,
      };
    }
  }

  return {
    apiKey,
    apiKeyId: apiKeyMetadata?.id || null,
    apiKeyMetadata,
    rejection: null,
    isSessionAuth,
  };
}
