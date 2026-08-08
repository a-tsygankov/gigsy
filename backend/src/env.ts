/**
 * Worker bindings + config. Secrets are set via `wrangler secret put`
 * (see scripts/setup-secrets.ps1); vars live in wrangler.toml [vars].
 * Full matrix: docs/plan.md §11.
 */
export type Bindings = {
  DB: D1Database;
  RECEIPTS: R2Bucket;

  // Vars (non-secret)
  ENVIRONMENT: string;
  GOOGLE_CLIENT_ID: string;
  AI_PROVIDER: string;
  AI_MODEL: string;
  /** Max AI captures per user per UTC day (default 50). */
  AI_DAILY_CAP?: string;

  // Secrets
  AUTH_SECRET: string;
  REFRESH_TOKEN_ENC_KEY: string;
  GOOGLE_CLIENT_SECRET: string;
  GEMINI_API_KEY: string;
  ANTHROPIC_API_KEY?: string;
};
