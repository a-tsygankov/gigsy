import type { Config } from "tailwindcss";

/**
 * The design tokens in src/styles/tokens/ are canonical
 * (docs/design-system.md). Every colour utility resolves through a CSS
 * variable holding an "R G B" triplet, so one `data-theme` attribute on
 * <html> re-themes all fourteen screens at once.
 *
 * `<alpha-value>` is the reason this works at all. Tailwind substitutes
 * the modifier into the rgb() call, so `bg-white/90` and `bg-slate-50/95`
 * still produce real alpha — the sticky header and tab bar scrims depend
 * on them, and losing them is precisely why the design system avoided
 * routing Tailwind through var() the first time round.
 *
 * The names still mirror Tailwind's palette because the screens are
 * written in them; src/lib/design-tokens.test.ts fails if the light
 * values ever drift from Tailwind's own.
 */
const withAlpha = (token: string) => `rgb(var(--c-${token}) / <alpha-value>)`;

const scale = (name: string, steps: number[]) =>
  Object.fromEntries(steps.map((s) => [s, withAlpha(`${name}-${s}`)]));

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  // Not Tailwind's `dark:` variant: no `dark:` utility exists in this
  // codebase by design. Theming happens in the token layer instead.
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        white: withAlpha("white"),
        slate: scale("slate", [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]),
        emerald: scale("emerald", [50, 100, 200, 500, 600, 700]),
        sky: scale("sky", [50, 100, 200, 700]),
        amber: scale("amber", [50, 100, 700, 800]),
        red: scale("red", [50, 200, 500, 600]),

        /** Text on the accent. Stays near-white in both themes, which
         *  `text-white` cannot: white is a surface below. */
        "on-accent": withAlpha("on-accent"),
        /** The accent's hover fill. Split from emerald-700, which is
         *  also the "good news" text colour in ten places — inverting
         *  serves the text and ruins the button. */
        "accent-hover": withAlpha("accent-hover"),
      },
    },
  },
  plugins: [],
};

export default config;
