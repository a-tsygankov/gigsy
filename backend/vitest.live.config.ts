import { defineConfig } from "vitest/config";

/**
 * The live-calendar test only. Plain node, not the workers pool: it
 * needs real network access and no D1, and it exercises
 * `mintAccessToken` and `CalendarClient` — which use nothing but fetch —
 * exactly as the worker does.
 *
 * Kept in its own config so `pnpm test` can never accidentally depend on
 * credentials or the network.
 */
export default defineConfig({
  test: {
    include: ["test/live/**/*.test.ts"],
    // A real round trip to Google is slower than the 5s default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Serial: these tests share one calendar, so parallel runs would
    // see each other's events.
    fileParallelism: false,
  },
});
