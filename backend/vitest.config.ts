import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          compatibilityDate: "2025-01-01",
          compatibilityFlags: ["nodejs_compat"],
          // Synthetic secrets so tests exercise the real code paths
          // without real credentials. Values are intentionally fake.
          bindings: {
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
