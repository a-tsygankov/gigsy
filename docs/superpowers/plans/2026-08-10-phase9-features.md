# Phase 9: Gig Duration, Reimbursable Expenses, Location Capture

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four user requests (2026-08-10): capture the current location into a
gig's Location, record an optional gig duration / end time, flag expenses the
client is expected to reimburse, and put push notifications on the roadmap.

**Decisions (pinning the open items):**

### 1. Gig duration

- **Store `duration_minutes`, not an end timestamp.** A gig has a start and a
  length; an end timestamp would duplicate the start and go stale whenever the
  date moves. The form still *shows* the computed end time, which is what the
  request asked to see.
- **Nullable.** Existing gigs have no duration and must not acquire a fake one.
- **The calendar stops guessing.** `syncUserGigs` has been inventing a 4-hour
  event since Phase 6; it now uses the real duration when set and falls back to
  4h only when it is not — the fallback becomes a documented default rather than
  an assumption baked into every event.
- **Preset control, not a time picker.** Phones make time pickers the slowest
  control in the app; a select of common shift lengths (1–8h) plus "Not set"
  covers real gig work, with the end time shown underneath as confirmation.

### 2. Reimbursable expenses

- **A boolean `reimbursable`, defaulting to false**, so no existing row changes
  meaning.
- **`netCents` keeps its definition: `paid − ALL expenses`.** Excluding
  reimbursable expenses from net would assume money that has not arrived — the
  flag records an *expectation of reimbursement*, not a receipt. Net stays the
  conservative, worst-case figure.
- **A new `reimbursableCents` total** makes the recoverable portion visible
  beside it, so the optimistic figure is derivable without ever being asserted.
  Reports show "of which billable to client"; the CSV export gets a
  `reimbursable` column.
- Deliberately *not* modelled as a link to a payment: reimbursement usually
  arrives inside a normal gig payment, and inventing a second money trail would
  double-count. Revisit only if it turns out to arrive separately.

### 3. Current location

- **The device gets coordinates; the worker turns them into words.**
  `navigator.geolocation` runs client-side (a permission prompt the user drives),
  and reverse geocoding happens in the worker behind `GET /api/geo/reverse` so no
  provider key ever reaches the browser and the provider is swappable by config —
  the same shape as the extraction providers.
- **Coordinates are never persisted.** They are query parameters on one request
  and are not written to D1; only the resolved text lands in `gigs.location`, and
  only if the user saves the gig.
- **Privacy is worth naming:** this sends the user's precise position to a
  third-party geocoder (default: the keyless OpenStreetMap Nominatim endpoint,
  called with a proper User-Agent per its usage policy). It happens only when the
  user taps the button. `GEOCODE_PROVIDER` selects the implementation so this can
  be pointed at Google's Geocoding API — or disabled entirely — without a code
  change.
- **It always produces something.** A failed lookup falls back to the plain
  `lat, lon` string rather than an error, because a coordinate in the Location
  field still beats an empty one when you are standing in a car park.

### 4. Push notifications

Phase 7 decided against push for v1, on the grounds that calendar reminders plus
the dashboard's unpaid queue covered it. The user has asked for it on the
roadmap, so that decision is **revisited, not silently reversed**: docs/plan.md
§13 gains Phase 10 and §14's entry is updated to point at it. Not implemented
here — it needs VAPID keys, a subscription table, a service-worker `push`
handler, and an iOS-installed-PWA caveat, which is its own phase.

**Branch:** dev-13. No commits without the user's command.

---

### Task 1: Migration 0006 + backend fields

**Files:** `migrations/0006_duration_reimbursable.sql`, `db/schema.ts`, `domain/schemas.ts`, `repos/{gigs,expenses}.ts`, `services/sync.ts`, tests

- [x] RED: a gig round-trips `durationMinutes` (and rejects zero/negative); an
      expense round-trips `reimbursable`, defaulting false; both survive the
      `/api/sync` batch path
- [x] GREEN; tests pass

### Task 2: Duration in calendar sync, reimbursable in reports

- [x] RED: an event spans the gig's duration when set and 4h when not; the
      report exposes `reimbursableCents` while `netCents` still subtracts every
      expense
- [x] GREEN; tests pass

### Task 3: Reverse-geocode endpoint

**Files:** `src/geo/providers.ts`, `src/routes/geo.ts`, tests

- [x] RED (injected fetch): a successful lookup returns a label; a provider
      error yields the coordinate fallback; the route requires auth and
      validates lat/lon ranges
- [x] GREEN; tests pass

### Task 4: Webapp

- [x] Duration select with computed end time; reimbursable toggle + list
      marker; "Use current location" on the Location field; report tile and CSV
      column; types and offline store updated
- [x] e2e covering the duration round-trip and the reimbursable flag

### Task 5: Docs + verification

- [x] docs/plan.md §13 Phase 10 (push) + §14 revision; §4 field notes
- [x] Full sweep: both typechecks, both test suites, build, local e2e, python
- [x] Tree left uncommitted on dev-13 pending the user's command
