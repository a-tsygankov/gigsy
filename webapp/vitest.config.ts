import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests only — Playwright owns e2e/*.spec.ts, which would
// otherwise match vitest's default include glob and fail under the
// vitest runner.
export default defineConfig({
  // This config does NOT extend vite.config.ts, so the `@/` alias has
  // to be repeated here or every shadcn component's `@/lib/utils`
  // import fails to resolve under the test runner alone.
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // The pay vectors live at the repo root because neither package owns
  // them (fixtures/gig-pay-vectors.json). Vite refuses to serve outside
  // its root without this.
  server: { fs: { allow: [".."] } },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
