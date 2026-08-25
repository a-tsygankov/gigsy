# A `delivered` gig status — design

Date: 2026-08-23
Branch: `feat/delivered-status`
Status: approved, ready for planning
Source: `Gigsy — Feature Suggestions`, §1

## Why

For work whose output is handed over separately from the job being
finished — a deliverable produced after the fact rather than on-site —
there is no state between "done" and "paid" that says *delivered*. The
lifecycle runs `lead → confirmed → completed`, and `completed` has to
stand for both "I finished the work" and "the client has it".

## A correction to the source document

The suggestion proposes:

```sql
CHECK (status IN ('lead','confirmed','completed','delivered','paid'))
```

That is wrong twice against the live schema, and implementing it
literally would undo a deliberate migration.

**`paid` is not a status.** Migration `0015_gig_status_cancelled.sql`
removed it. Its header says why: *"Paid-ness is now derived… Two sources
of truth for the same fact is what this removes — a hand-set 'paid' and
a payment record could always disagree, and after payments can span
several gigs they would disagree often."* Re-adding it restores exactly
that bug. The document is self-contradictory here: it cites §4.1 of
`docs/plan.md` on `amount_paid_cents` being derived, then puts `paid`
back in the enum beside it.

**`cancelled` would be dropped.** The live constraint is
`('lead','confirmed','completed','cancelled')`. The proposed list omits
`cancelled`, which would orphan every cancelled gig against the new
constraint.

Confirmed with the author: the intent is only to add `delivered`.

## Decisions taken

| Question | Decision |
|---|---|
| Target constraint | `('lead','confirmed','completed','delivered','cancelled')` |
| `paid` | Stays derived from `payment_allocations`. Not a status. |
| Money | A `delivered` gig is **still owed**: it stays in the dashboard's outstanding total and in reports' `owedCents`. |
| Time | A `delivered` gig is **still busy**: it stays in `BUSY_STATUSES`. |
| Sequence enforcement | None. `delivered` and payment are independent — a deposit can clear before delivery, a balance after. The UI may suggest an order; the server does not enforce one. |
| Pill colour | **teal**, added to the palette, following `violet`'s precedent. |
| Dashboard | A second drill-down: completed, not yet delivered. |
| Scope | This status value only. No delivery metadata (link, count, deadline) — that is a later, separate addition. |
| Sequencing | Ships alone, before `parent_gig_id`. See "Why first". |

## Why this ships first

