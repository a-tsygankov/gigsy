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

## Resolved: read Google's freebusy (decided 2026-08-10)

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

**Decided: option 2, using `freebusy`.**

It is the only version that answers the question truthfully, and
`freebusy` means we never hold personal event content even momentarily.

What this commits us to, stated plainly so it is not rediscovered later:

- **A wider scope.** `calendar.readonly` on top of `calendar.events`,
  which means a re-consent for every existing user. It must be presented
  as a choice — "let Gigsy see when you are busy, so your availability
  page is right" — and never slipped into the connect flow. A user who
  declines still gets the feature, built on Gigsy data alone, with the
  page saying so.
- **The integration is no longer one-way.** Phase 6 made it Gigsy →
  Google deliberately; this is the first read back. The direction stays
  one-way for *writes*: nothing here ever modifies a personal event.
- **Never store the response.** `freebusy` returns ranges, and those
  ranges are someone's private life at one remove. They feed the
  projection in memory and are discarded. Nothing personal reaches D1,
  and no busy range ever reaches the public page — only the free time
  computed from it.
- **Degrade honestly.** If the call fails or the scope was declined, the
  page is built from gigs alone and says which it is. Silently offering
  slots the user cannot work is the one outcome worse than no page.

## Tasks

### Task 1: Availability projection (pure, TDD) — DONE (db8d938)
- [x] RED: busy blocks from gigs; working-hours mask; horizon clamp;
      timezone; minimum-slot length (a 20-minute gap is not a booking);
      adjacent-block merging; DST boundaries
- [x] GREEN. No I/O in this module — it takes blocks and settings and
      returns free ranges, so every rule above is testable directly.
      23 tests. Timezone is injected as `localDayAt` rather than solved
      here — DST is its own problem behind that seam, and still open.

> **Note:** this commit lives on `dev-22` and was never merged into
> `dev-23`, which carries only the plan edits. Task 2 was built on the
> restored files; landing the phase means bringing `db8d938` along.

### Task 2: Tokens + public endpoint — DONE (uncommitted)
- [x] Migration `0010_availability_tokens` (token hash, userId,
      createdAt, expiresAt, revokedAt). Stores a **hash**, as with
      refresh tokens. Revoked rather than deleted, so "cut off" stays
      distinguishable from "never existed". One active link per user:
      issuing revokes the last. The cost, accepted: nothing stored can
      redisplay a link, so the share screen (Task 5) shows it once.
- [x] `GET /api/a/:token` — unauthenticated, rate-limited, `noindex`
      and `no-store` on every response including the failures. Returns
      free ranges + display name + timezone + the instant it was made
      and the end of its horizon. Nothing else. Every failure answers
      404: a 401 would confirm a link had once been real.
- [x] The leak test. Seeds a user whose gigs carry a client name, a
      location, an amount and notes, and asserts none of it — nor any
      id — reaches the response. Verified by mutation: adding a field
      or a busy range to the response makes it fail.

**Beyond the checklist, and why:**
- **The timezone seam is closed** (`domain/timezone.ts`, 16 tests).
  Task 1 left DST open; an endpoint cannot. `midnightMs + 9h` is not
  09:00 local on the two days a year a zone shifts, so `localMinuteAt`
  was added to `AvailabilityOptions` — optional, defaulting to the old
  arithmetic, so nothing existing changed. Chile, which shifts at
  midnight, is why a local day is "the earliest instant that is really
  this date" rather than "the instant the clock reads 00:00".
- **Availability settings shipped early** (display name, timezone,
  working week, horizon, minimum slot). The endpoint returns a name and
  a zone, so they had to exist; Task 5 still owns the UI.
- **`listBusyBetween` selects two columns**, `dateTime` and
  `durationMinutes`. The client, place and amount never enter the
  worker on this path — the privacy rule becomes structural rather
  than something to remember.
- **`domain/gig-time.ts`** now holds "how long a gig occupies", shared
  with the calendar sync. If the two disagreed, the page would offer a
  slot the user's own calendar shows as booked.
- **Rate limiting is per isolate** and says so in its own comment. It
  is a speed bump against hammering one link, not a guarantee; the
  defence is that the token is 128 random bits and revocable.
- **`webapp/public/robots.txt`** disallows `/a/` and `/api/`.

### Task 3: Google freebusy (decided — see above)
- [ ] `freebusy.query` against the connected calendar, ranges only
- [ ] Re-consent flow for the wider scope, presented as a choice
- [ ] Contract test against the fake; live test extended

### Task 4: The public page
- [ ] Static, fast, themed, readable on a phone — an agency opens this
      on a phone between calls
- [ ] Explicit about what it is: "Andrey's availability, as of <date>"
- [ ] Empty state that does not look broken when the week is full

### Task 5: Settings + sharing
- [ ] Working hours, timezone, horizon, display name — the settings
      themselves landed in Task 2; this is the screen for them
- [ ] The link can only be shown once. Hashing was the right call and
      this is its bill: the screen has to say "copy it now", and offer
      regenerate rather than reveal
- [ ] Show the link, copy it, regenerate it, revoke it
- [ ] Say plainly what the recipient can and cannot see. A user who
      does not trust the boundary will not use the feature.

### Task 6: Docs + verification
- [ ] docs/plan.md §13 Phase 12; the privacy rule recorded where it
      cannot be lost
- [ ] Full sweep; e2e covering the public page unauthenticated

**Branch:** dev-24 onward. No commits without the user's command.
