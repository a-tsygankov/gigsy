import type { Config } from "tailwindcss";

// Placeholder palette — real design tokens land with the Phase 3
// design pass (docs/plan.md §14: UI flows/screens not yet designed).
// Dark theme is opt-in via a `dark` class on documentElement.
const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
