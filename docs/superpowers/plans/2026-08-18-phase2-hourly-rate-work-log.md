# Phase 2 — Hourly rate and work log

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A gig can be paid by the hour, can record when work actually started and stopped and how long the breaks ran, and derives its expected pay from those.

**Architecture:** Five new columns on `gigs`, split into a *plan* group that already exists (`dateTime`, `durationMinutes`) and an *actuals* group that is new (`workStartedAt`, `workEndedAt`, `breakMinutes`). `gigOccupies()` keeps reading the plan, so nothing here can move a calendar event. The pay derivation lives in one pure module, `gig-pay.ts`, duplicated backend and webapp and pinned by test vectors both suites run — the PWA has to compute offline and the server has to compute for reports, and there is no shared package to put it in.

**Tech Stack:** Cloudflare Workers, Hono, Drizzle, D1, Zod, Vitest (`@cloudflare/vitest-pool-workers` on the backend), React 18.

Spec: `docs/superpowers/specs/2026-08-18-hourly-rate-worklog-design.md`
Depends on: Phase 1 (`DurationField`).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `fixtures/gig-pay-vectors.json` | **New.** The one true set of pay cases | Create |
| `backend/src/domain/gig-pay.ts` | **New.** Pure derivation | Create |
| `backend/test/gig-pay.test.ts` | **New.** Runs the vectors | Create |
| `backend/migrations/0013_gig_pay_and_work_log.sql` | **New.** Five columns | Create |
| `backend/src/db/schema.ts` | Drizzle mirror | Add columns, import `PayType` |
| `backend/src/domain/schemas.ts` | Wire validation | Extend `GigInput` |
| `backend/src/repos/gigs.ts` | `GigData` | Add five fields |
| `backend/src/routes/gigs.ts` | PUT mapping | Add five fields |
| `backend/src/services/sync.ts` | `gig` case mapping | Add five fields |
| `webapp/src/lib/gig-pay.ts` | **New.** Mirror | Create |
| `webapp/src/lib/gig-pay.test.ts` | **New.** Runs the same vectors | Create |
| `webapp/src/lib/types.ts` | `Gig`, `GigInput` | Add five fields |
| `webapp/src/lib/local-store.ts` | Record + outbox payload | Add five fields |
| `webapp/src/screens/GigEdit.tsx` | Gig form | Pay type, rate, work times |

---

## Task 1: The shared test vectors

**Files:**
- Create: `fixtures/gig-pay-vectors.json`
- Modify: `backend/vitest.config.ts`, `webapp/vitest.config.ts`

The vectors live at the repository root so neither package owns them. Both vitest configs must be allowed to read outside their own root, which is the one non-obvious part of this task.

- [ ] **Step 1: Write the vectors**

Create `fixtures/gig-pay-vectors.json`:

