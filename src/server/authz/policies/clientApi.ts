import { isDashboardSessionAuthenticated } from "@/shared/utils/apiAuth.ts";
import { isRequireApiKeyEnabled } from "@/shared/utils/featureFlags";
import { extractApiKey } from "@/sse/services/auth.ts";
import type { AuthOutcome, PolicyContext, RoutePolicy } from "../context";
import { allow, reject } from "../context";

const HANDSHAKE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isWsHandshake(ctx: PolicyContext): boolean {
  if (ctx.classification.normalizedPath !== "/api/v1/ws") return false;
  if (!HANDSHAKE_METHODS.has(ctx.request.method.toUpperCase())) return false;

  try {
    return new URL(ctx.request.url, "http://localhost").searchParams.get("handshake") === "1";
  } catch {
    return false;
  }
}

function maskKeyId(apiKey: string): string {
  const tail = apiKey.slice(-4);
  return `key_${tail}`;
}

export const clientApiPolicy: RoutePolicy = {
  routeClass: "CLIENT_API",
  async evaluate(ctx: PolicyContext): Promise<AuthOutcome> {
    const bearer = extractApiKey(ctx.request as Request);
    if (!bearer) {
      // The WS descriptor handshake is a metadata read; the route handler
      // performs the actual wsAuth/dashboard/API-key decision and returns the
      // protocol details the browser needs before opening the socket.
      if (isWsHandshake(ctx)) {
        return allow({ kind: "anonymous", id: "ws-handshake" });
      }

      if (await isDashboardSessionAuthenticated(ctx.request)) {
        return allow({ kind: "dashboard_session", id: "dashboard" });
      }

      if (!isRequireApiKeyEnabled()) {
        return allow({ kind: "anonymous", id: "local" });
      }

      return reject(401, "AUTH_002", "Authentication required");
    }

    const { validateApiKey } = await import("../../../lib/db/apiKeys");
    const ok = await validateApiKey(bearer);
    if (!ok) {
      return reject(401, "AUTH_002", "Invalid API key");
    }

    return allow({ kind: "client_api_key", id: maskKeyId(bearer) });
  },
};
