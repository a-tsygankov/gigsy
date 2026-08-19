import type { Config } from "tailwindcss";
import tailwindcssAnimate from "tailwindcss-animate";

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

/** Same trick as `withAlpha`, for the shadcn aliases in
 *  styles/tokens/shadcn.css — those names carry no --c- prefix because
 *  shadcn's own components reference them verbatim. */
const shadcnColor = (token: string) => `rgb(var(--${token}) / <alpha-value>)`;

/** A shadcn colour and the text that sits on it, as the components
 *  expect to find them: `bg-card` with `text-card-foreground`. */
const pair = (name: string) => ({
  DEFAULT: shadcnColor(name),
  foreground: shadcnColor(`${name}-foreground`),
});

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
        amber: scale("amber", [50, 100, 500, 700, 800]),
        red: scale("red", [50, 200, 500, 600]),
        violet: scale("violet", [100, 700]),

        /** Text on the accent. Stays near-white in both themes, which
         *  `text-white` cannot: white is a surface below. */
        "on-accent": withAlpha("on-accent"),
        /** The accent's hover fill. Split from emerald-700, which is
         *  also the "good news" text colour in ten places — inverting
         *  serves the text and ruins the button. */
        "accent-hover": withAlpha("accent-hover"),

        /* shadcn/ui's names, resolving through styles/tokens/shadcn.css
           to the same --c-* palette as everything above — so a shadcn
           component follows `data-theme` without a second theme layer.
           These are additions: none of them replaces a key above.
           `accent` and `accent-hover` are distinct keys, so `bg-accent`
           and `bg-accent-hover` both still resolve to what they say. */
        background: shadcnColor("background"),
        foreground: shadcnColor("foreground"),
        card: pair("card"),
        popover: pair("popover"),
        primary: pair("primary"),
        secondary: pair("secondary"),
        muted: pair("muted"),
        /* `shadcn-accent`, because semantic.css owns a different `--accent`.
           The Tailwind key stays `accent`, so the classes are unchanged. */
        accent: pair("shadcn-accent"),
        destructive: pair("destructive"),
        border: shadcnColor("border"),
        input: shadcnColor("input"),
        ring: shadcnColor("ring"),
      },
    },
  },
  plugins: [tailwindcssAnimate],
};

export default config;