`parent_gig_id` (the source document's §2) adds a self-referencing FK on
`gigs`. Any future rebuild of `gigs` would then have to stage the table
against itself. Widening the status constraint requires exactly such a
rebuild, so doing it before the self-FK exists keeps it simpler. The two
features are otherwise independent and get separate specs, plans and
PRs.

## The migration is the risk

SQLite cannot `ALTER` a `CHECK` constraint, so widening it means the
rebuild-and-swap that `0015` documents at length: a copy of `gigs`
carrying the new constraint, every row moved across with columns named
explicitly on both sides, the old table dropped, the copy renamed in.

**It is harder than `0015` was.** Four tables now hold a foreign key
into `gigs.id`:

| table | added by |
|---|---|
| `expenses` | `0000_init.sql` |
| `gig_services` | `0002_services_payments.sql` |
| `payments` | `0002_services_payments.sql` |
| `payment_allocations` | `0016_payment_allocations.sql` |

`0015` handled three. The fourth is new and must not be forgotten.

D1 enforces foreign keys inside migrations — `PRAGMA foreign_keys=off`
is accepted and silently ignored, and `PRAGMA defer_foreign_keys` does
not survive between statements, both established in `0015`'s header
against this D1 instance rather than assumed. `DROP TABLE` performs an
implicit `DELETE FROM` first, refused the instant any of those four
still points at a row about to disappear. So each is staged into a plain
copy, emptied, and restored once the new `gigs` exists under the same
ids.

**No row changes.** Unlike `0015`, which rewrote `paid` rows, this
migration only widens what is permitted. Every gig keeps its status.
There is no backfill, and therefore no backfill to get wrong.

## `delivered` behaves like `completed` for money and time

Adding an enum value silently *subtracts* from every place that tests
for `completed`. **Six** such sites exist, spanning both packages, and
all six are load-bearing. An earlier draft of this spec listed four; the
last two were found by grepping the whole tree rather than the services
directory, which is the only reason they are here.

| Site | If missed |
|---|---|
| `backend/src/services/dashboard.ts:130` | the outstanding total silently drops what you are owed |
| `backend/src/services/dashboard.ts:82` | `completedCount` under-reports |
| `backend/src/services/reports.ts:411` | `owedCents` under-reports |
| `backend/src/services/availability.ts:51` | a delivered gig's slot becomes publicly bookable |
| `backend/src/push/nudges.ts:79` | delivered-but-unpaid work stops being nudged about — the reminder goes quiet on exactly the money most likely to be forgotten |
| `webapp/src/screens/ClientEdit.tsx:208,214` | the gig vanishes from the client's history entirely: those two groups are `completed && !isPaid` and `completed && isPaid`, so a delivered gig matches neither |

Each becomes the `delivered`-inclusive form. Delivery is a milestone,
not a change in what you are owed or in whether that time is spoken for.

Two deserve singling out. `availability.ts`'s `BUSY_STATUSES` decides
what a stranger sees on a shared page, so it gets an explicit test
rather than an inference. And `ClientEdit.tsx` is a *disappearance*
rather than an under-count — the row is in neither bucket, which is
harder to notice than a wrong number.

The lesson for implementation: do not grep for `status = 'completed'`.
Grep for `completed` across both packages, because two of these six are
neither SQL nor in a service.

## Client side

**Two enum declarations, which must not drift.** `GIG_STATUSES` exists
independently in `backend/src/db/schema.ts:104` and
`webapp/src/lib/types.ts:9`. Both gain the value. Nothing enforces that
they match; a test that asserts the two lists are identical is worth
more than either list.

**Everything downstream is derived.** The gig form's status select and
the gig list's status filter both read `GIG_STATUSES`, so they pick the
value up with no edit. `gigListStatuses` in `domain/settings.ts:103` is
`z.array(z.enum(GIG_STATUSES))` — widening an enum is backward
compatible, and a saved view that predates `delivered` stays valid.

**`StatusPill` needs a colour, and there is not one free.** The palette
is curated: `colors.css` defines tokens for `slate`, `emerald`, `sky`,
`amber`, `red`, `violet` and nothing else, and `tailwind.config.ts`
exposes only those scales. Every one is taken — slate is `lead`, sky is
`confirmed`, amber is `completed`, violet is `cancelled`, emerald is the
paid badge and the app's accent, red is the error signal in seventeen
places. A class outside that set resolves to nothing.

So **teal** is added to the palette: tokens in both theme blocks of
`colors.css`, a scale in `tailwind.config.ts`, exactly as `violet` was
added for `cancelled` (`StatusPill.tsx` records that precedent). Teal
sits between sky and emerald, which reads as past confirmed and heading
for paid.

The new tokens must be checked against **both** theme blocks. This
codebase has shipped a control that was invisible in dark mode because
`--c-slate-100` and `--c-white` resolve to the same RGB there.

## Dashboard

A second drill-down beside "waiting to be paid": **completed, not yet
delivered** — gigs at `completed` exactly, which is now a meaningfully
narrower set than it was.

## Prose that goes stale

Two shipped comments state the lifecycle in words and become wrong:

- `webapp/src/help/scenarios/record-work.ts:85` tells the user *"lead →
  confirmed → completed, and it drives real behaviour, not just a
  label."* The help suite asserts targets, not sentences, so nothing
  fails when this goes stale.
- `webapp/src/components/StatusPill.tsx`'s docblock opens with the same
  three-stage sequence.

Both are updated in this change. No new help scenario is added — that is
out of scope (see below).

## Testing

Backend contract tests, mirroring `backend/test/payment-invariants.test.ts`:

- the constraint accepts `delivered` and still rejects an unknown value
- every pre-existing status still round-trips after the rebuild
- a `delivered` gig stays in `owedCents`
- a `delivered` gig stays in the dashboard outstanding total, and is
  excluded from the completed-not-delivered queue
- a `delivered` gig still blocks time on the public availability page
- a `delivered` gig that is overdue still produces an unpaid nudge

Webapp:

- `GIG_STATUSES` matches the backend's list exactly
- `StatusPill` renders every status including `delivered`, in both themes
- the teal tokens differ from their surface in light AND dark
- a `delivered` gig appears in the client's history on `ClientEdit`, in
  the unpaid group when unpaid and the paid group when paid

## What this design does not do

- No delivery metadata — no link, count, or deadline. The status value
  only.
- No ordering enforced between `delivered` and payment.
- No `parent_gig_id`. Separate spec, separate plan, ships after this.
- No new executable help scenario. Adding one means a new `HelpTarget`,
  a registry entry and a CI-covered branch — a documentation decision,
  not part of this change. The existing stale prose is still fixed.
- No change to how paid-ness is derived.
