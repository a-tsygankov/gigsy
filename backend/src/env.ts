/**
 * Worker bindings + config. Secrets are set via `wrangler secret put`
 * (see scripts/setup-secrets.ps1); vars live in wrangler.toml [vars].
 * Full matrix: docs/plan.md §11.
 */
/**
 * The shape of a `[[send_email]]` binding, typed here rather than as
 * the global `SendEmail` from @cloudflare/workers-types.
 *
 * Two reasons. The pinned types version (2023-07-01) does declare
 * `SendEmail`, but as an overload set that also accepts the raw
 * `EmailMessage` from Email Routing — a shape this app never builds —
 * and naming only what we call keeps feedback/sender.ts honest about
 * its one dependency on the platform. And a structural type is what
 * tests can stand in for with a plain object: a fake binding is
 * `{ send: async () => ({ messageId }) }`, with no class to subclass.
 * Only the fields feedback/sender.ts fills are listed.
 */
export interface SendEmailBinding {
  send(message: {
    from: string;
    to: string | string[];
    subject: string;
    text?: string;
    attachments?: {
      disposition: "attachment";
      filename: string;
      type: string;
      content: ArrayBuffer | string;
    }[];
  }): Promise<{ messageId: string }>;
}

export type Bindings = {
  DB: D1Database;
  RECEIPTS: R2Bucket;
  /**
   * Cloudflare Email Sending — how feedback reaches the admins
   * (docs/superpowers/specs/2026-10-11-feedback-design.md).
   *
   * Optional because the binding is NOT in wrangler.toml yet: a
   * `[[send_email]]` block on an account with no onboarded sending
   * domain is refused at deploy time, and this repository deploys on
   * every merge. Until the operator adds it (wrangler.toml's
   * commented-out block says when), feedback/sender.ts's
   * `senderFromEnv` returns null and every feedback is stored with
   * `email_status = unsent` — kept, not lost.
   */
  EMAIL?: SendEmailBinding;

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
  /**
   * Sender address for feedback mail. Empty or unset means mail is
   * not configured and feedback is stored `unsent`. Must be on a
   * domain onboarded for Cloudflare Email Sending — the platform
   * refuses anything else, and the row would then read `failed`.
   */
  FEEDBACK_FROM?: string;

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
  /**
   * Comma-separated addresses that receive feedback mail. Parsed by
   * the same `parseAllowlist` as ALLOWED_EMAILS, and a secret for the
   * same reason: addresses are personal data and this repository is
   * public. Unset or empty means nobody — feedback is then stored
   * `unsent`, never dropped.
   */
  ADMIN_EMAILS?: string;
};
