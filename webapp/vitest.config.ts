import { defineConfig } from "vitest/config";

// Unit tests only — Playwright owns e2e/*.spec.ts, which would
// otherwise match vitest's default include glob and fail under the
// vitest runner.
export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