```json
{
  "comment": "Shared by backend/test/gig-pay.test.ts and webapp/src/lib/gig-pay.test.ts. gig-pay.ts is duplicated in both packages; these vectors are what stops the two copies drifting. Add a case here before fixing a bug in either copy.",
  "cases": [
    {
      "name": "fixed pay is unaffected by work times",
      "gig": {
        "payType": "fixed",
        "hourlyRateCents": null,
        "amountOfferedCents": 15000,
        "durationMinutes": 240,
        "workStartedAt": 1789000000000,
        "workEndedAt": 1789021600000,
        "breakMinutes": 30
      },
      "workedMinutes": 330,
      "billableMinutes": 330,
      "expectedCents": 15000
    },
    {
      "name": "hourly before any work is logged falls back to the planned duration",
      "gig": {
        "payType": "hourly",
        "hourlyRateCents": 5000,
        "amountOfferedCents": null,
        "durationMinutes": 180,
        "workStartedAt": null,
        "workEndedAt": null,
        "breakMinutes": null
      },
      "workedMinutes": null,
      "billableMinutes": 180,
      "expectedCents": 15000
    },
    {
      "name": "hourly with work logged uses the actual time, minus the break",
      "gig": {
        "payType": "hourly",
        "hourlyRateCents": 5000,
        "amountOfferedCents": null,
        "durationMinutes": 180,
        "workStartedAt": 1789000000000,
        "workEndedAt": 1789014600000,
        "breakMinutes": 45
      },
      "workedMinutes": 198,
      "billableMinutes": 198,
      "expectedCents": 16500
    },
    {
      "name": "a started but unfinished shift has no worked time yet",
      "gig": {
        "payType": "hourly",
        "hourlyRateCents": 5000,
        "amountOfferedCents": null,
        "durationMinutes": 180,
        "workStartedAt": 1789000000000,
        "workEndedAt": null,
        "breakMinutes": null
      },
      "workedMinutes": null,
      "billableMinutes": 180,
      "expectedCents": 15000
    },
    {
      "name": "a break longer than the span clamps at zero rather than going negative",
      "gig": {
        "payType": "hourly",
        "hourlyRateCents": 5000,
        "amountOfferedCents": null,
        "durationMinutes": 180,
        "workStartedAt": 1789000000000,
        "workEndedAt": 1789003600000,
        "breakMinutes": 120
      },
      "workedMinutes": 0,
      "billableMinutes": 0,
      "expectedCents": 0
    },
    {
      "name": "an override wins over the computed value",
      "gig": {
        "payType": "hourly",
        "hourlyRateCents": 5000,
        "amountOfferedCents": 20000,
        "durationMinutes": 180,
        "workStartedAt": 1789000000000,
        "workEndedAt": 1789014600000,
        "breakMinutes": 45
      },
      "workedMinutes": 198,
      "billableMinutes": 198,
      "expectedCents": 20000
    },
    {
      "name": "half a cent rounds up",
      "gig": {
        "payType": "hourly",
        "hourlyRateCents": 1,
        "amountOfferedCents": null,
        "durationMinutes": 90,
        "workStartedAt": null,
        "workEndedAt": null,
        "breakMinutes": null
      },
      "workedMinutes": null,
      "billableMinutes": 90,
      "expectedCents": 2
    },
    {
      "name": "hourly with neither work nor planned duration has no expected pay",
      "gig": {
        "payType": "hourly",
        "hourlyRateCents": 5000,
        "amountOfferedCents": null,
        "durationMinutes": null,
        "workStartedAt": null,
        "workEndedAt": null,
        "breakMinutes": null
      },
      "workedMinutes": null,
      "billableMinutes": null,
      "expectedCents": null
    },
    {
      "name": "fixed with no offer has no expected pay",
      "gig": {
        "payType": "fixed",
        "hourlyRateCents": null,
        "amountOfferedCents": null,
        "durationMinutes": 240,
        "workStartedAt": null,
        "workEndedAt": null,
        "breakMinutes": null
      },
      "workedMinutes": null,
      "billableMinutes": 240,
      "expectedCents": null
    }
  ]
}
```

- [ ] **Step 2: Let both runners read it**

`backend/vitest.config.ts` — add, as a sibling of `test:`:

```ts
  // The pay vectors live at the repo root because neither package owns
  // them (fixtures/gig-pay-vectors.json). Vite refuses to serve outside
  // its root without this.
  server: { fs: { allow: [".."] } },
```

`webapp/vitest.config.ts` — the same addition.

- [ ] **Step 3: Commit**

```bash
git add fixtures/gig-pay-vectors.json backend/vitest.config.ts webapp/vitest.config.ts
git commit -m "test: shared pay vectors for the duplicated gig-pay module"
```

---

## Task 2: `gig-pay.ts` on the backend

**Files:**
- Create: `backend/src/domain/gig-pay.ts`
- Create: `backend/test/gig-pay.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/test/gig-pay.test.ts`:

```ts
/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * The pay derivation, against the shared vectors.
 *
 * `src/domain/gig-pay.ts` is duplicated in the webapp — the PWA
 * computes expected pay offline, the server computes it for reports,
 * and there is no shared package between them. These vectors are the
 * only thing standing between that duplication and two apps quietly
 * disagreeing about what a gig earned. Both suites run this file's
 * fixture; a fix to one copy that is not a fix to the other fails here.
 */
import { describe, it, expect } from "vitest";
import vectors from "../../fixtures/gig-pay-vectors.json";
import {
  billableMinutes,
  expectedCents,
  workedMinutes,
  type PayableGig,
} from "../src/domain/gig-pay.ts";

describe("gig pay vectors", () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      const gig = c.gig as PayableGig;
      expect(workedMinutes(gig)).toBe(c.workedMinutes);
      expect(billableMinutes(gig)).toBe(c.billableMinutes);
      expect(expectedCents(gig)).toBe(c.expectedCents);
    });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter gigsy-backend exec vitest run test/gig-pay.test.ts
```

Expected: FAIL — cannot resolve `../src/domain/gig-pay.ts`.

- [ ] **Step 3: Write the module**

Create `backend/src/domain/gig-pay.ts`:

