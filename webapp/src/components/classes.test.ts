/**
 * Unit tests for the design-system class recipes
 * (docs/design-system.md). The builders are pure functions so the
 * variant/size matrix is testable without a DOM; rendering is covered
 * by the Playwright suite.
 */
import { describe, it, expect } from "vitest";
import { buttonClasses } from "./Button.tsx";
import { cardClasses } from "./Card.tsx";
import { inputShellClasses, shellWith, textareaClasses } from "./Input.tsx";
import { STATUS_PILL_CLASSES } from "./StatusPill.tsx";
import { TILE_TONE_CLASSES } from "./Tile.tsx";

describe("buttonClasses", () => {
  it("primary is the emerald fill with shadow lift and offset ring", () => {
    const cls = buttonClasses({});
    expect(cls).toContain("bg-emerald-600");
    expect(cls).toContain("font-semibold");
    expect(cls).toContain("text-on-accent");
    expect(cls).toContain("shadow-sm");
    expect(cls).toContain("hover:bg-accent-hover");
    expect(cls).toContain("hover:shadow");
    expect(cls).toContain("focus-visible:ring-emerald-500");
    expect(cls).toContain("focus-visible:ring-offset-2");
    expect(cls).toContain("rounded-xl");
    expect(cls).toContain("px-4 py-2 text-sm");
  });

  it("ghost is white with a slate border", () => {
    const cls = buttonClasses({ variant: "ghost" });
    expect(cls).toContain("border-slate-300");
    expect(cls).toContain("bg-white");
    expect(cls).toContain("text-slate-700");
    expect(cls).toContain("hover:bg-slate-100");
    expect(cls).not.toContain("bg-emerald-600");
  });

  it("danger is never a filled red button", () => {
    const cls = buttonClasses({ variant: "danger" });
    expect(cls).toContain("border-red-200");
    expect(cls).toContain("bg-white");
    expect(cls).toContain("text-red-600");
    expect(cls).toContain("hover:bg-red-50");
    expect(cls).toContain("focus-visible:ring-red-500");
    expect(cls).not.toContain("bg-red-600");
  });

  it("soft is the pale-emerald chip at 12px", () => {
    const cls = buttonClasses({ variant: "soft" });
    expect(cls).toContain("border-emerald-200");
    expect(cls).toContain("bg-emerald-50");
    expect(cls).toContain("text-emerald-700");
    expect(cls).toContain("hover:bg-emerald-100");
    expect(cls).toContain("px-3 py-2 text-xs");
  });

  it("sizes: sm compacts, lg is the form-footer height", () => {
    expect(buttonClasses({ size: "sm" })).toContain("px-2 py-1 text-xs");
    expect(buttonClasses({ size: "lg" })).toContain("px-4 py-3 text-sm");
  });

  it("block goes full width; extra classes append", () => {
    expect(buttonClasses({ block: true })).toContain("w-full");
    expect(buttonClasses({ className: "flex-1 mt-4" })).toMatch(/flex-1 mt-4$/);
  });

  it("disabled treatment is opacity, not a repaint", () => {
    const cls = buttonClasses({});
    expect(cls).toContain("disabled:opacity-50");
    expect(cls).toContain("disabled:pointer-events-none");
  });
});

describe("cardClasses", () => {
  it("base recipe: white, hairline, one radius, shadow-sm", () => {
    const cls = cardClasses({});
    expect(cls).toContain("rounded-xl");
    expect(cls).toContain("border-slate-200");
    expect(cls).toContain("bg-white");
    expect(cls).toContain("p-4");
    expect(cls).toContain("shadow-sm");
    expect(cls).not.toContain("hover:shadow");
  });

  it("interactive cards lift one shadow step on hover", () => {
    const cls = cardClasses({ interactive: true });
    expect(cls).toContain("transition-shadow");
    expect(cls).toContain("hover:shadow");
  });

  it("dense rows use the compact padding without a resting shadow", () => {
    const cls = cardClasses({ dense: true, interactive: true });
    expect(cls).toContain("px-3 py-2 text-sm");
    expect(cls).not.toContain("p-4");
    expect(cls).not.toContain("shadow-sm");
    expect(cls).toContain("hover:shadow");
  });
});

