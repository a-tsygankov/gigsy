# Email capture — activation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development or
> superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** finish the one Phase 5 feature that was built and never
switched on — forward an email to a personal address and have it become
a reviewable draft.

**State of play:** the hard half already works. `index.ts`'s `email()`
handler parses the message, runs extraction, and creates a draft, with
a fallback draft when extraction fails so mail is never silently
dropped. `capture.test.ts` and `email-handler.test.ts` cover it.

**What is actually missing** — and none of it is the parser:

1. **No domain.** The handler derives the recipient from
   `u-<userId>@<domain>` but nothing configures `<domain>`, so no
   address can be published or validated.
2. **The user is never told their address.** Nothing in the webapp
   surfaces it. A working inbox nobody can find is not a feature.
3. **Cloudflare Email Routing is not configured** — a dashboard job on
   a domain you control, not code.
4. **The address is a bearer secret that does not behave like one.**
   Anyone who learns `u-<userId>@domain` can inject drafts into that
   account. The userId is a UUID, so it is unguessable, but it is also
   printed in logs and used elsewhere as a non-secret identifier.
5. **No inbound limits.** Nothing caps message size or rate, and every
   accepted message costs an AI extraction against your key.

---

## Task 1: Configure the domain, and make the address derivable

**Files:** `backend/wrangler.toml`, `backend/src/env.ts`,
`backend/src/capture/address.ts` (new), test alongside.

- [ ] **Step 1: Failing test** — `backend/test/capture-address.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { captureAddressFor, userIdFromAddress } from "../src/capture/address.ts";

describe("captureAddressFor", () => {
  it("builds the address for a user", () => {
    expect(captureAddressFor("abc-123", "gigsy.app")).toBe("u-abc-123@gigsy.app");
  });

  it("is null when no domain is configured, rather than inventing one", () => {
    // A half-built address shown to a user is worse than none: they
    // will try it, and the mail will bounce.
    expect(captureAddressFor("abc-123", undefined)).toBeNull();
    expect(captureAddressFor("abc-123", "")).toBeNull();
  });
});

describe("userIdFromAddress", () => {
  it("reads the user id back out", () => {
    expect(userIdFromAddress("u-abc-123@gigsy.app")).toBe("abc-123");
  });

  it("is case-insensitive on the local part", () => {
    expect(userIdFromAddress("U-ABC-123@gigsy.app")).toBe("abc-123");
  });

  it("refuses anything not in the u- form", () => {
    expect(userIdFromAddress("hello@gigsy.app")).toBeNull();
    expect(userIdFromAddress("u-@gigsy.app")).toBeNull();
    expect(userIdFromAddress("")).toBeNull();
  });
});
```

- [ ] **Step 2:** Run `cd backend; npx vitest run --no-file-parallelism test/capture-address.test.ts`. Expect FAIL (no module).

- [ ] **Step 3: Implement** `backend/src/capture/address.ts`:

```ts
/**
 * The per-user capture address, in one place.
 *
 * The handler and the UI have to agree on this exactly — one builds
 * it, the other parses it — and a mismatch means mail that bounces
 * with no clue why.
 */
export function captureAddressFor(
  userId: string,
  domain: string | undefined,
): string | null {
  if (domain === undefined || domain.trim() === "") return null;
  return `u-${userId}@${domain.trim()}`;
}

export function userIdFromAddress(to: string): string | null {
  const local = (to.split("@")[0] ?? "").toLowerCase();
  if (!local.startsWith("u-")) return null;
  const id = local.slice(2);
  return id === "" ? null : id;
}
```

- [ ] **Step 4:** Run again. Expect PASS.

- [ ] **Step 5:** Add `CAPTURE_EMAIL_DOMAIN?: string;` to `Bindings` in
`backend/src/env.ts`, with a comment saying an unset value means the
feature is off and the UI says so.

- [ ] **Step 6:** In `backend/wrangler.toml` `[vars]`:

```toml
# Domain for per-user capture addresses (u-<userId>@<domain>). Empty
# disables the feature and the Settings screen says so rather than
# showing an address that would bounce. Requires Cloudflare Email
# Routing on this domain, with a catch-all to this Worker.
CAPTURE_EMAIL_DOMAIN = ""
```