```ts
/**
 * What a gig is expected to pay.
 *
 * Two questions a gig answers separately, and the reason the fields are
 * split the way they are:
 *
 *   - The PLAN (`dateTime`, `durationMinutes`) is what was agreed. It
 *     is what the calendar event and the availability projection are
 *     built from — see domain/gig-time.ts — and recording what actually
 *     happened must never move it.
 *   - The ACTUALS (`workStartedAt`, `workEndedAt`, `breakMinutes`) are
 *     what happened. They exist to be paid on, and for nothing else.
 *
 * So pay prefers the actuals and falls back to the plan: before the
 * shift, an hourly gig shows the quote; after it, the real figure.
 *
 * DUPLICATED in webapp/src/lib/gig-pay.ts. Both copies are pinned by
 * fixtures/gig-pay-vectors.json; change them together.
 */

export const PAY_TYPES = ["fixed", "hourly"] as const;
export type PayType = (typeof PAY_TYPES)[number];

/** Just enough of a gig to price it. Deliberately narrow, like
 *  TimedGig in gig-time.ts. */
export interface PayableGig {
  payType: PayType;
  hourlyRateCents: number | null;
  /** On an hourly gig this is the OVERRIDE: non-null replaces the
   *  computed figure entirely, null means "compute it". */
  amountOfferedCents: number | null;
  durationMinutes: number | null;
  workStartedAt: number | null;
  workEndedAt: number | null;
  breakMinutes: number | null;
}

/**
 * Time actually worked, or null until the shift is finished.
 *
 * A started-but-not-stopped shift is null rather than "so far": a
 * number that grows while nobody is looking would put a moving figure
 * into reports, and the in-progress case is the screen's business, not
 * this module's.
 *
 * Clamped at zero. A break longer than the span is a data-entry
 * mistake, and negative worked time would propagate into a negative
 * payment.
 */
export function workedMinutes(gig: PayableGig): number | null {
  if (gig.workStartedAt === null || gig.workEndedAt === null) return null;
  const span = (gig.workEndedAt - gig.workStartedAt) / 60_000;
  return Math.max(0, Math.round(span) - (gig.breakMinutes ?? 0));
}

/** What the hourly rate multiplies: the actuals when they exist, the
 *  plan until they do. */
export function billableMinutes(gig: PayableGig): number | null {
  return workedMinutes(gig) ?? gig.durationMinutes;
}

/**
 * Expected pay in cents, or null when there is nothing to say.
 *
 * Null is not zero: an hourly gig with no rate, no duration and no work
 * logged has an UNKNOWN value, and showing $0.00 for it would read as a
 * gig that pays nothing.
 */
export function expectedCents(gig: PayableGig): number | null {
  if (gig.payType === "fixed") return gig.amountOfferedCents;
  if (gig.amountOfferedCents !== null) return gig.amountOfferedCents;
  const minutes = billableMinutes(gig);
  if (minutes === null || gig.hourlyRateCents === null) return null;
  // Half-up, and only ever on a positive value — Math.round is
  // half-up for positives, which is the whole domain here.
  return Math.round((gig.hourlyRateCents * minutes) / 60);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter gigsy-backend exec vitest run test/gig-pay.test.ts
```

Expected: PASS, 9 tests. If it fails on the JSON import, the `server.fs.allow` change from Task 1 did not take — fix that rather than moving the fixture.

- [ ] **Step 5: Commit**

```bash
git add backend/src/domain/gig-pay.ts backend/test/gig-pay.test.ts
git commit -m "feat(pay): derive expected pay from rate and worked time"
```

---

## Task 3: The migration and the Drizzle mirror

**Files:**
- Create: `backend/migrations/0013_gig_pay_and_work_log.sql`
- Modify: `backend/src/db/schema.ts:104-146` (the `gigs` table)

- [ ] **Step 1: Write the migration**

Create `backend/migrations/0013_gig_pay_and_work_log.sql`:

```sql
-- Hourly pay, and what actually happened on the day.
--
-- The plan columns (date_time, duration_minutes) are untouched: the
-- calendar sync and the availability projection read those, and a
-- record of when work really started must not move a calendar event.
--
-- pay_type defaults to 'fixed' so every existing row keeps its current
-- meaning — amount_offered_cents is the fee, and nothing derives.
ALTER TABLE gigs ADD COLUMN pay_type TEXT NOT NULL DEFAULT 'fixed';
ALTER TABLE gigs ADD COLUMN hourly_rate_cents INTEGER;
ALTER TABLE gigs ADD COLUMN work_started_at INTEGER;
ALTER TABLE gigs ADD COLUMN work_ended_at INTEGER;
-- Total time NOT worked inside the span, not a list of breaks. One
-- number is what people actually know at the end of a shift.
ALTER TABLE gigs ADD COLUMN break_minutes INTEGER;
```

