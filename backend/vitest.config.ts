import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    // The live-calendar test needs real Google credentials and runs in
    // plain node (vitest.live.config.ts). Excluded here so an ordinary
    // `pnpm test` never depends on secrets or the network.
    exclude: ["test/live/**", "node_modules/**"],
    poolOptions: {
      workers: {
        // One runtime for the whole suite. The default (isolated
        // runtimes) spawns a separate workerd process per test file —
        // with ~70 files that exhausts loopback connections on Windows
        // and the module fallback service starts refusing them
        // (ConnectEx #1225), so most files fail to boot and report zero
        // tests while the run still looks green-ish. `isolatedStorage`
        // is unaffected: it is still applied per test file via the
        // runner's stacked storage.
        singleWorker: true,
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