- [ ] **Step 7:** Refactor `index.ts`'s `email()` to use
`userIdFromAddress(message.to)` instead of its inline parsing, keeping
the existing reject behaviour. Run `npx vitest run --no-file-parallelism test/email-handler.test.ts`.

- [ ] **Step 8: Commit.**

---

## Task 2: Show the user their address

**Files:** `backend/src/routes/capture.ts`,
`webapp/src/lib/api.ts`, `webapp/src/lib/data-service.ts`,
`webapp/src/screens/settings/CaptureSection.tsx` (new),
`webapp/src/screens/Settings.tsx`.

- [ ] **Step 1:** Add `GET /api/capture/address` behind `requireAuth`,
returning `{ address: string | null }` built with `captureAddressFor`.
Test it: an address when the domain is set, `null` when it is not, 401
unauthenticated.

- [ ] **Step 2:** Client method + data-service passthrough, mirroring
`getAvailabilityLink`.

- [ ] **Step 3:** A `CaptureSection` in Settings that shows the address
with a copy button, or, when it is null, one line saying capture is not
switched on for this deployment. Follow `AvailabilityLinkSection` for
the copy-button pattern and the `SettingGroup` layout.

- [ ] **Step 4:** Say plainly what happens to a forwarded email — that
its text goes to an AI provider for extraction. The privacy policy says
so; the screen where you get the address should too.

- [ ] **Step 5:** E2E: sign in, open Settings, assert either an address
matching `/^u-[\w-]+@/` or the "not switched on" line. Both are valid
states, so assert the pair the way `settings.spec.ts` already does for
push.

- [ ] **Step 6: Commit.**

---

## Task 3: Limits, before it is reachable from the internet

Once Email Routing points at the Worker, anyone who learns an address
can spend your AI budget.

- [ ] **Step 1: Failing tests** for a `shouldAcceptMessage` helper —
reject over a size cap, reject when the per-user daily count is
exhausted, accept otherwise.

- [ ] **Step 2:** Implement it. The existing per-user daily AI cap
(`AI_DAILY_CAP`) is the right counter to reuse — find where
`capture-service.ts` enforces it and share that path rather than adding
a second, divergent limiter.

- [ ] **Step 3:** Wire into `email()`: over the size cap →
`message.setReject(...)` with a clear reason; over the daily cap →
create a draft WITHOUT extraction (so the mail is still visible and
nothing is lost) and note why in the draft.

- [ ] **Step 4:** Test that an over-cap message still yields a
reviewable draft. **Never silently drop someone's mail** — that rule is
already in the handler's comment and must survive this change.

- [ ] **Step 5: Commit.**

---

## Task 4: Turn it on (operator steps, not code)

Do these in order; none is reversible by a redeploy.

- [ ] Pick a domain you control and add it to Cloudflare.
- [ ] Enable **Email Routing** on it.
- [ ] Add a **catch-all rule** → *Send to a Worker* → `gigsy-api`.
      Catch-all rather than per-address: addresses are derived from
      user ids, so they cannot be enumerated in advance.
- [ ] Set `CAPTURE_EMAIL_DOMAIN` in `wrangler.toml` and deploy.
- [ ] Send a real email to your own address and confirm a draft appears.
- [ ] Send one to `u-nonexistent@domain` and confirm it is rejected
      rather than silently accepted.

---

## Decisions taken here, so they are not re-litigated

- **Catch-all, not per-user routes.** Email Routing rules are manual;
  a rule per user does not scale past the first tester.
- **The address is unguessable, not secret.** A UUID in an email
  address is fine against guessing and useless against someone reading
  it over your shoulder. Task 3's caps are what bound the damage. If
  that stops being enough, the fix is a separate hashed capture token
  in the address — the same shape as the availability link — not a
  longer user id.
- **An unset domain disables the feature loudly.** The Settings screen
  says capture is off rather than showing an address that bounces.

## Open question for the operator

**Which domain?** `gigsy.app` appears in `PUSH_SUBJECT` as a default,
but nothing confirms it is registered or yours. Everything in Task 4
depends on this answer, and Tasks 1–3 can be built and merged without
it.