- [ ] **Step 2: Apply it locally**

```bash
pnpm db:migrate:local
```

Expected: the migration reports as applied with no error.

- [ ] **Step 3: Mirror it in Drizzle**

In `backend/src/db/schema.ts`, import the type rather than declaring a
second copy of it — `gig-pay.ts` owns the vocabulary because its webapp
twin has to be self-contained and cannot import from here:

```ts
import type { PayType } from "../domain/gig-pay.ts";
```

and inside the `gigs` column list, after `amountPaidCents`:

```ts
    /** 'fixed' — amountOfferedCents is the fee. 'hourly' — it is an
     *  optional override of rate × time (domain/gig-pay.ts). */
    payType: text("pay_type").$type<PayType>().notNull().default("fixed"),
    hourlyRateCents: integer("hourly_rate_cents"),
    // What actually happened, as opposed to dateTime/durationMinutes
    // above, which are what was agreed. Only pay reads these.
    workStartedAt: integer("work_started_at"),
    workEndedAt: integer("work_ended_at"),
    /** Total time not worked within the span, not a list of breaks. */
    breakMinutes: integer("break_minutes"),
```

- [ ] **Step 4: Verify the suite still passes**

```bash
pnpm --filter gigsy-backend test
```

Expected: PASS — nothing reads the new columns yet.

- [ ] **Step 5: Commit**

```bash
git add backend/migrations/0013_gig_pay_and_work_log.sql backend/src/db/schema.ts
git commit -m "feat(db): hourly rate and work-log columns on gigs"
```

---

## Task 4: Validation

**Files:**
- Modify: `backend/src/domain/schemas.ts:29-43`
- Test: `backend/test/gigs-routes.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `backend/test/gigs-routes.test.ts` (follow the file's existing helper for an authed PUT):

```ts
describe("hourly gigs and the work log", () => {
  it("stores a rate and the work actually done", async () => {
    const id = crypto.randomUUID();
    const res = await putGig(id, {
      status: "confirmed",
      payType: "hourly",
      hourlyRateCents: 5000,
      durationMinutes: 180,
      workStartedAt: 1789000000000,
      workEndedAt: 1789014600000,
      breakMinutes: 45,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.payType).toBe("hourly");
    expect(body.hourlyRateCents).toBe(5000);
    expect(body.workedMinutes ?? undefined).toBeUndefined(); // derived, not stored
    expect(body.breakMinutes).toBe(45);
  });

  it("rejects an hourly gig with no rate", async () => {
    const res = await putGig(crypto.randomUUID(), { payType: "hourly" });
    expect(res.status).toBe(400);
  });

  it("rejects an end before the start", async () => {
    const res = await putGig(crypto.randomUUID(), {
      workStartedAt: 1789014600000,
      workEndedAt: 1789000000000,
    });
    expect(res.status).toBe(400);
  });

  it("rejects an end with no start", async () => {
    const res = await putGig(crypto.randomUUID(), { workEndedAt: 1789000000000 });
    expect(res.status).toBe(400);
  });

  it("accepts a start with no end — the shift is in progress", async () => {
    const res = await putGig(crypto.randomUUID(), { workStartedAt: 1789000000000 });
    expect(res.status).toBe(201);
  });

  it("rejects a break longer than the span", async () => {
    const res = await putGig(crypto.randomUUID(), {
      workStartedAt: 1789000000000,
      workEndedAt: 1789003600000, // one hour
      breakMinutes: 90,
    });
    expect(res.status).toBe(400);
  });

  it("defaults an untouched gig to fixed pay", async () => {
    const res = await putGig(crypto.randomUUID(), { amountOfferedCents: 15000 });
    expect((await res.json()).payType).toBe("fixed");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter gigsy-backend exec vitest run test/gigs-routes.test.ts
```

Expected: FAIL — unknown keys are stripped, so the first test fails on `payType` being `"fixed"`.

- [ ] **Step 3: Extend `GigInput`**

In `backend/src/domain/schemas.ts`, import `PAY_TYPES` from `./gig-pay.ts` (`GIG_STATUSES` still comes from `../db/schema.ts`) and replace the `GigInput` definition with:

```ts
export const GigInput = z
  .object({
    clientId: entityId.nullish(),
    title: z.string().max(200).nullish(),
    status: z.enum(GIG_STATUSES).default("lead"),
    location: z.string().max(500).nullish(),
    dateTime: z.number().int().nullish(),
    // A length in minutes. Positive when present — a zero-length gig is
    // a data-entry mistake, and "unknown" is null. Capped at 24h.
    durationMinutes: z.number().int().positive().max(24 * 60).nullish(),
    /** 'fixed' keeps amountOfferedCents as the fee; 'hourly' makes it
     *  an optional override of rate × time. Defaults to fixed so a
     *  payload written before this existed still means what it did. */
    payType: z.enum(PAY_TYPES).default("fixed"),
    hourlyRateCents: positiveCents.nullish(),
    amountOfferedCents: positiveCents.nullish(),
    amountPaidCents: positiveCents.nullish(),
    // What actually happened. Epoch ms, like every other timestamp.
    workStartedAt: z.number().int().nullish(),
    workEndedAt: z.number().int().nullish(),
    /** Total time not worked inside the span. Zero is meaningful here
     *  (an explicit "no break"), so this is min(0), not positive. */
    breakMinutes: z.number().int().min(0).max(24 * 60).nullish(),
    notes: z.string().max(4000).nullish(),
    source: z.enum(GIG_SOURCES).default("manual"),
  })
  .superRefine((v, ctx) => {
    if (v.payType === "hourly" && v.hourlyRateCents == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hourlyRateCents"],
        message: "an hourly gig needs a rate",
      });
    }
    // A start alone is the legal in-progress state. An END alone is
    // not: it would price a shift of unknown length.
    if (v.workEndedAt != null && v.workStartedAt == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workStartedAt"],
        message: "work cannot end without having started",
      });
    }
    if (v.workStartedAt != null && v.workEndedAt != null) {
      if (v.workEndedAt <= v.workStartedAt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["workEndedAt"],
          message: "work must end after it starts",
        });
      } else if (
        v.breakMinutes != null &&
        v.breakMinutes * 60_000 >= v.workEndedAt - v.workStartedAt
      ) {
        // Equal is rejected too: a break filling the whole span means
        // no work happened, which is a cancelled gig, not a zero-paid
        // one.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["breakMinutes"],
          message: "the break cannot fill the whole shift",
        });
      }
    }
  });
