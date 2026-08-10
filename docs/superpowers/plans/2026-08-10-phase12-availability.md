# Phase 12: Client-facing availability

**Goal:** a link you can send an agency that answers "when are you free?"
without them seeing anything else. Requested 2026-08-10.

## The shape

One public, unauthenticated page at `/a/<token>`. It shows free slots and
nothing more: no client names, no locations, no amounts, no gig titles,
not even a count of how busy you are beyond the blocks themselves. The
page is the whole feature — there is no login, no reply form, no booking.

## The privacy rule, stated once

**Nothing identifying leaves the boundary.** The endpoint returns time
ranges and a display name you chose. It must be impossible to learn from
this page who your other clients are, where you work, or what you charge.

That is not a nice-to-have; it is the reason this feature is risky enough
to plan rather than just build. Every decision below defers to it.

Concretely:
- The response contains **free** ranges, computed server-side. It never
  contains busy ranges, because "busy 14:00-18:00 at Pier 39" is one
  join away from a competitor knowing your schedule.
- No gig ids, no client ids, no counts.
- `X-Robots-Tag: noindex` and a `robots.txt` disallow. A shared link is
  not a published one.
- Tokens are unguessable (128-bit, base64url), revocable, and optionally
  expiring. A link sent to an agency in March should not still work in
  December unless you said so.

## Decisions

- **A token, not a slug.** `/a/andrey` is guessable and permanent;
  `/a/<random>` can be rotated the moment a relationship ends. One
  active token at a time, with "regenerate" invalidating the old — the
  simplest model that supports "stop showing this to them".
- **Free is computed, not stored.** Availability is a projection of
  gigs + working hours, so there is nothing to keep in sync. Storing it
  would create a second source of truth that silently rots.
- **Busy means `confirmed` or later, with a date.** Leads never block:
  the whole point is that a lead is not yet a commitment. `completed`
  and `paid` block for their historic slot, which matters only if
  someone asks about the past.
- **Working hours and timezone are settings** (`settings_json`, Phase
  11's blob — this is exactly the extensibility it was built for). Free
  time outside your working hours is not availability, it is your
  evening.
- **Horizon is bounded**: today plus N weeks, default 4. An infinite
  calendar invites scraping and answers a question nobody asked.

## The open question, to resolve before building

**Does availability need to read the user's Google Calendar?**

Gigsy knows about gigs. It does not know about the dentist, the school
run, or a gig booked through an agency that never reached the app. An
availability page built only on Gigsy data will confidently offer slots
the user cannot work — which is worse than no page at all, because the
user has now promised something.

Two options, and they are not close in cost:

1. **Gigsy-only.** Ship it, and say plainly on the page that it reflects
   Gigsy bookings. Cheap, honest, and wrong often enough to matter.
2. **Read the calendar too.** Requires `calendar.readonly` on top of
   `calendar.events`, so a re-consent, and reverses the integration's
   direction for the first time — Phase 6 deliberately made it one-way.
   Personal event details must be discarded at the boundary: read
   busy/free via the freebusy API, which returns ranges only and never
   titles. That API exists precisely for this.

**Recommendation: option 2, using `freebusy`.** It is the only version
that answers the question truthfully, and `freebusy` means we never hold
personal event content even momentarily. The extra scope is a real cost
and must be presented as a choice, not slipped into the connect flow.

## Tasks

### Task 1: Availability projection (pure, TDD)
- [ ] RED: busy blocks from gigs; working-hours mask; horizon clamp;
      timezone; minimum-slot length (a 20-minute gap is not a booking);
      adjacent-block merging; DST boundaries
- [ ] GREEN. No I/O in this module — it takes blocks and settings and
      returns free ranges, so every rule above is testable directly.

### Task 2: Tokens + public endpoint
- [ ] Migration: `availability_tokens` (token hash, userId, createdAt,
      expiresAt, revokedAt). Store a **hash**, as with refresh tokens —
      a leaked database should not hand over live links.
- [ ] `GET /api/a/:token` — unauthenticated, rate-limited, `noindex`.
      Returns free ranges + display name + timezone. Nothing else.
- [ ] Tests that assert the response contains **no** client name,
      location, amount or id, for a user whose gigs have all of them.
      This is the test that must never be deleted.

### Task 3: Google freebusy (pending the decision above)
- [ ] `freebusy.query` against the connected calendar, ranges only
- [ ] Re-consent flow for the wider scope, presented as a choice
- [ ] Contract test against the fake; live test extended

### Task 4: The public page
- [ ] Static, fast, themed, readable on a phone — an agency opens this
      on a phone between calls
- [ ] Explicit about what it is: "Andrey's availability, as of <date>"
- [ ] Empty state that does not look broken when the week is full

### Task 5: Settings + sharing
- [ ] Working hours, timezone, horizon, display name
- [ ] Show the link, copy it, regenerate it, revoke it
- [ ] Say plainly what the recipient can and cannot see. A user who
      does not trust the boundary will not use the feature.

### Task 6: Docs + verification
- [ ] docs/plan.md §13 Phase 12; the privacy rule recorded where it
      cannot be lost
- [ ] Full sweep; e2e covering the public page unauthenticated

**Branch:** dev-23. No commits without the user's command.
