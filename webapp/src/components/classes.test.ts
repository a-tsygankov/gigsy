/**
 * Unit tests for the design-system class recipes
 * (docs/design-system.md). The builders are pure functions so the
 * variant/size matrix is testable without a DOM; rendering is covered
 * by the Playwright suite.
 */
import { describe, it, expect } from "vitest";
import { buttonClasses } from "./Button.tsx";
import { cardClasses } from "./Card.tsx";
import { inputShellClasses, textareaClasses } from "./Input.tsx";
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

describe("status + tone maps", () => {
  it("covers the full gig lifecycle", () => {
    expect(Object.keys(STATUS_PILL_CLASSES).sort()).toEqual([
      "completed",
      "confirmed",
      "lead",
      "paid",
    ]);
    expect(STATUS_PILL_CLASSES.paid).toContain("emerald");
    expect(STATUS_PILL_CLASSES.confirmed).toContain("sky");
    expect(STATUS_PILL_CLASSES.completed).toContain("amber");
    expect(STATUS_PILL_CLASSES.lead).toContain("slate");
  });

  it("tile tones map to the money semantics", () => {
    expect(TILE_TONE_CLASSES.good).toContain("emerald");
    expect(TILE_TONE_CLASSES.warn).toContain("amber");
    expect(TILE_TONE_CLASSES.neutral).toContain("slate-900");
  });
});
