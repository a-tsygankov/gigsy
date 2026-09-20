/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GigDefaultsSection } from "./GigDefaultsSection.tsx";

const update = vi.fn();
let settings: Record<string, unknown> | undefined;

// The hook, not the data service: this section's contract is "which
// key does each control write", and the hook's optimistic-update
// plumbing is useSettings' own concern (same shape as
// BusinessSection.test.tsx).
vi.mock("./useSettings.ts", () => ({
  useSettings: () => ({ settings, update, isSaving: false }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  update.mockReset();
  settings = {
    defaultGigDurationMinutes: null,
    currency: "USD",
    clientsExpectDelivery: false,
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = () => act(() => root.render(<GigDefaultsSection />));
const toggle = () =>
  container.querySelector<HTMLInputElement>('[data-testid="toggle-clients-delivery"]');

describe("GigDefaultsSection — clients expect delivery", () => {
  it("shows the row the help scenario and the e2e spec point at", () => {
    render();
    expect(container.querySelector('[data-testid="settings-clients-delivery"]')).not.toBeNull();
    expect(toggle()?.checked).toBe(false);
  });

  it("reflects a stored true", () => {
    settings = { ...settings, clientsExpectDelivery: true };
    render();
    expect(toggle()?.checked).toBe(true);
  });

  it("writes clientsExpectDelivery, and only that key, when flipped", () => {
    render();
    act(() => toggle()!.click());
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ clientsExpectDelivery: true });
  });

  it("writes false when flipped back off", () => {
    settings = { ...settings, clientsExpectDelivery: true };
    render();
    act(() => toggle()!.click());
    expect(update).toHaveBeenCalledWith({ clientsExpectDelivery: false });
  });
});
