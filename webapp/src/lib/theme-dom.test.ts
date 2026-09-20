/** @vitest-environment jsdom */
/**
 * `applyTheme` against a real document (theme.test.ts runs under node
 * with hand-rolled fakes): the theme-color tag ends up as ONE tag, a
 * DIFFERENT node, carrying the new colour. The reason for the swap is
 * in applyTheme's comment — the installed iOS app kept the launch
 * colour across an in-place edit.
 */
import { describe, expect, it } from "vitest";
import { applyTheme, THEME_COLORS } from "./theme.ts";

describe("applyTheme on a real document", () => {
  it("leaves one theme-color tag, a different node, with the new colour", () => {
    const head = document.head;
    head.querySelectorAll('meta[name="theme-color"]').forEach((n) => n.remove());
    const original = document.createElement("meta");
    original.setAttribute("name", "theme-color");
    original.setAttribute("content", "#f8fafc");
    head.appendChild(original);

    applyTheme(document, "dark");

    const tags = head.querySelectorAll('meta[name="theme-color"]');
    expect(tags).toHaveLength(1);
    expect(tags[0]!.getAttribute("content")).toBe(THEME_COLORS.dark);
    expect(tags[0]).not.toBe(original);
    expect(original.isConnected).toBe(false);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    // And back again, through the node it just made.
    applyTheme(document, "light");
    const again = head.querySelectorAll('meta[name="theme-color"]');
    expect(again).toHaveLength(1);
    expect(again[0]!.getAttribute("content")).toBe(THEME_COLORS.light);
    again[0]!.remove();
  });
});
