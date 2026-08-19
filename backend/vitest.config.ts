import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    // The live-calendar test needs real Google credentials and runs in
    // plain node (vitest.live.config.ts). Excluded here so an ordinary
    // `pnpm test` never depends on secrets or the network.
    exclude: ["test/live/**", "node_modules/**"],
    // The pay vectors live at the repo root because neither package owns
    // them (fixtures/gig-pay-vectors.json). Vite refuses to serve outside
    // its root without this.
    server: { fs: { allow: [".."] } },
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          compatibilityDate: "2025-01-01",
          compatibilityFlags: ["nodejs_compat"],
          // Synthetic secrets so tests exercise the real code paths
          // without real credentials. Values are intentionally fake.
          bindings: {
            // Tests assert the env echo — pin it regardless of what
            // wrangler.toml [vars] ships to production.
            ENVIRONMENT: "development",
            // Worker-level capture tests run the deterministic stub;
            // provider unit tests construct real providers directly.
            AI_PROVIDER: "stub",
            AUTH_SECRET: "integration-test-secret",
            REFRESH_TOKEN_ENC_KEY: "dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXktdGVzdCE=",
            GOOGLE_CLIENT_SECRET: "test-google-client-secret",
            GEMINI_API_KEY: "test-gemini-key",
          },
        },
      },
    },
  },
});