describe("input shells", () => {
  it("inputs are 16px so iOS Safari never zooms on focus", () => {
    expect(inputShellClasses).toContain("text-base");
    expect(inputShellClasses).toContain("rounded-xl");
    expect(inputShellClasses).toContain("border-slate-300");
    expect(inputShellClasses).toContain("focus-visible:ring-emerald-500");
    expect(inputShellClasses).toContain("focus-visible:border-emerald-500");
  });

  it("textarea defaults to the 96px minimum unless the caller sets one", () => {
    expect(textareaClasses()).toContain("min-h-24");
    expect(textareaClasses("min-h-20")).toContain("min-h-20");
    expect(textareaClasses("min-h-20")).not.toContain("min-h-24");
  });
});

/**
 * A caller's width has to actually win.
 *
 * Tailwind resolves two utilities of the same property by stylesheet
 * order, not by attribute order, so the shell's `w-full` silently beat
 * anything passed in. That shipped: the gig list's sort select stayed
 * full-width, refused to shrink, pushed the page wider than the
 * viewport, and broke clicks on the fixed tab bar — a layout bug that
 * presented as a navigation failure.
 */
describe("shellWith — the caller's width wins", () => {
  it("defaults to full width when the caller asks for nothing", () => {
    expect(shellWith("")).toContain("w-full");
  });

  it("drops the default when the caller sets a width", () => {
    const cls = shellWith("w-36");
    expect(cls).toContain("w-36");
    expect(cls).not.toContain("w-full");
  });

  it("keeps the default for a width that only applies from sm up", () => {
    // `sm:w-48` means "full width on a phone, 48 above it". Dropping
    // w-full would silently break the phone case.
    const cls = shellWith("sm:w-48");
    expect(cls).toContain("w-full");
    expect(cls).toContain("sm:w-48");
  });

  it("is not fooled by a class that merely starts with w", () => {
    expect(shellWith("whitespace-nowrap")).toContain("w-full");
  });

  it("leaves non-width classes alone", () => {
    // min-w-0 and flex-1 are not widths; the shell's own width still
    // applies, which is what a flex child usually wants.
    const cls = shellWith("min-w-0 flex-1");
    expect(cls).toContain("w-full");
    expect(cls).toContain("min-w-0");
    expect(cls).toContain("flex-1");
  });

  it("still carries the rest of the shell", () => {
    const cls = shellWith("w-28");
    expect(cls).toContain("rounded-xl");
    expect(cls).toContain("text-base");
    expect(cls).toContain("focus-visible:ring-emerald-500");
  });

  it("keeps inputShellClasses full-width for anyone still using it", () => {
    expect(inputShellClasses).toContain("w-full");
  });

  it("applies to textareas too", () => {
    expect(textareaClasses("w-32")).not.toContain("w-full");
    expect(textareaClasses("w-32")).toContain("w-32");
  });
});

describe("status + tone maps", () => {
  it("covers the full gig lifecycle", () => {
    expect(Object.keys(STATUS_PILL_CLASSES).sort()).toEqual([
      "cancelled",
      "completed",
      "confirmed",
      "lead",
    ]);
    expect(STATUS_PILL_CLASSES.cancelled).toContain("violet");
    expect(STATUS_PILL_CLASSES.confirmed).toContain("sky");
    expect(STATUS_PILL_CLASSES.completed).toContain("amber");
    expect(STATUS_PILL_CLASSES.lead).toContain("slate");
  });

  it("gives every status its own hue — colour is the only thing distinguishing them", () => {
    // `toContain("slate")` alone can't catch two statuses sharing a
    // colour; this extracts the actual bg-* utility from each class
    // string and checks the four are pairwise distinct.
    const hues = Object.values(STATUS_PILL_CLASSES).map(
      (cls) => cls.match(/bg-(\w+)-\d+/)?.[1],
    );
    expect(new Set(hues).size).toBe(hues.length);
  });

  it("tile tones map to the money semantics", () => {
    expect(TILE_TONE_CLASSES.good).toContain("emerald");
    expect(TILE_TONE_CLASSES.warn).toContain("amber");
    expect(TILE_TONE_CLASSES.neutral).toContain("slate-900");
  });
});