```

Note: `.superRefine` returns a `ZodEffects`, which `zValidator` accepts but which cannot be `.extend()`ed. Grep for `GigInput.extend` / `GigInput.partial` before committing; if anything relies on those, keep a `GigInputShape` object and export both.

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter gigsy-backend exec vitest run test/gigs-routes.test.ts
```

Expected: the validation tests PASS; the storage test still fails because the route does not persist the new fields yet. That is Task 5.

- [ ] **Step 5: Commit**

```bash
git add backend/src/domain/schemas.ts backend/test/gigs-routes.test.ts
git commit -m "feat(api): validate hourly rate and work-log fields"
```

---

## Task 5: Persist the fields

**Files:**
- Modify: `backend/src/repos/gigs.ts:12-23` (`GigData`)
- Modify: `backend/src/routes/gigs.ts:40-52`
- Modify: `backend/src/services/sync.ts` (the `gig` case, around line 143)

- [ ] **Step 1: Extend `GigData`**

In `backend/src/repos/gigs.ts`, add to the interface after `durationMinutes`:

```ts
  payType: PayType;
  hourlyRateCents: number | null;
  workStartedAt: number | null;
  workEndedAt: number | null;
  breakMinutes: number | null;
```

and import `PayType` from `../domain/gig-pay.ts`. No other change is needed — `upsert` spreads `data` wholesale.

- [ ] **Step 2: Map them in the route**

In `backend/src/routes/gigs.ts`, inside the `repo.upsert` object literal, after `durationMinutes`:

```ts
        payType: input.payType,
        hourlyRateCents: input.hourlyRateCents ?? null,
        workStartedAt: input.workStartedAt ?? null,
        workEndedAt: input.workEndedAt ?? null,
        breakMinutes: input.breakMinutes ?? null,
```

- [ ] **Step 3: Map them in sync**

In `backend/src/services/sync.ts`, the `case "gig"` upsert object gets the identical five lines. This is the mapping the header comment in `webapp/src/lib/local-store.ts` is about: a field added to the record and not to the payload is silently lost, and this is the other half of that pair.

- [ ] **Step 4: Run the backend suite**

```bash
pnpm --filter gigsy-backend test
```

Expected: PASS, including all seven tests from Task 4.

- [ ] **Step 5: Add a sync round-trip test**

In `backend/test/sync.test.ts`, alongside the existing gig case:

