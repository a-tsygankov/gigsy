/**
 * Adherence tests for the design-token layer (docs/design-system.md).
 *
 * Phase 11 restated the palette as "R G B" channel triplets so Tailwind
 * can consume it as `rgb(var(--c-x) / <alpha-value>)` and one attribute
 * can re-theme the app. The guarantee is unchanged — the LIGHT values
 * still equal Tailwind's own — only the notation moved, so these tests
 * convert before comparing rather than relaxing.
 *
 * The token CSS files are copied verbatim from the Gigsy Design System
 * project and are the canonical values; the app's Tailwind utilities
 * resolve to Tailwind's default palette/scale, which the design system
 * was lifted from. These tests pin that equivalence so neither side
 * can drift without failing the suite.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import colors from "tailwindcss/colors";

const tokensDir = fileURLToPath(new URL("../styles/tokens/", import.meta.url));
const srcDir = fileURLToPath(new URL("../", import.meta.url));

/** Variables from a token file. `stopAt` truncates before a later
 *  block — colors.css now carries a dark override whose values would
 *  otherwise overwrite the light ones this test is about. */
function cssVars(file: string, stopAt?: string): Record<string, string> {
  const whole = readFileSync(tokensDir + file, "utf8");
  const cut = stopAt === undefined ? -1 : whole.indexOf(stopAt);
  const css = cut === -1 ? whole : whole.slice(0, cut);
  const vars: Record<string, string> = {};
  for (const [, name, value] of css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    if (name !== undefined && value !== undefined) {
      vars[name] = value.trim().replace(/\s*\/\*.*?\*\/\s*$/, "");
    }
  }
  return vars;
}

