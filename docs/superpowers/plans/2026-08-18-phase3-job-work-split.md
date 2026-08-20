# Phase 3 — Job definition separated from work results

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Editing what a job *is* (client, when, where, how it pays) is a different screen from recording what *happened* (started, stopped, breaks, status), and `cancelled` becomes a real status while `paid` stops being one.

**Architecture:** `/gigs/:id` becomes a read-mostly detail hub with two cards — Job and Work — and the existing form moves to `/gigs/:id/edit`. Status loses `paid` and gains `cancelled`; paid-ness becomes derived from what has been paid against what is expected, which is a pure function beside the pay derivation. This is also the fix for `GigEdit.tsx`, which is now **620 lines** doing four jobs — Phase 2 added the pay-type, rate, work-log and expected-pay controls to it.

**Tech Stack:** React 18, react-router 6, TanStack Query, shadcn/ui (`Card`, `Tabs`), Motion, Vitest, Playwright, D1/Drizzle.

Spec: `docs/superpowers/specs/2026-08-18-hourly-rate-worklog-design.md`
Depends on: Phase 1 (shadcn foundation), Phase 2 (`gig-pay.ts`, work-log fields), the `expected_cents` column (migration `0014`), and the combined date-time picker.

> **Component tests in this repo do not use `@testing-library/react`.** It is
> not a dependency and must not be added. Follow `DateTimeField.test.tsx` /
> `DurationField.test.tsx`: `react-dom`'s `createRoot` + `act`,
> `container.querySelector`, an `IS_REACT_ACT_ENVIRONMENT` shim, and a
> `setValue` helper writing through the native prototype setter and
> dispatching an `input` event. The snippets below are testing-library
> style for readability only — translate each assertion 1:1.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `backend/migrations/0015_gig_status_cancelled.sql` | **New.** `paid` → `completed`, allow `cancelled` | Create |
| `backend/src/db/schema.ts` | `GIG_STATUSES` | Replace `paid` with `cancelled` |
| `backend/src/services/availability.ts:51` | `BUSY_STATUSES` | Drop `paid`, keep `cancelled` out |
| `backend/src/services/dashboard.ts:54,78,95` | Dashboard SQL | Statuses |
| `backend/src/services/reports.ts:283` | Report SQL | Exclude `cancelled` |
| `backend/src/calendar/sync-service.ts` | Calendar sync | Exclude `cancelled` |
| `fixtures/gig-pay-vectors.json` | Vectors | Add `paidCases` |
| `backend/src/domain/gig-pay.ts`, `webapp/src/lib/gig-pay.ts` | Derivation | Add `outstandingCents`, `isPaid` |
| `webapp/src/lib/types.ts`, `components/StatusPill.tsx` | Status vocabulary | Update |
| `webapp/src/screens/GigDetail.tsx` | **New.** The hub | Create |
| `webapp/src/screens/gigs/JobCard.tsx` | **New.** Definition, read-only | Create |
| `webapp/src/screens/gigs/WorkCard.tsx` | **New.** Actuals + status | Create |
| `webapp/src/screens/GigEdit.tsx` | Definition form only | Strip work fields, services, payments |
| `webapp/src/App.tsx:54` | Routes | Add `/gigs/:id/edit` |

---

## Task 1: Statuses — `paid` out, `cancelled` in

**Files:**
- Create: `backend/migrations/0015_gig_status_cancelled.sql`
- Modify: `backend/src/db/schema.ts:102`, `backend/src/services/availability.ts:51`, `backend/src/services/dashboard.ts`, `backend/src/services/reports.ts:283`, `backend/src/calendar/sync-service.ts`

- [ ] **Step 1: Write the failing tests**

In `backend/test/dashboard.test.ts`:

```ts
it("counts completed gigs only — 'paid' is no longer a status", async () => {
  await seedGig({ status: "completed", amountOfferedCents: 15000 });
  const summary = await getDashboard();
  expect(summary.completedCount).toBe(1);
});

it("ignores cancelled gigs entirely", async () => {
  await seedGig({ status: "cancelled", amountOfferedCents: 15000 });
  const summary = await getDashboard();
  expect(summary.completedCount).toBe(0);
  expect(summary.expectedCents).toBe(0);
});
```

In `backend/test/availability.test.ts`:

```ts
it("a cancelled gig does not block time", async () => {
  await seedGig({ status: "cancelled", dateTime: /* inside the window */, durationMinutes: 120 });
  const slots = await project();
  expect(slots).toEqual(freeWholeDay);
});
```

Use each file's existing seeding and assertion helpers rather than inventing new ones.

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm --filter gigsy-backend exec vitest run test/dashboard.test.ts test/availability.test.ts
```

Expected: FAIL — `cancelled` is not an accepted status, so seeding rejects it.

- [ ] **Step 3: Write the migration**

Create `backend/migrations/0015_gig_status_cancelled.sql`:

```sql
-- 'paid' stops being a status; 'cancelled' becomes one.
--
-- Paid-ness is now derived: a gig is paid when what has been paid
-- against it covers what it is expected to earn (domain/gig-pay.ts).
-- Two sources of truth for the same fact is what this removes — a
-- hand-set 'paid' and a payment record could always disagree, and after
-- payments can span several gigs they would disagree often.
--
-- One-way. A gig marked paid with no payment record behind it becomes
-- 'completed' and will read as unpaid until a payment is recorded
-- against it. That is the accurate reading of the data that exists.
UPDATE gigs SET status = 'completed' WHERE status = 'paid';
```

**This is not a one-line UPDATE, and the earlier draft of this plan was wrong to say so.** It claimed there was no CHECK constraint and that validation was Zod's job. `0000_init.sql` in fact constrains `gigs.status` to the four original values, so an `UPDATE` alone leaves the table rejecting `cancelled` with `SQLITE_CONSTRAINT` the first time one is written.

SQLite cannot alter a CHECK constraint, so the migration must rebuild the table: create `gigs_new` with the new constraint, `INSERT ... SELECT` with explicit column names and `CASE WHEN status = 'paid' THEN 'completed'`, drop the old table, rename, and recreate all four indexes.

Treat that rebuild as the risky part of this phase. `payments`, `expenses`, `gig_services` and `payment_allocations` all hold foreign keys into `gigs`, so the drop-and-rename has to be safe with respect to them — check how D1 handles foreign-key enforcement during a migration rather than assuming, and verify afterwards that no reference was orphaned. Explicit column names in the `INSERT ... SELECT` are not stylistic: a positional copy silently misfiles data the day someone adds a column.

- [ ] **Step 4: Apply and update the vocabulary**

```bash
pnpm db:migrate:local
```

`backend/src/db/schema.ts:102`:

```ts
export const GIG_STATUSES = ["lead", "confirmed", "completed", "cancelled"] as const;
```

`backend/src/services/availability.ts:51`:

```ts
/** Statuses that occupy time. A lead is an offer, not a commitment;
 *  a cancelled gig is neither. */