```ts
it("round-trips hourly pay and the work log through /api/sync", async () => {
  const id = crypto.randomUUID();
  const res = await postSync([
    {
      entity: "gig",
      op: "upsert",
      id,
      modifiedAt: 1789000000000,
      payload: {
        status: "completed",
        payType: "hourly",
        hourlyRateCents: 5000,
        durationMinutes: 180,
        workStartedAt: 1789000000000,
        workEndedAt: 1789014600000,
        breakMinutes: 45,
        source: "manual",
      },
    },
  ]);
  expect(res.status).toBe(200);
  const stored = await getGig(id);
  expect(stored.payType).toBe("hourly");
  expect(stored.hourlyRateCents).toBe(5000);
  expect(stored.workEndedAt).toBe(1789014600000);
  expect(stored.breakMinutes).toBe(45);
});
```

Use whatever helpers the file already has for posting sync batches and reading a gig back.

- [ ] **Step 6: Run and commit**

```bash
pnpm --filter gigsy-backend test
```

```bash
git add backend/src/repos/gigs.ts backend/src/routes/gigs.ts backend/src/services/sync.ts backend/test/sync.test.ts
git commit -m "feat(api): persist hourly rate and work log"
```

---

## Task 6: The webapp mirror

**Files:**
- Create: `webapp/src/lib/gig-pay.ts`
- Create: `webapp/src/lib/gig-pay.test.ts`
- Modify: `webapp/src/lib/types.ts:8-40`

- [ ] **Step 1: Write the failing test**

Create `webapp/src/lib/gig-pay.test.ts`:

```ts
/**
 * The same vectors the backend runs (backend/test/gig-pay.test.ts).
 *
 * This file existing twice is the point: the module is duplicated
 * because the PWA prices gigs offline and the worker prices them for
 * reports, and the fixture is what stops the two copies drifting.
 */
import { describe, it, expect } from "vitest";
import vectors from "../../../fixtures/gig-pay-vectors.json";
import {
  billableMinutes,
  expectedCents,
  workedMinutes,
  type PayableGig,
} from "./gig-pay.ts";

describe("gig pay vectors", () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      const gig = c.gig as PayableGig;
      expect(workedMinutes(gig)).toBe(c.workedMinutes);
      expect(billableMinutes(gig)).toBe(c.billableMinutes);
      expect(expectedCents(gig)).toBe(c.expectedCents);
    });
  }
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter gigsy-webapp exec vitest run src/lib/gig-pay.test.ts
```

Expected: FAIL — cannot resolve `./gig-pay.ts`.

- [ ] **Step 3: Copy the module**

Create `webapp/src/lib/gig-pay.ts` with the **exact** contents of `backend/src/domain/gig-pay.ts` from Task 2, changing only the header's cross-reference line to:

```ts
 * DUPLICATED from backend/src/domain/gig-pay.ts. Both copies are pinned
 * by fixtures/gig-pay-vectors.json; change them together.
```

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter gigsy-webapp exec vitest run src/lib/gig-pay.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Extend the API types**

In `webapp/src/lib/types.ts`, add to `Gig` after `durationMinutes`:

```ts
  /** 'fixed' — amountOfferedCents is the fee. 'hourly' — it is an
   *  optional override of rate × time (lib/gig-pay.ts). */
  payType: PayType;
  hourlyRateCents: number | null;
  /** What actually happened, as opposed to dateTime/durationMinutes,
   *  which are what was agreed. Only pay reads these. */
  workStartedAt: number | null;
  workEndedAt: number | null;
  breakMinutes: number | null;
```

and the same five as optional fields on `GigInput`. Re-export the type at the top of the file:

```ts
export type { PayType } from "./gig-pay.ts";
export { PAY_TYPES } from "./gig-pay.ts";
```

- [ ] **Step 6: Commit**

```bash
git add webapp/src/lib/gig-pay.ts webapp/src/lib/gig-pay.test.ts webapp/src/lib/types.ts
git commit -m "feat(webapp): mirror the pay derivation"
```

---

## Task 7: The offline store carries the new fields

**Files:**
- Modify: `webapp/src/lib/local-store.ts:64-98` (`putGig`)
- Test: `webapp/src/lib/local-store.test.ts`

`OutboxPayload<T> = Required<T>` makes a missed field a compile error, so `typecheck` is a real gate here — but a test is what proves the value survives the round trip.

- [ ] **Step 1: Write the failing test**

Add to `webapp/src/lib/local-store.test.ts`:

