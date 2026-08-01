import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import { getApiKeyMetadata, validateApiKey } from "@/lib/db/apiKeys";
import { extractApiKey } from "@/sse/services/auth";
import { isDashboardSessionAuthenticated } from "@/shared/utils/apiAuth";
import { isRequireApiKeyEnabled } from "@/shared/utils/featureFlags";

/**
 * Direct API-key guard for /v1 route handlers.
 *
 * The authz proxy normally enforces this before the handler runs. Keeping a
 * small handler-side check avoids anonymous fallback if a deployment path or
 * direct route invocation bypasses the proxy.
 */
export async function enforceClientApiAuth(request: Request): Promise<Response | null> {
  const apiKey = extractApiKey(request);

  if (!apiKey) {
    if (isRequireApiKeyEnabled() && !(await isDashboardSessionAuthenticated(request))) {
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Authentication required");
    }
    return null;
  }

  try {
    const metadata = await getApiKeyMetadata(apiKey);
    if (!metadata) {
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
    if (metadata.isActive === false) {
      return errorResponse(HTTP_STATUS.FORBIDDEN, "This API key is disabled");
    }
    if (metadata.isBanned === true) {
      return errorResponse(
        HTTP_STATUS.FORBIDDEN,
        "This API key is banned due to policy violations"
      );
    }
    if (metadata.revokedAt) {
      return errorResponse(HTTP_STATUS.FORBIDDEN, "This API key has been revoked");
    }
    if (metadata.expiresAt) {
      const expiry = new Date(metadata.expiresAt).getTime();
      if (Number.isFinite(expiry) && Date.now() > expiry) {
        return errorResponse(HTTP_STATUS.FORBIDDEN, "This API key has expired");
      }
    }
    if (!(await validateApiKey(apiKey))) {
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  } catch {
    return errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, "API key authentication unavailable");
  }

  return null;
}
