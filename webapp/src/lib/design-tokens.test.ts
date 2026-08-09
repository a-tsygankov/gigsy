/**
 * Adherence tests for the design-token layer (docs/design-system.md).
 *
 * The token CSS files are copied verbatim from the Gigsy Design System
 * project and are the canonical values; the app's Tailwind utilities
 * resolve to Tailwind's default palette/scale, which the design system
 * was lifted from. These tests pin that equivalence so neither side
 * can drift without failing the suite.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import colors from "tailwindcss/colors";

const tokensDir = fileURLToPath(new URL("../styles/tokens/", import.meta.url));

function cssVars(file: string): Record<string, string> {
  const css = readFileSync(tokensDir + file, "utf8");
  const vars: Record<string, string> = {};
  for (const [, name, value] of css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    if (name !== undefined && value !== undefined) {
      vars[name] = value.trim().replace(/\s*\/\*.*?\*\/\s*$/, "");
    }
  }
  return vars;
}

describe("design tokens", () => {
  const palette = cssVars("colors.css");

  it("palette steps equal Tailwind's default palette", () => {
    for (const [name, value] of Object.entries(palette)) {
      if (name === "--white") {
        expect(value).toBe("#ffffff");
        continue;
      }
      const m = /^--([a-z]+)-(\d+)$/.exec(name);
      expect(m, `unexpected token name ${name}`).not.toBeNull();
      const hue = m![1]!;
      const step = m![2]!;
      const tailwind = (colors as unknown as Record<string, Record<string, string>>)[
        hue
      ]?.[step];
      expect(value.toLowerCase(), `${name} vs tailwind ${hue}-${step}`).toBe(
        tailwind?.toLowerCase(),
      );
    }
  });

  it("semantic aliases only reference defined palette tokens", () => {
    const semantic = cssVars("semantic.css");
    expect(Object.keys(semantic).length).toBeGreaterThan(0);
    for (const [name, value] of Object.entries(semantic)) {
      for (const m of value.matchAll(/var\((--[\w-]+)\)/g)) {
        const ref = m[1]!;
        expect(palette[ref], `${name} references undefined ${ref}`).toBeDefined();
      }
    }
  });

  it("core aliases the components consume are present", () => {
    const semantic = cssVars("semantic.css");
    for (const required of [
      "--bg-app",
      "--surface-card",
      "--accent",
      "--accent-hover",
      "--accent-ring",
      "--border-default",
      "--border-strong",
      "--text-strong",
      "--text-muted",
      "--danger-text",
      "--status-lead-bg",
      "--status-confirmed-bg",
      "--status-completed-bg",
      "--status-paid-bg",
    ]) {
      expect(semantic[required], `missing ${required}`).toBeDefined();
    }
  });

  it("radius, spacing, and type scales match the utilities the app uses", () => {
    expect(cssVars("radius.css")["--radius-xl"]).toBe("12px"); // rounded-xl
    expect(cssVars("radius.css")["--radius-full"]).toBe("9999px"); // rounded-full
    const space = cssVars("spacing.css");
    expect(space["--space-4"]).toBe("16px"); // p-4 — card and screen padding
    expect(space["--space-3"]).toBe("12px"); // gap-3 — list gap
    expect(space["--screen-max"]).toBe("32rem"); // max-w-lg — screen column
    expect(space["--fab-size"]).toBe("56px"); // h-14 w-14
    const type = cssVars("typography.css");
    expect(type["--text-base"]).toBe("16px"); // inputs — iOS no-zoom floor
    expect(type["--text-sm"]).toBe("14px");
    expect(type["--text-xs"]).toBe("12px");
    expect(type["--tracking-tight"]).toBe("-0.025em");
  });

  it("motion never exceeds the 200ms ceiling", () => {
    const motion = cssVars("motion.css");
    expect(motion["--duration-fast"]).toBe("150ms");
    expect(motion["--duration"]).toBe("200ms");
    expect(motion["--ease"]).toBe("cubic-bezier(0.4,0,0.2,1)");
  });
});