```ts
it("carries hourly pay and the work log into the outbox", async () => {
  const store = makeStore(); // whatever the file's existing helper is
  const id = crypto.randomUUID();
  await store.putGig(id, {
    payType: "hourly",
    hourlyRateCents: 5000,
    durationMinutes: 180,
    workStartedAt: 1789000000000,
    workEndedAt: 1789014600000,
    breakMinutes: 45,
  });

  const op = await store.pendingOp("gig", id); // or the file's equivalent
  expect(op?.payload).toMatchObject({
    payType: "hourly",
    hourlyRateCents: 5000,
    workStartedAt: 1789000000000,
    workEndedAt: 1789014600000,
    breakMinutes: 45,
  });
  expect((await store.getGig(id))?.hourlyRateCents).toBe(5000);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter gigsy-webapp exec vitest run src/lib/local-store.test.ts
```

Expected: FAIL — the payload has no `payType`.

- [ ] **Step 3: Add the fields to both the record and the payload**

In `putGig`, add to `record`:

```ts
      payType: input.payType ?? existing?.payType ?? "fixed",
      hourlyRateCents: input.hourlyRateCents ?? null,
      workStartedAt: input.workStartedAt ?? null,
      workEndedAt: input.workEndedAt ?? null,
      breakMinutes: input.breakMinutes ?? null,
```

and to `payload`:

```ts
      payType: record.payType,
      hourlyRateCents: record.hourlyRateCents,
      workStartedAt: record.workStartedAt,
      workEndedAt: record.workEndedAt,
      breakMinutes: record.breakMinutes,
```

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter gigsy-webapp exec vitest run src/lib/local-store.test.ts && pnpm --filter gigsy-webapp typecheck
```

Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add webapp/src/lib/local-store.ts webapp/src/lib/local-store.test.ts
git commit -m "feat(offline): sync hourly pay and the work log"
```

---

## Task 8: The gig form

Phase 3 rearranges this screen entirely. The job here is only to make the new fields reachable, so Phase 2 is shippable on its own.

**Files:**
- Modify: `webapp/src/screens/GigEdit.tsx`

- [ ] **Step 1: Extend the form state**

Add to `FormState` and `BLANK`:

```ts
  payType: PayType;      // BLANK: "fixed"
  hourlyRate: string;    // dollars text; BLANK: ""
  workStart: string;     // datetime-local; BLANK: ""
  workEnd: string;       // datetime-local; BLANK: ""
  breakMinutes: string;  // BLANK: ""
```

Hydrate them in the `useEffect` that fills the form from `gig.data`, using `centsToInput` for the rate and `msToLocalInput` for the two stamps.

- [ ] **Step 2: Add the pay controls**

Replace the Offered/Paid grid with a pay-type select and a conditional field:

```tsx
<Field label="Paid by">
  <Select
    data-testid="gig-pay-type"
    value={form.payType}
    onChange={(e) => set("payType", e.target.value as PayType)}
  >
    <option value="fixed">A fixed fee</option>
    <option value="hourly">An hourly rate</option>
  </Select>
</Field>

{form.payType === "hourly" ? (
  <Field label="Rate ($ per hour)" error={moneyError}>
    <Input
      data-testid="gig-rate"
      inputMode="decimal"
      placeholder="50.00"
      value={form.hourlyRate}
      onChange={(e) => set("hourlyRate", e.target.value)}
    />
  </Field>
) : (
  <Field label="Offered ($)" error={moneyError}>
    <Input
      data-testid="gig-offered"
      inputMode="decimal"
      placeholder="150.00"
      value={form.offered}
      onChange={(e) => set("offered", e.target.value)}
    />
  </Field>
)}
```

Keep the Paid field where it is — Phase 4 removes it.

- [ ] **Step 3: Add the work log**

Below the pay controls:

```tsx
<SectionHeading>Work done</SectionHeading>
<Field label="Started">
  <DateTimeField
    testId="gig-work-start"
    value={form.workStart}
    onChange={(v) => set("workStart", v)}
  />
</Field>
<Field label="Finished">
  <DateTimeField
    testId="gig-work-end"
    value={form.workEnd}
    onChange={(v) => set("workEnd", v)}
  />
</Field>
<Field label="Off-time breaks (minutes)">
  <Input
    type="number"
    min={0}
    inputMode="numeric"
    className="w-24"
    data-testid="gig-break"
    placeholder="0"
    value={form.breakMinutes}
    onChange={(e) => set("breakMinutes", e.target.value)}
  />
</Field>
{payLine !== null && (
  <p className="text-sm text-slate-600" data-testid="gig-expected-pay">{payLine}</p>
)}
```

