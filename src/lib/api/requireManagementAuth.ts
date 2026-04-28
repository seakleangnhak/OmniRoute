import {
  hasBearerToken,
  isAuthRequired,
  isDashboardSessionAuthenticated,
  isManagementBearerTokenAuthenticated,
} from "@/shared/utils/apiAuth";
import { createErrorResponse } from "@/lib/api/errorResponse";

export async function requireManagementAuth(request: Request): Promise<Response | null> {
  if (!(await isAuthRequired())) {
    return null;
  }

  if (await isDashboardSessionAuthenticated(request)) {
    return null;
  }

  if (isManagementBearerTokenAuthenticated(request)) {
    return null;
  }

  const bearerTokenPresent = hasBearerToken(request);

  return createErrorResponse({
    status: bearerTokenPresent ? 403 : 401,
    message: bearerTokenPresent ? "Invalid management token" : "Authentication required",
    type: "invalid_request",
  });
}