export const BUSY_STATUSES: readonly GigStatus[] = ["confirmed", "completed"];
```

`backend/src/services/dashboard.ts` — line 54 `status IN ('completed', 'paid')` becomes `status = 'completed'`; line 78's `IN ('lead', 'confirmed')` is already correct; line 95 is already `= 'completed'`.

`backend/src/services/reports.ts:283` already filters `g.status = 'completed'`; check the *other* aggregates in that file and add `AND g.status != 'cancelled'` wherever a query spans all statuses.

`backend/src/calendar/sync-service.ts` — find where it decides a gig deserves an event and make `cancelled` mean "delete the event", using the same path a deleted gig takes.

- [ ] **Step 5: Run the whole backend suite**

```bash
pnpm --filter gigsy-backend test
```

Expected: PASS. Any test that seeds `status: "paid"` needs updating to `"completed"` — that is the intended breakage, not a reason to keep the status.

- [ ] **Step 6: Commit**

```bash
git add backend/migrations/0015_gig_status_cancelled.sql backend/src backend/test
git commit -m "feat(gigs): cancelled replaces paid as a status"
```

---

## Task 2: Derived paid-ness

**Files:**
- Modify: `fixtures/gig-pay-vectors.json`, `backend/src/domain/gig-pay.ts`, `webapp/src/lib/gig-pay.ts`
- Test: `backend/test/gig-pay.test.ts`, `webapp/src/lib/gig-pay.test.ts`

- [ ] **Step 1: Add the vectors**

Add a second array to `fixtures/gig-pay-vectors.json`, beside `cases`:

```json
  "paidCases": [
    {
      "name": "nothing paid against a known expectation is outstanding in full",
      "gig": { "payType": "fixed", "hourlyRateCents": null, "amountOfferedCents": 15000, "amountPaidCents": null, "durationMinutes": 240, "workStartedAt": null, "workEndedAt": null, "breakMinutes": null },
      "outstandingCents": 15000,
      "isPaid": false
    },
    {
      "name": "paid in full",
      "gig": { "payType": "fixed", "hourlyRateCents": null, "amountOfferedCents": 15000, "amountPaidCents": 15000, "durationMinutes": 240, "workStartedAt": null, "workEndedAt": null, "breakMinutes": null },
      "outstandingCents": 0,
      "isPaid": true
    },
    {
      "name": "overpaid still counts as paid and never goes negative",
      "gig": { "payType": "fixed", "hourlyRateCents": null, "amountOfferedCents": 15000, "amountPaidCents": 16000, "durationMinutes": 240, "workStartedAt": null, "workEndedAt": null, "breakMinutes": null },
      "outstandingCents": 0,
      "isPaid": true
    },
    {
      "name": "a deposit leaves the balance outstanding",
      "gig": { "payType": "hourly", "hourlyRateCents": 5000, "amountOfferedCents": null, "amountPaidCents": 5000, "durationMinutes": 180, "workStartedAt": null, "workEndedAt": null, "breakMinutes": null },
      "outstandingCents": 10000,
      "isPaid": false
    },
    {
      "name": "an unknown expectation is not a paid gig, whatever has been paid",
      "gig": { "payType": "hourly", "hourlyRateCents": 5000, "amountOfferedCents": null, "amountPaidCents": 5000, "durationMinutes": null, "workStartedAt": null, "workEndedAt": null, "breakMinutes": null },
      "outstandingCents": null,
      "isPaid": false
    }
  ]
```

- [ ] **Step 2: Write the failing test in both suites**

Append to `backend/test/gig-pay.test.ts` and `webapp/src/lib/gig-pay.test.ts` (identical bodies, differing only in import paths):

```ts
describe("paid vectors", () => {
  for (const c of vectors.paidCases) {
    it(c.name, () => {
      const gig = c.gig as PaidGig;
      expect(outstandingCents(gig)).toBe(c.outstandingCents);
      expect(isPaid(gig)).toBe(c.isPaid);
    });
  }
});
```

adding `outstandingCents`, `isPaid` and `type PaidGig` to each file's import.

- [ ] **Step 3: Run to verify they fail**

```bash
pnpm --filter gigsy-backend exec vitest run test/gig-pay.test.ts
```

Expected: FAIL — `outstandingCents` is not exported.

- [ ] **Step 4: Add the functions to BOTH copies**

Append to `backend/src/domain/gig-pay.ts` and `webapp/src/lib/gig-pay.ts`:

```ts
/** A gig plus what has landed against it. */
export interface PaidGig extends PayableGig {
  amountPaidCents: number | null;
}

/**
 * What is still owed, or null when the expectation is unknown.
 *
 * Never negative: overpayment is a bookkeeping curiosity, not a debt
 * the app owes back, and a negative here would subtract from the
 * dashboard's outstanding total and hide a real unpaid gig.
 */
export function outstandingCents(gig: PaidGig): number | null {
  const expected = expectedCents(gig);
  if (expected === null) return null;
  return Math.max(0, expected - (gig.amountPaidCents ?? 0));
}

/**
 * Paid when nothing is outstanding.
 *
 * An unknown expectation is NOT paid, whatever has been received: this
 * is what used to be a status someone set by hand, and the honest
 * answer to "is this settled" when we don't know what it should earn is
 * no.
 */
