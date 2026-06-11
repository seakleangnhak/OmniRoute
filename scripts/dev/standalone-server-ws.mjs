import http from "node:http";
import { randomUUID } from "node:crypto";
import { createResponsesWsProxy } from "./responses-ws-proxy.mjs";
import { createOmnirouteWsBridge } from "./v1-ws-bridge.mjs";
import { ensurePeerStampToken, wrapRequestListenerWithPeerStamp } from "./peer-stamp.mjs";

const originalCreateServer = http.createServer.bind(http);
const bridgesByPort = new Map();

process.env.OMNIROUTE_WS_BRIDGE_SECRET ||= randomUUID();
// Per-process secret proving the trusted peer-IP stamp came from this server.
ensurePeerStampToken();

function getPort(server) {
  const address = server.address?.();
  if (address && typeof address === "object" && typeof address.port === "number") {
    return address.port;
  }
  const rawPort = process.env.PORT || process.env.DASHBOARD_PORT || "3000";
  const parsed = Number.parseInt(rawPort, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3000;
}

function getBridges(server) {
  const port = getPort(server);
  const existing = bridgesByPort.get(port);
  if (existing) return existing;

  const baseUrl = `http://127.0.0.1:${port}`;
  const bridges = {
    responsesWsProxy: createResponsesWsProxy({
      baseUrl,
      bridgeSecret: process.env.OMNIROUTE_WS_BRIDGE_SECRET,
    }),
    v1WsBridge: createOmnirouteWsBridge({
      baseUrl,
    }),
  };
  bridgesByPort.set(port, bridges);
  return bridges;
}

async function handleStandaloneUpgrade(server, req, socket, head) {
  const { responsesWsProxy, v1WsBridge } = getBridges(server);
  const responsesWsHandled = await responsesWsProxy.handleUpgrade(req, socket, head);
  if (responsesWsHandled) return true;

  return v1WsBridge.handleUpgrade(req, socket, head);
}

function attachFallbackUpgradeHandler(server) {
  server.once("listening", () => {
    if (server.listenerCount("upgrade") > 0) return;

    server.on("upgrade", async (req, socket, head) => {
      try {
        const handled = await handleStandaloneUpgrade(server, req, socket, head);
        if (!handled && !socket.destroyed) {
          socket.destroy();
        }
      } catch (error) {
        if (!socket.destroyed) {
          socket.destroy(error instanceof Error ? error : undefined);
        }
        console.error("[Standalone WS] Upgrade handling failed:", error);
      }
    });
  });
}

function wrapUpgradeListener(server, listener) {
  return async function standaloneWsAwareUpgrade(req, socket, head) {
    try {
      const handled = await handleStandaloneUpgrade(server, req, socket, head);
      if (handled) return;
      return listener.call(this, req, socket, head);
    } catch (error) {
      if (!socket.destroyed) {
        socket.destroy(error instanceof Error ? error : undefined);
      }
      console.error("[Standalone WS] Upgrade handling failed:", error);
    }
  };
}

http.createServer = function createServerWithResponsesWs(...args) {
  // Next's standalone server.js may pass its request listener directly to
  // createServer; wrap it so the real TCP peer IP is stamped before Next runs.
  const lastFnIdx = args.map((a) => typeof a === "function").lastIndexOf(true);
  if (lastFnIdx >= 0) {
    args[lastFnIdx] = wrapRequestListenerWithPeerStamp(args[lastFnIdx]);
  }

  const server = originalCreateServer(...args);
  attachFallbackUpgradeHandler(server);

  const originalOn = server.on.bind(server);
  const originalAddListener = server.addListener.bind(server);

  server.on = function patchedOn(eventName, listener) {
    if (eventName === "upgrade" && typeof listener === "function") {
      return originalOn(eventName, wrapUpgradeListener(server, listener));
    }
    // …or it may attach the handler via server.on("request"): wrap that too.
    if (eventName === "request" && typeof listener === "function") {
      return originalOn(eventName, wrapRequestListenerWithPeerStamp(listener));
    }
    return originalOn(eventName, listener);
  };

  server.addListener = function patchedAddListener(eventName, listener) {
    if (eventName === "upgrade" && typeof listener === "function") {
      return originalAddListener(eventName, wrapUpgradeListener(server, listener));
    }
    if (eventName === "request" && typeof listener === "function") {
      return originalAddListener(eventName, wrapRequestListenerWithPeerStamp(listener));
    }
    return originalAddListener(eventName, listener);
  };

  return server;
};

await import("./server.js");
