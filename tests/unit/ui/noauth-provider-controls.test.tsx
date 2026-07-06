// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const noAuthAccountCardSpy = vi.fn();
const noAuthProviderCardSpy = vi.fn();
const notifySuccess = vi.fn();
const notifyError = vi.fn();

vi.mock("@/shared/components", () => ({
  NoAuthAccountCard: (props: Record<string, unknown>) => {
    noAuthAccountCardSpy(props);
    return (
      <div
        data-testid="noauth-account-card"
        data-allow-delete-all={String(Boolean(props.allowDeleteAll))}
        data-enhanced-mode={String(Boolean(props.enhancedMode))}
      />
    );
  },
  NoAuthProviderCard: (props: Record<string, unknown>) => {
    noAuthProviderCardSpy(props);
    return <div data-testid="noauth-provider-card" data-enabled={String(Boolean(props.enabled))} />;
  },
}));

vi.mock("@/shared/constants/providers", () => ({
  getProviderAlias: (providerId: string) => providerId,
}));

vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: () => ({
    success: notifySuccess,
    error: notifyError,
  }),
}));

const { default: NoAuthProviderControls } =
  await import("../../../src/app/(dashboard)/dashboard/providers/[id]/components/NoAuthProviderControls");

const containers: Array<{ root: ReturnType<typeof createRoot>; el: HTMLDivElement }> = [];

async function renderComponent(providerId: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ blockedProviders: [] }),
      } as Response)
    )
  );

  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  containers.push({ root, el });

  await act(async () => {
    root.render(<NoAuthProviderControls providerId={providerId} providerName={providerId} />);
  });

  await act(async () => {
    await Promise.resolve();
  });

  return el;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const { root, el } of containers.splice(0)) {
    act(() => root.unmount());
    el.remove();
  }
  vi.unstubAllGlobals();
});

describe("NoAuthProviderControls", () => {
  it("re-enables bulk account management for mimocode", async () => {
    const el = await renderComponent("mimocode");

    const card = el.querySelector<HTMLElement>("[data-testid='noauth-account-card']");
    expect(card).toBeTruthy();
    expect(card?.dataset.allowDeleteAll).toBe("true");
    expect(card?.dataset.enhancedMode).toBe("true");
  });

  it("keeps the account card path for opencode with bulk account management enabled", async () => {
    const el = await renderComponent("opencode");

    const card = el.querySelector<HTMLElement>("[data-testid='noauth-account-card']");
    expect(card).toBeTruthy();
    expect(card?.dataset.allowDeleteAll).toBe("true");
    expect(card?.dataset.enhancedMode).toBe("true");
  });

  it("falls back to the plain no-auth provider card for non-account providers", async () => {
    const el = await renderComponent("some-free-provider");

    expect(el.querySelector("[data-testid='noauth-provider-card']")).toBeTruthy();
    expect(el.querySelector("[data-testid='noauth-account-card']")).toBeFalsy();
  });
});
