import type { Config } from "tailwindcss";

// The design tokens in src/styles/tokens/ are canonical
// (docs/design-system.md). Tailwind's default palette and scale equal
// those token values — the design system lifted them from Tailwind —
// so no theme override is needed; src/lib/design-tokens.test.ts fails
// if the two sources ever drift. Dark theme is opt-in via a `dark`
// class on documentElement (no dark tokens exist yet by design).
const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