describe("design tokens", () => {
  const palette = cssVars("colors.css", '[data-theme="dark"]');

  /** "#f8fafc" -> "248 250 252", so hex and triplets compare directly. */
  function hexToTriplet(hex: string): string {
    const h = hex.replace("#", "");
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(" ");
  }

  it("palette steps equal Tailwind's default palette", () => {
    for (const [name, value] of Object.entries(palette)) {
      // The two tokens that exist because one palette step cannot serve
      // two jobs across themes; they have no Tailwind counterpart.
      if (name === "--c-on-accent" || name === "--c-accent-hover") continue;
      if (name === "--c-white") {
        expect(value).toBe("255 255 255");
        continue;
      }
      const m = /^--c-([a-z]+)-(\d+)$/.exec(name);
      expect(m, `unexpected token name ${name}`).not.toBeNull();
      const hue = m![1]!;
      const step = m![2]!;
      const tailwind = (colors as unknown as Record<string, Record<string, string>>)[
        hue
      ]?.[step];
      expect(tailwind, `no tailwind colour for ${hue}-${step}`).toBeDefined();
      expect(value, `${name} vs tailwind ${hue}-${step}`).toBe(
        hexToTriplet(tailwind!),
      );
    }
  });

  it("defines a dark value for every palette token", () => {
    // Every utility resolves through these, so one missing token is one
    // element rendering light-on-light in dark mode.
    const css = readFileSync(tokensDir + "colors.css", "utf8");
    const darkBlock = css.slice(css.indexOf('[data-theme="dark"]'));
    for (const name of Object.keys(palette)) {
      expect(darkBlock.includes(`${name}:`), `${name} has no dark value`).toBe(true);
    }
  });

  /**
   * `--c-slate-100` and `--c-white` are byte-identical in the dark
   * block ("30 41 59"), so the `lead` pill (StatusPill's
   * bg-slate-100) has no fill on a card in dark mode today — it is
   * literally the surface it sits on. This predates the
   * delivered-status work and fixing it is a separate decision for the
   * user, not something this test forces. The exemption is named
   * rather than a blanket skip so the bug stays recorded in code
   * instead of a review transcript.
   */
  const KNOWN_DARK_FILL_COLLISIONS = ["slate"];

  it("every -100 fill differs from the card surface in dark mode", () => {
    // The failure mode design-system.md and StatusPill.tsx both warn
    // about by name: a fill that resolves to the same RGB as the card
    // (`--c-white`) it sits on is invisible in that theme. "defines a
    // dark value for every palette token" above only proves a value
    // exists, not that it is distinguishable from the surface — this
    // is the assertion the Testing section of the delivered-status
    // design actually promised.
    const css = readFileSync(tokensDir + "colors.css", "utf8");
    const darkBlock = css.slice(css.indexOf('[data-theme="dark"]'));
    const darkVars: Record<string, string> = {};
    for (const [, name, value] of darkBlock.matchAll(/(--c-[\w-]+)\s*:\s*([^;]+);/g)) {
      if (name !== undefined && value !== undefined) {
        darkVars[name] = value.trim().replace(/\s*\/\*.*?\*\/\s*$/, "");
      }
    }
    const white = darkVars["--c-white"];
    expect(white, "--c-white has no dark value").toBeDefined();
    for (const name of Object.keys(palette)) {
      const m = /^--c-([a-z]+)-100$/.exec(name);
      if (m === null) continue;
      const hue = m[1]!;
      if (KNOWN_DARK_FILL_COLLISIONS.includes(hue)) continue;
      expect(darkVars[name], `${name} vs --c-white in dark mode`).not.toBe(white);
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


  /**
   * The failure this catches is invisible in light mode and total in
   * dark: an untokenised step (`text-red-700` when only red-50/200/500/
   * 600 are defined) falls through to Tailwind's literal hex, which
   * cannot invert. The screen then renders one element light-on-light,
   * and only on the theme nobody develops in. Four of these had already
   * accumulated across the app before this test existed.
   */
  it("every colour utility in the app resolves to a tokenised step", () => {
    const hues = "slate|emerald|sky|amber|red|violet|teal";
    const used = new Map<string, string[]>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = dir + entry;
        if (statSync(full).isDirectory()) {
          walk(full + "/");
          continue;
        }
        if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
        const source = readFileSync(full, "utf8");
        const pattern = new RegExp(`[a-z-]+-((?:${hues})-\\d{2,3})\\b`, "g");
        for (const [, step] of source.matchAll(pattern)) {
          const where = used.get(step!) ?? [];
          if (!where.includes(full)) where.push(full);
          used.set(step!, where);
        }
      }
    };
    walk(srcDir);

    expect(used.size).toBeGreaterThan(20); // the walk actually found source
    const orphans = [...used].filter(([step]) => palette[`--c-${step}`] === undefined);
    expect(
      orphans.map(([step, where]) => `${step} (${where.join(", ")})`),
      "colour steps with no --c-* token cannot follow the theme",
    ).toEqual([]);
  });

  it("core aliases the components consume are present", () => {
    const semantic = cssVars("semantic.css");
    for (const required of [
      "--bg-app",
      "--surface-card",
      // Help draws itself on its own surface so a walkthrough is never
      // mistaken for the app it is walking through.
      "--surface-help",
      "--border-help",
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
      "--status-delivered-bg",
      "--status-cancelled-bg",
    ]) {
      expect(semantic[required], `missing ${required}`).toBeDefined();
    }
  });

  /**
   * The whole point of the help surface is that it is NOT the card
   * surface. Aliasing them to the same step would leave every help
   * screen looking exactly as it did, with nothing failing to say so.
   */
  it("the help surface is distinguishable from the card surface", () => {
    const semantic = cssVars("semantic.css");
    expect(semantic["--surface-help"]).not.toBe(semantic["--surface-card"]);
    expect(semantic["--surface-help"]).not.toBe(semantic["--bg-app"]);
    expect(semantic["--border-help"]).not.toBe(semantic["--border-default"]);
  });

  it("the tour popover draws itself on the help surface", () => {
    // Driver.js paints its arrow as four one-sided borders, so an
    // overlooked side leaves a card-white spike on a tinted popover.
    // Comments stripped first — this file explains at length why it is
    // NOT on --surface-card, and the explanation is not a declaration.
    const help = readFileSync(
      fileURLToPath(new URL("../styles/help.css", import.meta.url)),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(help).not.toContain("--surface-card");
    expect(help.match(/var\(--surface-help\)/g)?.length).toBe(5); // body + 4 arrow sides
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

describe("shadcn token bridge", () => {
  const bridge = readFileSync(tokensDir + "shadcn.css", "utf8");

  /** The same file with comments stripped. Every assertion below is
   *  about declarations, and prose that happens to mention a selector
   *  or a variable name is not one — grepping the raw text conflates
   *  the two and fails on a comment that is merely accurate. */
  const bridgeCode = bridge.replace(/\/\*[\s\S]*?\*\//g, "");

  /** Every shadcn variable a component may reference. If a component is
   *  added that needs one not listed here, add it to BOTH this list and
   *  shadcn.css — an undefined var renders as transparent, silently.
   *
   *  --shadcn-accent* carry a prefix because semantic.css already owns
   *  `--accent` with a different meaning. tailwind.config.ts maps them
   *  back onto the `accent` key, so components still write `bg-accent`
   *  and `text-accent-foreground`. */
  const REQUIRED = [
    "--background", "--foreground",
    "--card", "--card-foreground",
    "--popover", "--popover-foreground",
    "--primary", "--primary-foreground",
    "--secondary", "--secondary-foreground",
    "--muted", "--muted-foreground",
    "--shadcn-accent", "--shadcn-accent-foreground",
    "--destructive", "--destructive-foreground",
    "--border", "--input", "--ring",
  ];

  it("defines every variable the components use", () => {
    for (const name of REQUIRED) {
      expect(bridgeCode).toContain(`${name}:`);
    }
  });

  it("defines them from the --c-* palette, never from raw colour values", () => {
    for (const [, name, value] of bridgeCode.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      if (name === undefined || value === undefined) continue;
      if (name.startsWith("--c-")) continue;
      expect(value).toMatch(/var\(--c-[\w-]+\)/);
    }
  });

  it("re-themes with the rest of the palette rather than separately", () => {
    // No dark override of its own: the --c-* vars it points at are the
    // ones colors.css already swaps, so the bridge must not duplicate
    // that switch and get a chance to disagree with it.
    //
    // Asserted as "declares exactly one :root rule" rather than by
    // grepping for a selector string. A grep only rules out the one
    // spelling it is written with — [data-theme="dark"] but not
    // [data-theme='dark'] or [data-theme=dark] — whereas any dark
    // override at all has to arrive as a second rule.
    const selectors = [...bridgeCode.matchAll(/([^{}]*)\{[^{}]*\}/g)].map(
      ([, selector]) => selector!.trim(),
    );
    expect(selectors).toEqual([":root"]);
  });

  it("is imported after semantic.css, so the bridge wins any future clash", () => {
    // Both files alias the same palette under names of their own, and
    // both land on :root, so a name defined in each is settled purely
    // by import order. None overlap today — shadcn.css prefixes the one
    // that would have — but the token files keep growing, and a stray
    // reorder of these two lines would be silent without this.
    const styles = readFileSync(srcDir + "styles.css", "utf8");
    const semantic = styles.indexOf('tokens/semantic.css"');
    const shadcn = styles.indexOf('tokens/shadcn.css"');
    expect(semantic, "semantic.css is not imported").toBeGreaterThan(-1);
    expect(shadcn, "shadcn.css is not imported").toBeGreaterThan(-1);
    expect(shadcn).toBeGreaterThan(semantic);
  });
});
