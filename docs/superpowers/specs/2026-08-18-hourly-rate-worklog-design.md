# Hourly rate, work log, and multi-gig payments — design

Date: 2026-08-18
Branch: `feature/hourly-rate-worklog`
Status: approved, ready for planning

## Why

A gig record currently describes only what was *agreed*: a start time, a
length, a single fee. Everything that actually happened on the day —
when work started, when it stopped, how long the breaks ran — has
nowhere to go, and a job paid by the hour cannot be expressed at all.

Three consequences follow, and this design addresses all of them:

1. **Hourly work is unrepresentable.** `amountOfferedCents` is a single
   fixed number. A rate has to be multiplied out by hand, before the
   shift, using a duration that is a guess.
2. **Planning and reporting share the same fields.** Editing "how long
   is this job" and recording "how long did I work" write to the same
   column, so recording reality silently moves the calendar event.
3. **A payment covers exactly one gig.** `payments.gigId` is a single
   nullable FK. An agency paying for a week of work in one transfer has
   to be split into fictional payments.

## Decisions taken

| Question | Decision |
|---|---|
| Gig statuses | `lead \| confirmed \| completed \| cancelled`. `paid` is removed as a settable status and derived from allocations. |
| Work-time shape | One start/end plus a total break, on `gigs`. No sessions table. |
| Expected pay before work is stopped | `rate × planned duration`, replaced by `rate × actual worked` once stopped. `amountOfferedCents` is the override. |
| Hourly rounding | Exact minutes; cents rounded half-up. No billing increment. |
| Packaging | One spec, four sequenced phases, each independently shippable. |
| shadcn scope | Foundation plus new screens only. Existing screens keep their current components. |
| Payment allocation | Partial allowed; the unallocated remainder is displayed. |

## Model

### Plan and actuals are separate field groups

| Job definition (plan) | Work result (actual) |
|---|---|
| `dateTime`, `durationMinutes` | `workStartedAt`, `workEndedAt`, `breakMinutes` |
| `payType`, `hourlyRateCents`, `amountOfferedCents` | `status`, payment allocations |

