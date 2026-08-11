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
  /**
   * Domain for per-user capture addresses (`u-<userId>@<domain>`).
   * Unset or empty disables email capture: the Settings screen says so
   * rather than showing an address that would bounce. Requires
   * Cloudflare Email Routing on this domain with a catch-all to this
   * Worker.
   */
  CAPTURE_EMAIL_DOMAIN?: string;
  /** VAPID public key (base64url P-256 point). Public by definition —
   * the browser needs it to subscribe. Empty disables push. */
  VAPID_PUBLIC_KEY?: string;
  /**
   * Comma-separated addresses allowed to sign in. Unset or empty means
   * anyone with a Google account can — which is only safe while the
   * OAuth consent screen is in Testing mode and its own test-user list
   * is doing the gatekeeping.
   */
  ALLOWED_EMAILS?: string;
  /** Reverse-geocoder selection: unset = OpenStreetMap Nominatim,
   * "stub" = canned (non-production), "off" = disabled, so no position
   * ever leaves the worker and the client falls back to coordinates. */
  GEOCODE_PROVIDER?: string;

  // Secrets
  AUTH_SECRET: string;
  REFRESH_TOKEN_ENC_KEY: string;
  GOOGLE_CLIENT_SECRET: string;
  GEMINI_API_KEY: string;
  ANTHROPIC_API_KEY?: string;
  /** VAPID private key (base64url P-256 scalar). Rotating it
   * invalidates every subscription — they are pruned on first
   * rejection rather than left to fail silently. */
  VAPID_PRIVATE_KEY?: string;
  /** Contact address a push service can use to reach us (RFC 8292). */
  PUSH_SUBJECT?: string;
};