export function isPaid(gig: PaidGig): boolean {
  return outstandingCents(gig) === 0;
}
```

**One thing changed since this plan was written.** `expectedCents` is now
also a server-owned column on `gigs` (migration `0014`), and the webapp
already has `storedOrDerivedExpectedCents(gig)` — prefer the stored figure,
fall back to deriving locally for a gig whose edit has not synced yet. The
two functions above must go through that helper in the **webapp copy**, not
call `expectedCents()` directly, or a gig row will use one number while the
dashboard it feeds uses another. That helper deliberately has no backend
counterpart: on the server the column *is* the answer, so the backend copy
calls `expectedCents()` as written above.

Since `storedOrDerivedExpectedCents` takes `PayableGig & { expectedCents }`,
the webapp's `PaidGig` needs that field too. Add `expectedCents: number | null`
to the fixture's `paidCases` gigs so both suites still run the same vectors.

- [ ] **Step 5: Run both suites**

```bash
pnpm --filter gigsy-backend exec vitest run test/gig-pay.test.ts && pnpm --filter gigsy-webapp exec vitest run src/lib/gig-pay.test.ts
```

Expected: PASS, 14 tests each.

- [ ] **Step 6: Commit**

```bash
git add fixtures backend/src/domain/gig-pay.ts backend/test/gig-pay.test.ts webapp/src/lib/gig-pay.ts webapp/src/lib/gig-pay.test.ts
git commit -m "feat(pay): derive paid-ness from what is owed"
```

---

## Task 3: The webapp's status vocabulary

**Files:**
- Modify: `webapp/src/lib/types.ts:6-7`, `webapp/src/components/StatusPill.tsx`, `webapp/src/screens/ClientEdit.tsx:192`, `webapp/src/lib/gig-filters.ts`

- [ ] **Step 1: Write the failing test**

Create `webapp/src/components/StatusPill.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusPill } from "./StatusPill.tsx";
import { GIG_STATUSES } from "../lib/types.ts";