`gigOccupies()` in `backend/src/domain/gig-time.ts` keeps reading the
plan and is not touched. This is the invariant that makes the whole
feature safe: calendar sync and the availability projection must agree
on when a gig occupies time (see that file's header), and neither may
shift because someone recorded that they started twenty minutes late.

### Derived pay

One pure module, `gig-pay.ts`, duplicated in `backend/src/domain/` and
`webapp/src/lib/` and pinned by a shared test-vector fixture. The
duplication is deliberate and follows the existing precedent of
`GIG_STATUSES` living in both `backend/src/db/schema.ts` and
`webapp/src/lib/types.ts`: the PWA computes offline, the server computes
for reports, and there is no shared build package to put it in.

```
workedMinutes   = (workEndedAt − workStartedAt) / 60000 − (breakMinutes ?? 0)
                  // null unless BOTH stamps are present; clamped at 0
billableMinutes = workedMinutes ?? durationMinutes
expectedCents   = payType === 'hourly'
                    ? amountOfferedCents ?? roundHalfUp(rate × billableMinutes / 60)
                    : amountOfferedCents
```

On an hourly gig, a non-null `amountOfferedCents` is an **override**:
the UI shows `Computed $189.17 · Override`, and clearing the field
returns the gig to the computed value. One column, one job — no
separate "is overridden" flag to keep in sync.

## Phase 1 — Minute-precision time, and the shadcn foundation

`DateTimeField` exists in its current form because a native picker
could not be *constrained* to quarter hours (see its header comment and
`QUARTER_HOUR_OPTIONS` in `webapp/src/lib/datetime.ts`). Removing the
quarter-hour rule removes that reason, and `<input type="time">` becomes
strictly better: a full-minute wheel on iOS, keyboard entry on desktop.

- `DateTimeField` becomes a date `<input>` plus a time `<input>`,
  keeping the same `value` / `onChange` / `testId` contract so `GigEdit`
  and `DraftReview` need no change.
- Delete `QUARTER_HOUR_OPTIONS` and `timeOptionsFor` and their tests.
  The off-grid preservation those existed for becomes free: every
  minute is now on the grid, so a 14:18 extracted from an email is
  simply a valid value.
- `webapp/src/help/targets.ts` references DateTimeField's split
  structure; verify the help target still resolves.
- A new `DurationField` (hours + minutes) replaces the fixed `DURATIONS`
  array in `GigEdit`, so 3h20m is expressible.
- shadcn: add `class-variance-authority`, `clsx`, `tailwind-merge`,
  `tailwindcss-animate`, the radix primitives used, the `@/` alias and
  `components.json`.
- **Token bridge.** shadcn's `--background` / `--foreground` /
  `--primary` and the rest are defined in terms of the existing `--c-*`
  triplets in `webapp/src/styles/tokens/`, so one `data-theme` on
  `<html>` still re-themes everything and `docs/design-system.md`
  remains canonical. `design-tokens.test.ts` gains a case asserting the
  bridge resolves in both themes.
- Motion is added as a dependency here; it is first used in Phase 3.

**Done when:** every time control accepts any minute; the token bridge
test passes in both themes; no existing screen changed appearance.

## Phase 2 — Hourly rate and work log (migration `0013`)

New columns on `gigs`:

| Column | Type | Notes |
|---|---|---|
| `pay_type` | TEXT NOT NULL DEFAULT `'fixed'` | `'fixed' \| 'hourly'` |
| `hourly_rate_cents` | INTEGER | Positive when present; required when `pay_type = 'hourly'` |
| `work_started_at` | INTEGER | Epoch ms |
| `work_ended_at` | INTEGER | Epoch ms |
| `break_minutes` | INTEGER | Non-negative; total time not worked within the span |

Validation in `backend/src/domain/schemas.ts`:

- `hourlyRateCents` positive when present; `payType = 'hourly'` with a
  null rate is rejected.
- `workEndedAt > workStartedAt` when both are present.
- `workStartedAt` alone is the legal in-progress state; `workEndedAt`
  alone is rejected.
- `breakMinutes >= 0`, and strictly less than the span when the span is
  known.

Carried through: `GigsRepo` (`GigData`), `routes/gigs.ts`, the `gig`
case in `services/sync.ts`, `webapp/src/lib/types.ts`,
`data-service.ts`, `local-store.ts`. No new sync entity — these are
columns on an entity that already syncs.

**Done when:** an hourly gig round-trips through the API and the offline
outbox; the `gig-pay` vectors pass identically in both suites.

## Phase 3 — Job definition separated from work results (migration `0015`)

`GigEdit.tsx` is 489 lines holding four responsibilities: the
definition form, the results fields, the services list and the payments
list. The separation asked for is also the fix for that file.

- **`/gigs/:id`** — detail hub.
  - *Job* card: client, title, when, planned duration, location, pay
    type and rate or fee, notes. Read-only, with an Edit affordance.
  - *Work* card: status control, Start / Stop stamping to the current
    minute, break entry, and a live `3h 47m → $189.17` readout.
  - Services and payments sections as today.
- **`/gigs/:id/edit`** and **`/gigs/new`** — the definition form only.

Built with shadcn `Card` / `Tabs` / `Sheet`, and Motion for the
start-stop transition, honouring `prefers-reduced-motion` per
`docs/design-system.md`.

Status becomes `lead | confirmed | completed | cancelled`:

- Migration `0015` maps existing `paid` rows to `completed`. (`0014` went to the derived `expected_cents` column, added after Phase 2 shipped.)
- `cancelled` is excluded from `BUSY_STATUSES`
  (`backend/src/services/availability.ts:51`), from calendar sync, and
  from report and dashboard totals.
- Paid-ness becomes a derived badge, computed in Phase 4. Until then it
  reads from the existing `amountPaidCents`.
- `webapp/src/screens/ClientEdit.tsx` filters on `status === "paid"` and
  moves to the derived predicate.

**Done when:** the definition form and the work panel can each be used
without writing the other's fields; a cancelled gig disappears from
availability and reports.

## Phase 4 — Payments across multiple gigs (migration `0016`)

Scope grew after the phases above shipped. Three requirements, decided
2026-08-19:

| Question | Decision |
|---|---|
| A photographed receipt | Becomes a `payment` **draft**, reviewed before it is real — the same gate that already protects gigs and expenses |
| Attaching a photo offline | The payment saves through the outbox; the image queues locally and uploads when the connection returns |
| Which gigs a payment may cover | A payment names one **client**, and the split offers only that client's gigs |

New table:

```
payment_allocations(
  id, user_id, payment_id, gig_id, amount_cents, created_at, modified_at
)
```

Backfilled with one row per existing `payments.gig_id`. It becomes the
sixth sync entity: repo, zod schema, a `case` in `services/sync.ts`, a
Dexie `version(3)` store, and an outbox key. Both foreign keys are
re-checked against the caller's own records, exactly as the `service`
and `payment` cases do today.

**Compatibility.** The server keeps accepting `PaymentInput.gigId` and
translates it into a single allocation, so a client that was offline
across the upgrade does not lose data when its outbox drains. The field
is removed only after a release in which no client sends it.

**A payment belongs to a client.** `payments` gains a nullable
`client_id`, backfilled from the gig its `gig_id` pointed at. The split
UI offers that client's gigs and nothing else, and the server rejects an
allocation whose gig belongs to someone else — a mis-allocation is
caught at entry rather than found later in a total that does not
reconcile. Null stays legal: a payment recorded before you know who it
is from is better than no payment.

**A receipt is a draft, not a payment.** `ExtractedData.kind` gains
`payment`, and `DraftReview` learns to commit one. The photo the draft
already stored in R2 becomes that payment's confirmation image rather
than being uploaded a second time — the receipt *is* the proof, and
copying it server-side keeps the client from re-sending bytes it
already sent. Capture's single button becomes "Capture gig or receipt";
the pipeline behind it is unchanged.

**A photo can be attached as the payment is created.** Today the screen
saves first and navigates to the record, because the R2 key is
server-owned and the upload endpoint needs a real payment id. That
sequencing stays, but it becomes invisible: the file is chosen before
save, and uploaded once the record exists. Offline, the payment queues
in the outbox as it always has and the image queues beside it in its
own IndexedDB store, drained by the sync engine when the connection
returns. Until it lands the payment must show that its photo is pending
— a record that looks like it has proof when it does not is worse than
one that admits it is waiting.

**Derived paid amounts.** `gigs.amountPaidCents` stops being
hand-entered and becomes `SUM(allocations)`. The column stays, written
by the server, so offline clients keep reading a field they already
know — this is what avoids a coordinated client/server release. Reached
by this change:

- `backend/src/services/dashboard.ts` (unpaid jobs, outstanding cents)
- `backend/src/services/reports.ts` (paid and owed totals)
- `backend/src/push/nudges.ts`
- `webapp/src/lib/gig-filters.ts`, `webapp/src/lib/report-export.ts`
- the Paid field in the gig form, which is removed

Partial allocation is allowed: the sum may be less than the payment,
and the difference is shown as `Unallocated $X` on the payment screen
and surfaced on the dashboard. Over-allocation is rejected.

**Done when:** one payment splits across three gigs, each gig shows its
own paid total, the dashboard's outstanding figure matches, and the
unallocated remainder is visible.

## Testing

- `gig-pay` test vectors in a shared fixture, executed by both the
  backend and webapp suites, covering: fixed pay unaffected by work
  times; hourly before any work is logged; hourly with worked time; a
  break exceeding the span; the override set and cleared; half-up
  rounding at the half-cent boundary.
- Repo and route tests per migration, including the `paid` to
  `completed` mapping and the `gigId` to allocation backfill.
- A sync round-trip test for allocations, including the legacy
  `PaymentInput.gigId` path.
- Dashboard and report tests re-pinned against allocation-derived
  totals.
- E2E: enter a start and end time on an hourly gig and see the expected
  pay; edit the job definition without touching the work panel; split
  one payment across two gigs.

## Risks

- **Phase 4 rewrites the money math the dashboard and reports rest on.**
  It carries the most test weight of the four and should land alone.
- **The duplicated `gig-pay` module can drift.** The shared fixture is
  the guard; if the vectors are not run by both suites, the guard is
  not there.
- **The `paid` status migration is one-way.** Rows that were `paid`
  become `completed` and their paid-ness is thereafter derived, so a gig
  marked paid with no payment record will read as unpaid. That is the
  correct reading, but it will change what some existing rows display.