with, above the return:

```tsx
/** The live readout: what has been entered so far, priced. Recomputed
 *  from form state rather than from the saved record, so it answers
 *  while you are still typing. */
const draftPay: PayableGig = {
  payType: form.payType,
  hourlyRateCents: form.hourlyRate.trim() === "" ? null : parseMoney(form.hourlyRate),
  amountOfferedCents: form.offered.trim() === "" ? null : parseMoney(form.offered),
  durationMinutes: form.durationMinutes === "" ? null : Number(form.durationMinutes),
  workStartedAt: localInputToMs(form.workStart),
  workEndedAt: localInputToMs(form.workEnd),
  breakMinutes: form.breakMinutes === "" ? null : Number(form.breakMinutes),
};
const worked = workedMinutes(draftPay);
const expected = expectedCents(draftPay);
const payLine =
  expected === null
    ? null
    : worked !== null
      ? `Worked ${formatDuration(worked)} → ${formatMoney(expected)}`
      : `Expected ${formatMoney(expected)}`;
```

- [ ] **Step 4: Submit the new fields**

In `submit()`, add to the `save.mutate` object:

```ts
      payType: form.payType,
      hourlyRateCents:
        form.payType === "hourly" && form.hourlyRate.trim() !== ""
          ? parseMoney(form.hourlyRate)
          : null,
      workStartedAt: localInputToMs(form.workStart),
      workEndedAt: localInputToMs(form.workEnd),
      breakMinutes: form.breakMinutes === "" ? null : Number(form.breakMinutes),
```

and add a guard beside the existing money checks:

```ts
    if (form.payType === "hourly" && parseMoney(form.hourlyRate) === null) {
      setMoneyError("An hourly gig needs a rate.");
      return;
    }
```

- [ ] **Step 5: Update the duration help copy**

Phase 1 deliberately kept the duration step's description to what shipped then — the calendar and the availability page. This is the phase that makes duration feed money, so extend it in `webapp/src/help/scenarios/create-gig.ts`:

```
"How long the job runs, in hours and minutes. It is what stops the calendar guessing four hours, what your public availability page subtracts from your free time, and — on an hourly gig — what the expected pay is calculated from until you record the time you actually worked."
```

Do this only once the derivation in Task 8 is actually on screen; the sentence must not land before the behaviour does.

- [ ] **Step 6: Add the help targets**

In `webapp/src/help/targets.ts`:

```ts
  GigPayType: element("gig-pay-type"),
  GigRate: element("gig-rate"),
  GigWorkStart: element("gig-work-start-date"),
  GigWorkEnd: element("gig-work-end-date"),
  GigBreak: element("gig-break"),
```

`GigOffered` now only exists on a fixed-pay gig; the `create-gig` scenario starts on a blank form, which is fixed, so it still resolves. Add a step for `GigPayType` explaining what switching to hourly changes.

- [ ] **Step 7: Run everything**

```bash
pnpm --filter gigsy-webapp test && pnpm --filter gigsy-webapp typecheck
```

- [ ] **Step 8: Add the e2e case**

In `webapp/e2e/signed-in.spec.ts`:

```ts
test("an hourly gig prices itself from the time worked", async ({ page }) => {
  await page.goto("/gigs/new");
  await page.getByTestId("gig-pay-type").selectOption("hourly");
  await page.getByTestId("gig-rate").fill("50");
  await page.getByTestId("gig-work-start-date").fill("2027-03-04");
  await page.getByTestId("gig-work-start-time").fill("09:00");
  await page.getByTestId("gig-work-end-date").fill("2027-03-04");
  await page.getByTestId("gig-work-end-time").fill("12:18");
  await page.getByTestId("gig-break").fill("18");
  await expect(page.getByTestId("gig-expected-pay")).toContainText("$150.00");
});
```

- [ ] **Step 9: Run and commit**

```bash
pnpm --filter gigsy-webapp test:e2e
```

```bash
git add webapp/src/screens/GigEdit.tsx webapp/src/help webapp/e2e
git commit -m "feat(gigs): enter an hourly rate and the time worked"
```

---

## Verification

- [ ] `pnpm test` passes in both packages
- [ ] `pnpm typecheck` passes
- [ ] `pnpm --filter gigsy-webapp test:e2e` passes
- [ ] The same nine vectors run in both suites (grep both test files for `gig-pay-vectors.json`)
- [ ] Manually: an hourly gig saved offline reaches the server with its rate and work log intact after the outbox drains
- [ ] Manually: a fixed-fee gig created before this change still shows and saves exactly as before
