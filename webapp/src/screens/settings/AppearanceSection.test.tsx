/** @vitest-environment jsdom */
/**
 * The theme control, rendered: what a tap writes, what survives leaving
 * the screen, and what the screen reads back on its next visit. Until
 * this file existed the control had no render test at all, and the
 * bug it would have half-caught (the theme not surviving a reload) was
 * really the boot path's — see lib/index-html.test.ts — but the two
 * halves of "it stays dark" belong together here.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceSection } from "./AppearanceSection.tsx";
import { THEME_COLORS, THEME_STORAGE_KEY } from "../../lib/theme.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let prefersDark = false;

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.head.querySelector('meta[name="theme-color"]')?.remove();
  const meta = document.createElement("meta");
  meta.setAttribute("name", "theme-color");
  meta.setAttribute("content", THEME_COLORS.light);
  document.head.appendChild(meta);
  // jsdom has no matchMedia. The section reads `.matches` and adds a
  // change listener while the choice is "system".
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      get matches() {
        return prefersDark;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = () => act(() => root.render(<AppearanceSection />));
const radio = (value: string) =>
  container.querySelector<HTMLButtonElement>(`[data-testid="theme-${value}"]`)!;
const themeOn = () => document.documentElement.getAttribute("data-theme");
const chrome = () => document.head.querySelector('meta[name="theme-color"]')?.getAttribute("content");

describe("AppearanceSection", () => {
  it("offers System, Light and Dark, with System checked when nothing is stored", async () => {
    await render();
    expect(radio("system").getAttribute("aria-checked")).toBe("true");
    expect(radio("light").getAttribute("aria-checked")).toBe("false");
    expect(radio("dark").getAttribute("aria-checked")).toBe("false");
  });

  it("stores Dark, applies it to <html> and the chrome colour, at once", async () => {
    await render();
    await act(async () => radio("dark").click());
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(themeOn()).toBe("dark");
    expect(chrome()).toBe(THEME_COLORS.dark);
    expect(radio("dark").getAttribute("aria-checked")).toBe("true");
  });

  it("keeps the theme when the screen is left", async () => {
    await render();
    await act(async () => radio("dark").click());
    act(() => root.unmount());
    root = createRoot(container);
    expect(themeOn()).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("reads the stored choice back on its next visit", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    await render();
    expect(radio("dark").getAttribute("aria-checked")).toBe("true");
    expect(themeOn()).toBe("dark");
  });

  it("lets Light win over a dark device, and System follow it", async () => {
    prefersDark = true;
    await render();
    expect(themeOn()).toBe("dark"); // system, on a dark device
    await act(async () => radio("light").click());
    expect(themeOn()).toBe("light");
    expect(chrome()).toBe(THEME_COLORS.light);
    await act(async () => radio("system").click());
    expect(themeOn()).toBe("dark");
    prefersDark = false;
  });
});
