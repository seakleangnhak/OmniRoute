// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cleanupCallbacks: Array<() => void> = [];

function makeContainer(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  cleanupCallbacks.push(() => {
    container.remove();
  });
  return container;
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  } as unknown as Response;
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("NoAuthAccountCard", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    while (cleanupCallbacks.length > 0) {
      cleanupCallbacks.pop()?.();
    }
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("creates a separate connection row when adding a no-auth account", async () => {
    const { default: NoAuthAccountCard } = await import("@/shared/components/NoAuthAccountCard");
    const onConnectionsChanged = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ connections: [] }))
      .mockResolvedValueOnce(jsonResponse({ id: "conn-1" }, true))
      .mockResolvedValueOnce(
        jsonResponse({
          connections: [
            {
              id: "conn-1",
              provider: "mimocode",
              providerSpecificData: { fingerprints: ["fingerprint-1"] },
            },
          ],
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const container = makeContainer();
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <NoAuthAccountCard
          providerId="mimocode"
          providerName="MiMoCode"
          generateAccountId={() => "fingerprint-1"}
          onConnectionsChanged={onConnectionsChanged}
        />
      );
    });
    await flushEffects();

    const addButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Add Account")
    );
    expect(addButton).toBeTruthy();

    await act(async () => {
      addButton?.click();
    });
    await flushEffects();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/providers",
      expect.objectContaining({ method: "POST" })
    );
    const postCall = fetchMock.mock.calls.find(
      ([url, init]) => url === "/api/providers" && (init as RequestInit | undefined)?.method
    );
    expect(postCall).toBeTruthy();
    expect(JSON.parse(String((postCall?.[1] as RequestInit).body))).toEqual({
      provider: "mimocode",
      name: "MiMoCode Account fingerpr",
      testStatus: "active",
      providerSpecificData: { fingerprints: ["fingerprint-1"] },
    });
    expect(container.textContent).toContain("Accounts (1)");
    expect(onConnectionsChanged).toHaveBeenCalledTimes(1);
  });

  it("deletes the connection row when removing a one-account no-auth connection", async () => {
    const { default: NoAuthAccountCard } = await import("@/shared/components/NoAuthAccountCard");
    const onConnectionsChanged = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          connections: [
            {
              id: "conn-1",
              provider: "mimocode",
              providerSpecificData: { fingerprints: ["fingerprint-1"] },
            },
          ],
        })
      )
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(
        jsonResponse({
          connections: [],
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const container = makeContainer();
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <NoAuthAccountCard
          providerId="mimocode"
          providerName="MiMoCode"
          generateAccountId={() => "unused"}
          onConnectionsChanged={onConnectionsChanged}
        />
      );
    });
    await flushEffects();

    expect(container.textContent).toContain("Accounts (1)");
    const removeButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Remove")
    );
    expect(removeButton).toBeTruthy();

    await act(async () => {
      removeButton?.click();
    });
    await flushEffects();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/providers/conn-1",
      expect.objectContaining({ method: "DELETE" })
    );
    expect(container.textContent).toContain("Accounts (0)");
    expect(onConnectionsChanged).toHaveBeenCalledTimes(1);
  });

  it("updates legacy multi-fingerprint rows when removing one account", async () => {
    const { default: NoAuthAccountCard } = await import("@/shared/components/NoAuthAccountCard");
    const onConnectionsChanged = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          connections: [
            {
              id: "conn-legacy",
              provider: "mimocode",
              providerSpecificData: { fingerprints: ["fingerprint-1", "fingerprint-2"] },
            },
          ],
        })
      )
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(
        jsonResponse({
          connections: [
            {
              id: "conn-legacy",
              provider: "mimocode",
              providerSpecificData: { fingerprints: ["fingerprint-2"] },
            },
          ],
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const container = makeContainer();
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <NoAuthAccountCard
          providerId="mimocode"
          providerName="MiMoCode"
          generateAccountId={() => "unused"}
          onConnectionsChanged={onConnectionsChanged}
        />
      );
    });
    await flushEffects();

    expect(container.textContent).toContain("Accounts (2)");
    const removeButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Remove")
    );

    await act(async () => {
      removeButton?.click();
    });
    await flushEffects();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/providers/conn-legacy",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          providerSpecificData: { fingerprints: ["fingerprint-2"] },
        }),
      })
    );
    expect(container.textContent).toContain("Accounts (1)");
    expect(onConnectionsChanged).toHaveBeenCalledTimes(1);
  });
});