describe("StatusPill", () => {
  it("has a class for every status", () => {
    for (const status of GIG_STATUSES) {
      const { unmount } = render(<StatusPill status={status} />);
      expect(screen.getByText(status)).toBeInTheDocument();
      unmount();
    }
  });

  it("shows paid as a badge of its own, not as a status", () => {
    render(<StatusPill status="completed" paid />);
    expect(screen.getByText("completed")).toBeInTheDocument();
    expect(screen.getByText("paid")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter gigsy-webapp exec vitest run src/components/StatusPill.test.tsx
```

Expected: FAIL — `paid` is a `GigStatus`, and `StatusPill` has no `paid` prop.

- [ ] **Step 3: Update the vocabulary**

`webapp/src/lib/types.ts`:

```ts
export type GigStatus = "lead" | "confirmed" | "completed" | "cancelled";
export const GIG_STATUSES: GigStatus[] = ["lead", "confirmed", "completed", "cancelled"];
```

`webapp/src/components/StatusPill.tsx`:

```tsx
/**
 * Gig lifecycle badge (design system, components/feedback/StatusPill):
 * lead → confirmed → completed, with cancelled off to one side. The
 * pill's hue is the state — colour carries the meaning an icon normally
 * would. Text stays lowercase always.
 *
 * Paid is deliberately NOT one of these. It is not a stage of the work;
 * it is a fact about the money, derived from what has landed against
 * what is owed (lib/gig-pay.ts). It renders as a second badge so a
 * completed-and-paid gig can say both at once, which one pill could
 * never do.
 */
import type { GigStatus } from "../lib/types.ts";

export const STATUS_PILL_CLASSES: Record<GigStatus, string> = {
  lead: "bg-slate-100 text-slate-600",
  confirmed: "bg-sky-100 text-sky-700",
  completed: "bg-amber-100 text-amber-700",
  cancelled: "bg-slate-100 text-slate-400 line-through",
};

const BADGE = "inline-flex rounded-full px-2 py-0.5 text-xs font-medium";

export function StatusPill({ status, paid = false }: { status: GigStatus; paid?: boolean }) {
  return (
    <span className="inline-flex gap-1">
      <span className={`${BADGE} ${STATUS_PILL_CLASSES[status]}`}>{status}</span>
      {paid && <span className={`${BADGE} bg-emerald-100 text-emerald-700`}>paid</span>}
    </span>
  );
}
```

`webapp/src/screens/ClientEdit.tsx:192` — replace `g.status === "paid"` with `isPaid(g)` imported from `../lib/gig-pay.ts`.

`webapp/src/lib/gig-filters.ts` — anywhere the status list is enumerated, the new set flows from `GIG_STATUSES`; check `line 69`'s amount fallback still reads correctly and add `cancelled` to whatever the filter UI offers.

- [ ] **Step 4: Run the webapp suite**

```bash
pnpm --filter gigsy-webapp test
```

Expected: PASS. Tests that assert on the `paid` status are the intended breakage.

- [ ] **Step 5: Commit**

```bash
git add webapp/src/lib webapp/src/components webapp/src/screens/ClientEdit.tsx
git commit -m "feat(webapp): cancelled status, derived paid badge"
```

---

## Task 4: The detail hub

> **Done, with four deliberate divergences from what is written below.**
>
> 1. **`gig-status` is on the WORK card only**, per the Step 2b
>    inventory. Step 6 below also says to keep status on the form; the
>    two contradict each other and the inventory wins — one field with
>    two writers is what this phase exists to remove. The cost is that
>    `/gigs/new` cannot create a gig as `confirmed`; the save lands on
>    the hub with the status select in view, so it is one tap, not a
>    dead end.
> 2. **No `pnpm dlx shadcn add`.** `card` and `button` were already in
>    `src/components/ui/`; `badge` was not needed, since `StatusPill`
>    is this app's badge and Task 3 gave it the `paid` prop.
> 3. **The when-row is asserted on `data-value`, not on "09:00".** The
>    row is localised — `formatLocalMoment` renders "9:00 AM" in
>    en-US — so the e2e reads the canonical copy beside it, the same
>    trick `DateTimeField`'s trigger already uses.
> 4. **Start-then-Stop inside one minute is refused**, not stored: the
>    write schema rejects an end at or before the start, so the e2e
>    corrects the stamp backwards before pressing Stop, which is what
>    the field under the button is for.
>
> Also new, and not in the plan — each one a thing the split exposed
> rather than a thing it needed:
>
> - `lib/gig-input.ts`. `putGig` REPLACES the record, so both the work
>   card's one-field writes and the job form's save have to send the
>   whole gig or silently null everything they do not show. Typed
>   `Required<Omit<GigInput, "source">>`, the same guard `OutboxPayload`
>   carries and for the same reason.
> - `lib/work-log.ts`. The three cross-field rules the old form checked
>   inline, plus the `breakMinutes` field rule they were missing — a
>   fractional or day-long break passed every cross-field rule when
>   there was no end stamp, then 400d and was dropped by sync-engine
>   with only a warn.
> - `screens/gigs/useCommitOnLeave.ts`. Blur is not a reliable commit
>   point: `focusout` is not guaranteed for an input unmounted by a
>   route change, and iOS Safari moves no focus when a link is tapped.
> - The hub's merge base is read from the local store inside the
>   mutation, never from the React Query cache: nothing invalidates that
>   cache on a sync pull, so within its 30s window a work write built on
>   it would put the pre-pull `dateTime` back — the phase's own fault,
>   through the back door.

**Files:**
- Create: `webapp/src/screens/GigDetail.tsx`, `webapp/src/screens/gigs/JobCard.tsx`, `webapp/src/screens/gigs/WorkCard.tsx`
- Modify: `webapp/src/App.tsx:54`

- [x] **Step 1: Add the shadcn pieces**

```bash
cd webapp && pnpm dlx shadcn@latest add card button badge
```

- [x] **Step 2: Route the hub**

In `webapp/src/App.tsx`, replace the single gig route with:

```tsx
            <Route path="/gigs/new" element={<GigEdit />} />
            <Route path="/gigs/:id" element={<GigDetail />} />
            <Route path="/gigs/:id/edit" element={<GigEdit />} />
```

Order matters: `/gigs/new` must precede `/gigs/:id` or "new" is read as an id.

- [x] **Step 2b: Know what you are moving**

`GigEdit.tsx` now carries these controls, all added after this plan was
written. Every one of them has to land on one side of the split, so decide
per control rather than sweeping:

| Test id | Belongs to |
|---|---|
| `gig-title`, `gig-client`, `gig-location`, `gig-notes` | Job |
| `gig-datetime` (the combined picker) | Job — this is the PLAN |
| `gig-duration-hours` | Job — planned length |
| `gig-pay-type`, `gig-rate` / `gig-offered` | Job — how it pays |
| `gig-status` | **Work** |
| `gig-work-start`, `gig-work-end`, `gig-break` | **Work** |
| `gig-expected-pay` | **Work** — it reports on the actuals |
| `gig-paid` | Job for now; Phase 4 deletes it |

Note `gig-datetime` is a single control since the date-time picker landed —
one trigger opening a popover, with `-calendar` / `-time` / `-clear` /
`-done` inside it and a `label` prop for its accessible name. The help
registry has `GigDateTime`, not the old `GigDate` / `GigTime` pair.

- [x] **Step 3: Write `JobCard`**

Create `webapp/src/screens/gigs/JobCard.tsx` — read-only, one `<Card>`, rows for client, title, when (date + planned duration), location, how it pays (fee, or rate), notes. A single "Edit" button linking to `/gigs/${gig.id}/edit`, `data-testid="gig-edit"`.

```tsx
/**
 * What the job IS, as agreed.
 *
 * Read-only on purpose. This half of a gig changes when the client
 * changes it — rarely, and deliberately — while the half below it
 * changes on the day, in a hurry, with one thumb. Putting both in one
 * form is what made the old screen 620 lines and made it possible to
 * knock the start time sideways while recording that you finished late.
 */
```

- [x] **Step 4: Write `WorkCard`**

Create `webapp/src/screens/gigs/WorkCard.tsx` — a `<Card>` holding the status control, Start / Stop, the break field, and the live pay line. Every control saves immediately via the same `putGig` mutation, which keeps this card's job "record what happened" rather than "fill in a form and remember to save".

```tsx
/** Stamped to the current minute, not the current second: every other
 *  time in the app is minute-resolution, and a stored 14:07:36 would
 *  render as 14:07 while pricing as something else. */
const nowToMinute = () => Math.floor(Date.now() / 60_000) * 60_000;
```

The Start button sets `workStartedAt`; Stop sets `workEndedAt`. Both remain editable underneath as `DateTimeField`s — a stamp you took twenty minutes late has to be correctable, and this is the field the pay is computed from.

Pay line, from Phase 2's helpers:

```tsx
const worked = workedMinutes(gig);
const expected = expectedCents(gig);
```

- [x] **Step 4b: Give the hourly override a home**

The spec promised `Computed $189.17 · Override` with the field clearable.
Phase 2 shipped without it: on an hourly gig the Offered control is not
rendered at all, and `GigEdit`'s `submit()` deliberately forces
`amountOfferedCents: null` so a value typed while the gig was still
fixed-fee cannot ride along as an invisible override. That was the right
call then — an override nobody can see is worse than no override — but it
leaves `amountOfferedCents` unreachable on hourly gigs, and the shared
fixture still pins a vector ("an override wins over the computed value")
that no UI can currently produce.

The Work card is where it belongs, because an override is a statement about
what this gig actually earned, not about what was agreed. Build it there:
show the computed figure, and let the user replace it with an explicit
amount and clear it back to computed. Keep `submit()`'s force-null for the
Job form, which still has no business setting it.

If you conclude the override is better deferred again, say so and record why
in this plan — but do not leave the fixture pinning a state the product
cannot reach without saying so.

- [x] **Step 5: Write `GigDetail`**

Create `webapp/src/screens/GigDetail.tsx`: `AppHeader` with the gig's title, `StatusPill` with `paid={isPaid(gig)}`, then `<JobCard>`, `<WorkCard>`, then the existing services and payments sections moved verbatim out of `GigEdit.tsx` (including their explanatory copy and `data-testid`s), then the delete button.

Wrap the work card's pay line in a Motion `motion.span` keyed on the expected cents so the figure animates when a stamp lands, and guard it:

```tsx
// Honour the system setting rather than animating regardless — see
// docs/design-system.md on motion tokens.
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
```

- [x] **Step 6: Strip `GigEdit`**

Remove from `webapp/src/screens/GigEdit.tsx`: the services section, the payments section, the delete button, and the work-log fields added in Phase 2 Task 8 (start, finish, breaks) — those now live in `WorkCard`. Keep client, title, status, date/time, duration, location, pay type, fee or rate, notes. On save, navigate to `/gigs/${saved.id}` rather than `/gigs`.

- [x] **Step 7: Run and check in the browser**

```bash
pnpm --filter gigsy-webapp test && pnpm --filter gigsy-webapp typecheck
```

Then start the preview and walk one gig: open it, edit the job, come back, start and stop work, watch the pay line change.

- [x] **Step 8: Commit**

```bash
git add webapp/src/screens webapp/src/App.tsx webapp/src/components/ui webapp/package.json
git commit -m "feat(gigs): split the job definition from the work record"
```

---

## Task 5: Help and e2e

**Files:**
- Modify: `webapp/src/help/targets.ts`, `webapp/src/help/scenarios/create-gig.ts`, `webapp/e2e/signed-in.spec.ts`, `webapp/e2e/gig-list.spec.ts`, `webapp/e2e/availability.spec.ts`

- [ ] **Step 1: Update the help targets and copy**

Add targets for the new controls:

```ts
  GigEditButton: element("gig-edit"),
  GigWorkStartButton: element("work-start"),
  GigWorkStopButton: element("work-stop"),
```

In `create-gig.ts`, rewrite the Status step's description — it currently says "lead → confirmed → completed → paid":

```
"lead → confirmed → completed, and it drives real behaviour. A lead never blocks time on your public availability page and never reaches Google Calendar — it is an offer, not a commitment. Confirmed does both. Completed is the one the dashboard reads as work waiting to be paid. Cancelled takes the gig out of your calendar, your availability and your reports without deleting the record. Whether it has been PAID is worked out from the payments you record, not set here."
```

The scenario's tail steps target the services and payments sections, which now live on `/gigs/:id`, not `/gigs/new`. Either move those two steps into a new `record-work` scenario starting on a saved gig, or drop them from `create-gig` and say so in the file's header comment — the header already explains at length why every step is a `highlight` and why those sections were added, so it must not be left claiming something untrue.

- [ ] **Step 2: Add a `record-work` scenario**

Create `webapp/src/help/scenarios/record-work.ts` walking the Work card: status, Start, Stop, breaks, the pay line, and where payments go. Register it in `webapp/src/help/registry.ts`.

- [ ] **Step 3: Update the e2e specs**

Any spec that opens `/gigs/:id` expecting the form now needs `/gigs/:id/edit`, and any spec asserting on a `paid` status needs the derived badge. Add:

```ts
test("recording work never touches the planned time", async ({ page }) => {
  await page.goto("/gigs/new");
  await page.getByTestId("gig-pay-type").selectOption("hourly");
  await page.getByTestId("gig-rate").fill("50");
  await page.getByTestId("gig-datetime-date").fill("2027-03-04");
  await page.getByTestId("gig-datetime-time").fill("09:00");
  await page.getByTestId("gig-duration-hours").fill("3");
  await page.getByTestId("gig-save").click();

  // Saving now lands on the detail hub, not the list.
  await expect(page.getByTestId("gig-work-card")).toBeVisible();
  await expect(page.getByTestId("job-when")).toContainText("09:00");

  await page.getByTestId("work-start").click();
  await page.getByTestId("work-stop").click();

  // The plan is untouched; the actuals now exist and are priced.
  await expect(page.getByTestId("job-when")).toContainText("09:00");
  await expect(page.getByTestId("gig-expected-pay")).toContainText("$");
  await expect(page.getByTestId("gig-work-start-time")).not.toHaveValue("");
});
```

This is the regression test for the whole point of the phase: the two
assertions on `job-when` either side of the start/stop are what catch a
work control that writes into `dateTime`. Add `data-testid="job-when"`
to the Job card's when-row and `data-testid="gig-work-card"` to the Work
card when writing them in Task 4.

- [ ] **Step 4: Run everything**

```bash
pnpm --filter gigsy-webapp test && pnpm --filter gigsy-webapp help:validate && pnpm --filter gigsy-webapp test:e2e
```

- [ ] **Step 5: Commit**

```bash
git add webapp/src/help webapp/e2e
git commit -m "docs(help): walk the work record; update e2e for the split"
```

---

## Verification

- [ ] `pnpm test` passes in both packages
- [ ] `pnpm typecheck` passes
- [ ] `pnpm --filter gigsy-webapp test:e2e` and `help:validate` pass
- [ ] Manually: a cancelled gig vanishes from the availability page, the calendar and the reports, and its record still exists
- [ ] Manually: pressing Start then Stop changes no field in the Job card
- [ ] Manually: a gig that was `paid` before the migration now reads `completed`, plus a paid badge if a payment covers it
