/// <reference types="@cloudflare/vitest-pool-workers" />

declare module "*.sql?raw" {
  const sql: string;
  export default sql;
}

declare module "cloudflare:test" {
  // Make our worker bindings visible on `env` in tests.
  interface ProvidedEnv {
    DB: D1Database;
    RECEIPTS: R2Bucket;
    AUTH_SECRET: string;
    ENVIRONMENT: string;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    REFRESH_TOKEN_ENC_KEY: string;
    AI_PROVIDER: string;
    AI_MODEL: string;
  }
}
