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

### Task 3: Google freebusy — DONE (uncommitted)
- [x] `freebusy.query` against `primary` plus the calendar gigs are
      written to, ranges only. Three outcomes, not two: an answer, a
      grant too narrow, or "we do not know" — and the third never
      collapses into "free".
- [x] Re-consent as a choice. `availabilityUseCalendar` is its own
      setting, default off; `CALENDAR_READONLY_SCOPE` is requested
      separately and never bundled into connect. The backend probe
      `GET /api/calendar/freebusy-check` tells the settings screen
      whether the stored grant can actually read, so a user is not left
      to discover it by sharing a link built on an assumption.
- [x] Contract tests against the fake (16), reader tests (11), service
      degrade tests (11). Live test extended, and
      `scripts/mint-e2e-token.ps1` now asks for the wider scope — a
      token minted before Phase 12 fails there with a message saying
      exactly that.

**What this cost, recorded so it is not rediscovered:**
- **The response gained `basedOn`.** The leak test's exact-key-set
  assertion refused it until it was added deliberately — which is the
  assertion working. It says whether the calendar was read, never what
  was on it, and the plan requires the page to be honest about which.
- **The public path never writes.** Everywhere else an unreadable or
  revoked token is self-healed by clearing it. Doing that here would
  mean a stranger's page load silently disconnecting someone's
  calendar, so `freebusy-reader.ts` decrypts directly and gives up
  quietly. The authenticated probe still heals, because the user is
  there to see it.
- **A page load can cost a token mint and a freebusy call.** The rate
  limiter is what keeps that bounded; there is no cache, because
  holding someone's busy ranges between requests is exactly what the
  plan says not to do.
- **The gap is visible, and that is inherent.** Free time either side
  of a booking reveals that a booking exists. What stays hidden is
  why — a gig, a dentist and a nap are byte-identical in the output,
  and there is a test that asserts it.

### Task 4: The public page — DONE (uncommitted)
- [x] One column, large type, no navigation and nothing to interact
      with. Deliberately no AppHeader, TabBar or sync badge: those
      belong to someone signed in, and showing them invites a stranger
      to try. Route sits outside `AuthGate` — the only one that does.
- [x] "Andrey's availability", the zone it is expressed in, and "as
      of <date>". Falls back to a bare "Availability" for a user who
      shared hours without sharing who they are.
- [x] Empty state that reads as an answer.

**Decided while building, because seeing it made them obvious:**
- **The page speaks in the OWNER's timezone**, named in the header as
  "London (BST)". An agency in New York reading a London page must not
  assume its own clock — that is a mis-booking, which is the failure
  the whole phase is about. Locale still follows the reader, because
  "9:00 AM" vs "09:00" is how they read a clock, not which clock it is.
- **The window opens on the quarter hour.** Clamping to the exact
  instant of the request produced "free from 15:59", which is an
  artefact of when the page loaded, not a fact about the schedule.
  Boundaries made by real bookings are deliberately left ragged: a gig
  ending at 16:45 means free from 16:45, and tidying that throws away
  information to look neater.
- **The horizon runs to the end of a local day.** "Four weeks" means
  whole days to a reader; ending mid-afternoon on an arbitrary date is
  a number, not an answer.
- **The empty state does not say "it's all booked".** The page cannot
  tell a full calendar from someone who does not work those days, and
  guessing states a reason that is sometimes false — and reveals
  something either way. It says what it knows: nothing available.
- **Slot chips are `slate-200`, not `slate-100`.** The ramp inverts in
  dark mode, where `slate-100` lands on exactly the card colour and the
  chips disappear. Caught by reading computed styles in both themes,
  not by looking at the light one.

### Task 5: Settings + sharing — DONE (uncommitted)
- [x] Working hours (a seven-day editor), timezone, horizon, minimum
      slot, display name. Plus the calendar toggle, which carries the
      re-consent flow Task 3 built the plumbing for.
- [x] The link is shown once. Hashing was the right call and this is
      its bill: the screen says "copy it now", and offers regenerate
      rather than reveal.
- [x] Create with an optional expiry, copy, regenerate, revoke.
      `POST /api/availability/link` is both create and regenerate,
      because one active link per user means minting IS rotating.
- [x] What a recipient can and cannot see, stated **before** the link
      is made rather than after — someone deciding whether to share
      needs it at the point of deciding.

**Decisions worth keeping:**
- **The editor cannot build a value the server rejects.** Dragging a
  start past its end pushes the end along instead of producing
  `end <= start` and a save that fails on submit.
- **Times are chosen from a list, not `<input type="time">`**, which
  cannot express 24:00 at all — and a shift ending at midnight is
  ordinary for event work. 1440 is labelled "midnight", because
  rendering it as a clock gives "12:00 AM", which reads as the start
  of a day and is exactly backwards for the end of a shift.
- **Turning the calendar on verifies rather than assumes.** A consent
  screen can be dismissed with a partial grant; believing otherwise
  would leave the page built on gigs alone while the toggle claimed
  otherwise. And an `unavailable` answer never triggers a consent
  popup — during an outage the user declines it and the feature then
  looks broken.
- **"UTC (UTC)"** was what the zone label produced before it learned
  to drop a half that says the same thing twice.

### Task 6: Docs + verification
- [ ] docs/plan.md §13 Phase 12; the privacy rule recorded where it
      cannot be lost
- [ ] Full sweep; e2e covering the public page unauthenticated

**Branch:** dev-24 onward. No commits without the user's command.
