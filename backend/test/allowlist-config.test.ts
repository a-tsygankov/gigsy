import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { isAllowedEmail } from "../src/auth/allowlist.ts";

/**
 * A guard on where ALLOWED_EMAILS lives, not on what it contains.
 *
 * The allowlist is a Worker **secret**. It must never be added to
 * wrangler.toml `[vars]`, for two reasons that compound:
 *
 * 1. This repository is public, and the list is other people's email
 *    addresses. A var publishes them, and git history does not forget.
 * 2. A var of the same name overrides the secret on deploy. So putting
 *    it back does not merely duplicate the setting — it silently
 *    replaces a real allowlist with whatever the var says, and
 *    `ALLOWED_EMAILS = ""` means ANYONE with a Google account may sign
 *    in. The app would open with no code change and no error.
 *
 * The workers test pool loads wrangler.toml through `configPath`, so
 * `env` here sees exactly the vars production would receive — which
 * makes the absence of the var directly assertable, by the same path
 * that would carry the mistake.
 */
describe("ALLOWED_EMAILS is a secret, not a var", () => {
  // The control. Without it the assertion below is worthless: if
  // wrangler.toml vars did not reach `env` at all, ALLOWED_EMAILS would
  // read undefined whether or not someone had added it.
  //
  // CAPTURE_EMAIL_DOMAIN is declared in [vars] as an empty string and is
  // not among the bindings vitest.config.ts injects, so seeing "" here
  // proves two things at once: vars arrive, and an EMPTY var arrives as
  // "" rather than undefined. That second point is the whole game —
  // `ALLOWED_EMAILS = ""` is precisely the mistake being guarded
  // against, and it has to be distinguishable from absence.
  it("wrangler.toml vars reach env, empty ones included", () => {
    expect(env.CAPTURE_EMAIL_DOMAIN).toBe("");
  });

  it("is absent from the bindings wrangler.toml ships", () => {
    // Given the control above, undefined can only mean the var is not
    // in wrangler.toml — not that vars were never loaded.
    expect(env.ALLOWED_EMAILS).toBeUndefined();
  });

  it("an unset allowlist admits everyone — which is why the above matters", () => {
    // Not a recommendation, a statement of the blast radius. This is
    // the deliberate fail-open in src/auth/allowlist.ts: defaulting to
    // deny would strand the owner of a fresh deployment. The cost is
    // that an accidentally-emptied list is indistinguishable from one
    // that was never set.
    expect(isAllowedEmail("anyone@anywhere.test", undefined)).toBe(true);
    expect(isAllowedEmail("anyone@anywhere.test", "")).toBe(true);
  });
});
