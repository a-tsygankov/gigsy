# Phase 4 — One payment across many gigs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single payment from a client can be split across several gigs, each gig's paid total is derived from those splits, and any unallocated remainder is visible rather than lost.

**Architecture:** A new `payment_allocations` table replaces `payments.gigId` as the link between money and work. It becomes the sixth sync entity. `gigs.amountPaidCents` survives as a **server-written derived column** — recomputed whenever an allocation changes — so offline clients keep reading the field they already know and no coordinated client/server release is needed. The server keeps accepting `PaymentInput.gigId` and translates it into a single allocation, so an outbox that was queued before the upgrade drains correctly.

**Tech Stack:** Cloudflare Workers, Hono, Drizzle, D1, Zod, Dexie, React 18, Vitest, Playwright.

Spec: `docs/superpowers/specs/2026-08-18-hourly-rate-worklog-design.md`
Depends on: Phase 3 (`isPaid`, `outstandingCents`).

⚠ This phase rewrites the money math the dashboard and reports rest on. Land it on its own, with nothing else in flight.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `backend/migrations/0016_payment_allocations.sql` | **New.** Table + backfill | Create |
| `backend/src/db/schema.ts` | Drizzle mirror | Add `paymentAllocations` |
| `backend/src/repos/allocations.ts` | **New.** User-scoped CRUD | Create |
| `backend/src/services/paid-totals.ts` | **New.** Recompute `amountPaidCents` | Create |
| `backend/src/domain/schemas.ts` | `AllocationInput` | Add |
| `backend/src/routes/allocations.ts` | **New.** REST | Create |
| `backend/src/routes/payments.ts` | `gigId` compat | Translate to an allocation |
| `backend/src/services/sync.ts` | 6th entity | Add `allocation` case |
| `backend/src/services/dashboard.ts`, `reports.ts` | Money | Read derived totals |
| `webapp/src/lib/db.ts` | Dexie `version(3)` | Add `allocations` store |
| `webapp/src/lib/local-store.ts`, `data-service.ts`, `sync-engine.ts`, `api.ts` | Offline path | Add the entity |
| `webapp/src/screens/PaymentEdit.tsx` | Split UI | Replace the single gig select |

---

## Task 1: The table and the backfill

**Files:**
- Create: `backend/migrations/0016_payment_allocations.sql`
- Modify: `backend/src/db/schema.ts`

- [ ] **Step 1: Write the migration**

```sql
-- Money is allocated to work, not attached to it.
--
-- payments.gig_id could express "this transfer paid for that gig" and
-- nothing else. An agency settling a week in one transfer had to be
-- entered as several fictional payments, each with its own date and its
-- own proof photo, none of which matched the bank statement.
--
-- payments.gig_id is NOT dropped here. Clients that were offline across
-- this release still send it, and routes/payments.ts translates it into
-- a single allocation. It goes when no client sends it.
CREATE TABLE payment_allocations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  payment_id TEXT NOT NULL REFERENCES payments(id),
  gig_id TEXT NOT NULL REFERENCES gigs(id),
  amount_cents INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  modified_at INTEGER NOT NULL,
  server_modified_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_payment_allocations_user ON payment_allocations(user_id);
CREATE INDEX idx_payment_allocations_payment ON payment_allocations(payment_id);
CREATE INDEX idx_payment_allocations_gig ON payment_allocations(gig_id);
CREATE INDEX idx_payment_allocations_user_server_modified
  ON payment_allocations(user_id, server_modified_at);

-- Every existing payment that named a gig becomes one allocation for
-- its whole amount. A payment that named no gig stays unallocated,
-- which is now a state the app can show rather than a hole.
INSERT INTO payment_allocations
  (id, user_id, payment_id, gig_id, amount_cents, created_at, modified_at, server_modified_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-a' ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  user_id, id, gig_id, amount_cents, created_at, modified_at, 0
FROM payments
WHERE gig_id IS NOT NULL;

-- The gig totals the backfill implies. From here on this column is
-- server-written only (services/paid-totals.ts).
UPDATE gigs SET amount_paid_cents = (
  SELECT SUM(a.amount_cents) FROM payment_allocations a WHERE a.gig_id = gigs.id
)
WHERE EXISTS (SELECT 1 FROM payment_allocations a WHERE a.gig_id = gigs.id);
```

- [ ] **Step 2: Apply it and check the backfill**

```bash
pnpm db:migrate:local
```

```bash
pnpm --filter gigsy-backend exec wrangler d1 execute gigsy-db --local --command "SELECT count(*) AS allocations FROM payment_allocations"
```

Expected: one row per pre-existing payment that named a gig. Use the database name from `backend/wrangler.toml`.

- [ ] **Step 3: Mirror it in Drizzle**

In `backend/src/db/schema.ts`, after `payments`:

```ts
/**
 * Which gigs a payment paid for, and how much of it went to each.
 *
 * `payments.gigId` remains for compatibility (routes/payments.ts turns
 * it into one of these), but this table is the truth. The sum for a gig
 * is written back to `gigs.amountPaidCents` by services/paid-totals.ts
 * — derived, server-owned, and never written by a client.
 *
 * Deliberately allowed: the allocations for a payment may sum to LESS
 * than the payment. A deposit can land before anyone knows which gigs
 * it covers, and refusing to record it until they do is how money stops
 * being recorded at all. More than the payment is rejected.
 */
export const paymentAllocations = sqliteTable(
  "payment_allocations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    paymentId: text("payment_id").notNull().references(() => payments.id),
    gigId: text("gig_id").notNull().references(() => gigs.id),
    amountCents: integer("amount_cents").notNull(),
    createdAt: integer("created_at").notNull(),
    modifiedAt: integer("modified_at").notNull(),
    serverModifiedAt: integer("server_modified_at").notNull().default(0),
  },
  (t) => ({
    userIdx: index("idx_payment_allocations_user").on(t.userId),
    paymentIdx: index("idx_payment_allocations_payment").on(t.paymentId),
    gigIdx: index("idx_payment_allocations_gig").on(t.gigId),
    userServerModifiedIdx: index("idx_payment_allocations_user_server_modified").on(
      t.userId,
      t.serverModifiedAt,
    ),
  }),
);
```

- [ ] **Step 4: Commit**

```bash
git add backend/migrations/0016_payment_allocations.sql backend/src/db/schema.ts
git commit -m "feat(db): payment allocations table and backfill"
```

---

## Task 2: The repo and the derived totals

**Files:**
- Create: `backend/src/repos/allocations.ts`, `backend/src/services/paid-totals.ts`
- Test: `backend/test/allocations-repo.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `backend/test/allocations-repo.test.ts`:

```ts
/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { AllocationsRepo } from "../src/repos/allocations.ts";
import { recomputePaidTotals } from "../src/services/paid-totals.ts";
// plus the file's usual db/user helpers from test/helpers/db.ts

describe("allocations", () => {
  it("splits one payment across two gigs", async () => {
    const repo = AllocationsRepo.for(env.DB);
    await repo.upsert(userId, id1, { paymentId, gigId: gigA, amountCents: 10000 }, { now: 1 });
    await repo.upsert(userId, id2, { paymentId, gigId: gigB, amountCents: 5000 }, { now: 1 });
    expect(await repo.listByPayment(userId, paymentId)).toHaveLength(2);
  });

  it("writes each gig's paid total back to the gig", async () => {
    await recomputePaidTotals(env.DB, userId, [gigA, gigB], 2);
    expect((await gigsRepo.get(userId, gigA))?.amountPaidCents).toBe(10000);
    expect((await gigsRepo.get(userId, gigB))?.amountPaidCents).toBe(5000);
  });

  it("nulls the total when the last allocation goes", async () => {
    await repo.remove(userId, id1);
    await recomputePaidTotals(env.DB, userId, [gigA], 3);
    expect((await gigsRepo.get(userId, gigA))?.amountPaidCents).toBeNull();
  });

  it("bumps serverModifiedAt so the change reaches other devices", async () => {
    const before = (await gigsRepo.get(userId, gigB))!.serverModifiedAt;
    await repo.upsert(userId, id3, { paymentId, gigId: gigB, amountCents: 1000 }, { now: 9 });
    await recomputePaidTotals(env.DB, userId, [gigB], 9);
    expect((await gigsRepo.get(userId, gigB))!.serverModifiedAt).toBeGreaterThan(before);
  });

  it("refuses another user's payment", async () => {
    const result = await repo.upsert(otherUserId, id1, { paymentId, gigId: gigA, amountCents: 1 }, { now: 4 });
    expect(result).toBe("forbidden");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter gigsy-backend exec vitest run test/allocations-repo.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the repo**

Create `backend/src/repos/allocations.ts` following `backend/src/repos/payments.ts` exactly: `AllocationData { paymentId, gigId, amountCents }`, `static for(d1)`, `list(userId)`, `listByPayment(userId, paymentId)`, `listByGig(userId, gigId)`, `get`, `upsert` returning `UpsertResult | "forbidden"`, `remove`. Do not invent a different contract — `services/sync.ts` dispatches over a shared shape.

- [ ] **Step 4: Write the recompute**

Create `backend/src/services/paid-totals.ts`:

```ts
/**
 * `gigs.amountPaidCents`, derived.
 *
 * The column used to be typed in by hand. It is now the sum of the
 * allocations against the gig, recomputed after every allocation write
 * — which means it is server-owned, exactly like `calendarEventId` and
 * `payments.confirmationR2Key`, and a client that sends one is ignored.
 *
 * Why keep a column at all rather than computing on read: every offline
 * client already reads this field, and a PWA holds its own copy of a
 * gig for as long as it likes. Deriving it on the server and shipping
 * it through the ordinary pull is what lets this change land without a
 * coordinated client release.
 *
 * `serverModifiedAt` is bumped deliberately: it is the watermark other
 * devices pull against, and a total that changes without it is a total
 * they never see.
 */
import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray, sql } from "drizzle-orm";
import { gigs, paymentAllocations } from "../db/schema.ts";

export async function recomputePaidTotals(
  d1: D1Database,
  userId: string,
  gigIds: readonly string[],
  now: number,
): Promise<void> {
  if (gigIds.length === 0) return;
  const db = drizzle(d1);
  const sums = await db
    .select({
      gigId: paymentAllocations.gigId,
      total: sql<number>`sum(${paymentAllocations.amountCents})`,
    })
    .from(paymentAllocations)
    .where(
      and(
        eq(paymentAllocations.userId, userId),
        inArray(paymentAllocations.gigId, [...gigIds]),
      ),
    )
    .groupBy(paymentAllocations.gigId);

  const byGig = new Map(sums.map((r) => [r.gigId, r.total]));
  for (const gigId of gigIds) {
    await db
      .update(gigs)
      // No allocations left means NULL, not 0: "nothing has been paid"
      // and "we know zero was paid" read the same in a total but not on
      // a screen, and null is what the rest of the app already means by
      // "not set".
      .set({ amountPaidCents: byGig.get(gigId) ?? null, serverModifiedAt: now })
      .where(and(eq(gigs.id, gigId), eq(gigs.userId, userId)));
  }
}
```

- [ ] **Step 5: Run to verify it passes**

```bash
pnpm --filter gigsy-backend exec vitest run test/allocations-repo.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add backend/src/repos/allocations.ts backend/src/services/paid-totals.ts backend/test/allocations-repo.test.ts
git commit -m "feat(payments): allocations repo and derived gig totals"
```

---

## Task 3: Validation, routes, and the `gigId` compatibility path

**Files:**
- Modify: `backend/src/domain/schemas.ts`, `backend/src/routes/payments.ts`, `backend/src/index.ts`
- Create: `backend/src/routes/allocations.ts`
- Test: `backend/test/allocations-routes.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `backend/test/allocations-routes.test.ts`, in the idiom of
`backend/test/payment-confirmation.test.ts` (the `api()` helper takes a
user id, a method, a path and a body):

```ts
/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";

const U1 = "user-1";
const U2 = "user-2";
const PAY = "44444444-dddd-4ddd-8ddd-444444444444";
const GIG_A = "11111111-aaaa-4aaa-8aaa-111111111111";
const GIG_B = "22222222-bbbb-4bbb-8bbb-222222222222";
const ALLOC_1 = "33333333-cccc-4ccc-8ccc-333333333333";
const ALLOC_2 = "55555555-eeee-4eee-8eee-555555555555";

const listFor = async (paymentId: string) =>
  ((await (await api(U1, "GET", `/api/allocations?paymentId=${paymentId}`)).json()) as {
    items: { id: string; gigId: string; amountCents: number }[];
  }).items;

const getGig = async (id: string) =>
  (await (await api(U1, "GET", `/api/gigs/${id}`)).json()) as {
    amountPaidCents: number | null;
  };

beforeEach(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
  await seedUser(env.DB, U2);
  await api(U1, "PUT", `/api/gigs/${GIG_A}`, { status: "completed", amountOfferedCents: 10000 });
  await api(U1, "PUT", `/api/gigs/${GIG_B}`, { status: "completed", amountOfferedCents: 5000 });
  await api(U1, "PUT", `/api/payments/${PAY}`, { amountCents: 10000 });
});

describe("allocation routes", () => {
  it("rejects a split larger than the payment", async () => {
    await api(U1, "PUT", `/api/allocations/${ALLOC_1}`, {
      paymentId: PAY, gigId: GIG_A, amountCents: 6000,
    });
    const second = await api(U1, "PUT", `/api/allocations/${ALLOC_2}`, {
      paymentId: PAY, gigId: GIG_B, amountCents: 6000,
    });
    expect(second.status).toBe(400);
  });

  it("allows a partial split and reports the remainder", async () => {
    await api(U1, "PUT", `/api/allocations/${ALLOC_1}`, {
      paymentId: PAY, gigId: GIG_A, amountCents: 6000,
    });
    const body = (await (await api(U1, "GET", `/api/payments/${PAY}`)).json()) as {
      allocatedCents: number;
      unallocatedCents: number;
    };
    expect(body.allocatedCents).toBe(6000);
    expect(body.unallocatedCents).toBe(4000);
  });

  it("updates the gig's derived paid total", async () => {
    await api(U1, "PUT", `/api/allocations/${ALLOC_1}`, {
      paymentId: PAY, gigId: GIG_A, amountCents: 6000,
    });
    expect((await getGig(GIG_A)).amountPaidCents).toBe(6000);
  });

  it("clears the total when the allocation goes", async () => {
    await api(U1, "PUT", `/api/allocations/${ALLOC_1}`, {
      paymentId: PAY, gigId: GIG_A, amountCents: 6000,
    });
    await api(U1, "DELETE", `/api/allocations/${ALLOC_1}`);
    expect((await getGig(GIG_A)).amountPaidCents).toBeNull();
  });

  it("refuses a gig that is not yours", async () => {
    const res = await api(U2, "PUT", `/api/allocations/${ALLOC_1}`, {
      paymentId: PAY, gigId: GIG_A, amountCents: 1000,
    });
    expect(res.status).toBe(400);
  });

  it("turns a legacy payment gigId into a single allocation", async () => {
    await api(U1, "PUT", `/api/payments/${PAY}`, { amountCents: 10000, gigId: GIG_A });
    const allocations = await listFor(PAY);
    expect(allocations).toHaveLength(1);
    expect(allocations[0]!.amountCents).toBe(10000);
    expect((await getGig(GIG_A)).amountPaidCents).toBe(10000);
  });

  it("does not double up when a legacy client re-sends the same payment", async () => {
    await api(U1, "PUT", `/api/payments/${PAY}`, { amountCents: 10000, gigId: GIG_A });
    await api(U1, "PUT", `/api/payments/${PAY}`, { amountCents: 10000, gigId: GIG_A });
    expect(await listFor(PAY)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Add the schema**

In `backend/src/domain/schemas.ts`:

```ts
export const AllocationInput = z.object({
  paymentId: entityId,
  gigId: entityId,
  // Positive like every other amount: a zero allocation is a deleted
  // allocation with extra steps.
  amountCents: positiveCents,
});
export type AllocationInputT = z.infer<typeof AllocationInput>;
```

- [ ] **Step 3: Write the routes**

Create `backend/src/routes/allocations.ts` following `backend/src/routes/payments.ts`. Every write:

1. checks the payment and the gig both belong to the caller (400 if not, as the gig routes do for `clientId`),
2. checks `sum(other allocations for this payment) + amountCents <= payment.amountCents` (400 with `"allocations exceed the payment"`),
3. calls `recomputePaidTotals` for the affected gig — and for the *previous* gig too when an allocation is moved.

Mount it in `backend/src/index.ts` beside the other routers, at `/api/allocations`.

Extend the payment GET response with `allocatedCents` and `unallocatedCents`, computed rather than stored.

- [ ] **Step 4: Write the compatibility path**

In `backend/src/routes/payments.ts`, after a successful upsert, when `input.gigId != null`:

```ts
// A client that was offline across the allocations release still sends
// payments.gigId. Translating it here — rather than refusing it — is
// what lets that outbox drain without losing the link between the money
// and the work. The allocation is keyed off the payment id, so a retry
// of the same op updates it instead of adding a second one.
await allocationsRepo.replaceSoleAllocation(userId, payment.id, input.gigId, input.amountCents, now);
await recomputePaidTotals(c.env.DB, userId, [input.gigId], now);
```

`replaceSoleAllocation` deletes any existing allocations for that payment and writes one — the idempotency the fifth test above asserts.

- [ ] **Step 5: Run and commit**

```bash
pnpm --filter gigsy-backend test
```

```bash
git add backend/src backend/test
git commit -m "feat(api): allocate a payment across gigs"
```

---

## Task 4: Sync

**Files:**
- Modify: `backend/src/services/sync.ts:25` and its dispatch, `backend/src/routes/sync.ts` if it enumerates entities
- Test: `backend/test/sync.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("round-trips an allocation and updates the gig total", async () => {
  const res = await postSync([
    { entity: "allocation", op: "upsert", id, modifiedAt: 1,
      payload: { paymentId, gigId, amountCents: 5000 } },
  ]);
  expect(res.status).toBe(200);
  expect((await getGig(gigId)).amountPaidCents).toBe(5000);
});

it("rejects an allocation against someone else's gig", async () => {
  const res = await postSync([
    { entity: "allocation", op: "upsert", id, modifiedAt: 1,
      payload: { paymentId, gigId: strangersGigId, amountCents: 5000 } },
  ]);
  expect((await res.json()).results[0].error).toMatch(/does not reference your gig/);
});

it("recomputes the total when an allocation is deleted", async () => {
  await postSync([{ entity: "allocation", op: "delete", id, modifiedAt: 2 }]);
  expect((await getGig(gigId)).amountPaidCents).toBeNull();
});
```

- [ ] **Step 2: Add the entity**

`backend/src/services/sync.ts`:

```ts
export type SyncEntity =
  | "client" | "gig" | "expense" | "service" | "payment" | "allocation";
```

Add `case "allocation"` mirroring the `service` case: parse with `AllocationInput`, verify both `paymentId` and `gigId` belong to the caller, upsert, then `recomputePaidTotals`. The delete path must recompute too — read the allocation's `gigId` **before** deleting it.

- [ ] **Step 3: Run and commit**

```bash
pnpm --filter gigsy-backend test
```

```bash
git add backend/src/services/sync.ts backend/test/sync.test.ts
git commit -m "feat(sync): allocations as the sixth entity"
```

---

## Task 5: Dashboard and reports read the derived totals

**Files:**
- Modify: `backend/src/services/dashboard.ts`, `backend/src/services/reports.ts`
- Test: `backend/test/dashboard.test.ts`, `backend/test/reports.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it("counts one payment split across two gigs once, in the right places", async () => {
  // $150 payment: $100 to gig A ($100 owed), $50 to gig B ($120 owed)
  const summary = await getDashboard();
  expect(summary.unpaidCents).toBe(7000); // only gig B's balance
  expect(summary.unpaidJobs.map((j) => j.gigId)).toEqual([gigB]);
});

it("reports the unallocated part of a payment as received but unassigned", async () => {
  const report = await getReport();
  expect(report.totals.paidCents).toBe(15000);
});
```

- [ ] **Step 2: Update the queries**

`dashboard.ts` reads `gigs.amount_paid_cents`, which is now derived, so most of it keeps working — the change is that nothing may write that column outside `paid-totals.ts`. Check the unpaid-jobs query at line 95 and `reports.ts` for anywhere `payments.gig_id` is joined; those joins become `payment_allocations`.

Report `paidCents` totals come from `payments.amountCents` where the report is about money received, and from allocations where it is about money per gig or per client. Make each query say which it means in a comment — this is the distinction that made the old model wrong.

- [ ] **Step 3: Run and commit**

```bash
pnpm --filter gigsy-backend test
```

```bash
git add backend/src/services backend/test
git commit -m "fix(reports): money follows allocations, not payment.gigId"
```

---

## Task 6: The offline path

**Files:**
- Modify: `webapp/src/lib/db.ts`, `types.ts`, `local-store.ts`, `data-service.ts`, `sync-engine.ts`, `api.ts`
- Test: `webapp/src/lib/local-store.test.ts`, `sync-engine.test.ts`

- [ ] **Step 1: Add the Dexie store**

`webapp/src/lib/db.ts`:

```ts
export type SyncEntityName =
  | "client" | "gig" | "expense" | "service" | "payment" | "allocation";
```

```ts
  allocations!: EntityTable<Allocation, "id">;
```

```ts
    // v3: payment allocations — a payment can cover several gigs.
    this.version(3).stores({
      allocations: "id, paymentId, gigId, modifiedAt",
    });
```

- [ ] **Step 2: Add the type**

`webapp/src/lib/types.ts`:

```ts
/** How much of a payment went to one gig. A payment may have several,
 *  and they may sum to less than the payment (see PaymentEdit). */
export interface Allocation {
  id: string;
  paymentId: string;
  gigId: string;
  amountCents: number;
  createdAt: number;
  modifiedAt: number;
}

export interface AllocationInput {
  paymentId: string;
  gigId: string;
  amountCents: number;
}
```

Add `Allocation` to the `ServerRecord` union in `local-store.ts` and to `tableOf`.

- [ ] **Step 3: Write the failing store test**

```ts
it("queues an allocation and lists it by payment", async () => {
  const store = makeStore();
  const id = crypto.randomUUID();
  await store.putAllocation(id, { paymentId, gigId, amountCents: 5000 });
  expect(await store.listAllocationsByPayment(paymentId)).toHaveLength(1);
  expect((await store.pendingOp("allocation", id))?.payload).toEqual({
    paymentId, gigId, amountCents: 5000,
  });
});
```

- [ ] **Step 4: Implement `putAllocation` / `removeAllocation` / `listAllocationsByPayment` / `listAllocationsByGig`**

Follow `putPayment` exactly, including the `OutboxPayload<AllocationInput>` annotation — that `Required<T>` is what turns a forgotten field into a compile error.

- [ ] **Step 5: Pull them**

`webapp/src/lib/sync-engine.ts` — add to `pull()`:

```ts
      await this.pullEntity("allocation", await this.api.listAllocations());
```

and add `allocation` to the `getters` map in `refreshFromServer`. Add `listAllocations` / `putAllocation` / `deleteAllocation` to `webapp/src/lib/api.ts` and to `data-service.ts`.

- [ ] **Step 6: Run and commit**

```bash
pnpm --filter gigsy-webapp test && pnpm --filter gigsy-webapp typecheck
```

```bash
git add webapp/src/lib
git commit -m "feat(offline): allocations sync like every other entity"
```

---

## Task 7: The payment screen

**Files:**
- Modify: `webapp/src/screens/PaymentEdit.tsx`
- Modify: `webapp/src/screens/GigDetail.tsx` (payments section)

- [ ] **Step 1: Replace the single gig select**

The `gigId` select becomes a list of splits: each row is a gig select plus an amount, with an "+ Add gig" action and a remove control per row. Under it:

```tsx
<p data-testid="payment-unallocated" className="text-sm text-slate-600">
  {unallocated === 0
    ? "Fully allocated"
    : `Unallocated ${formatMoney(unallocated)}`}
</p>
```

```tsx
/** Deliberately allowed to be positive. A transfer can land before you
 *  know which gigs it covers, and refusing to save it until you do is
 *  how a payment ends up not recorded at all. Over-allocation is what
 *  gets rejected — that one is always an error. */
const unallocated = amountCents - allocations.reduce((s, a) => s + a.amountCents, 0);
```

Each row saves as its own allocation record, so a half-finished split still survives a reload.

- [ ] **Step 2: Show the split on the gig**

In `GigDetail`'s payments section, list this gig's allocations rather than payments whose `gigId` matches, showing the payment's date and the amount allocated to *this* gig, with the payment's total beside it when they differ.

- [ ] **Step 3: Remove the hand-typed Paid field**

Delete the Paid (`gig-paid`) input from `GigEdit.tsx` and its help target — the value is derived now, and an editable copy of a derived number is a bug waiting to be filed. `GigDetail` shows the derived total with the paid badge.

- [ ] **Step 4: Write the e2e**

```ts
test("one payment covers two gigs", async ({ page }) => {
  // create two gigs, one payment of $150, split $100 / $50,
  // assert each gig's detail screen shows its own paid total,
  // assert the payment screen shows "Fully allocated",
  // then reduce one split and assert the remainder appears.
});
```

- [ ] **Step 5: Run everything and commit**

```bash
pnpm --filter gigsy-webapp test && pnpm --filter gigsy-webapp test:e2e && pnpm --filter gigsy-webapp help:validate
```

```bash
git add webapp/src webapp/e2e
git commit -m "feat(payments): split one payment across several gigs"
```

---

## Task 8: Export and docs

**Files:**
- Modify: `webapp/src/lib/report-export.ts`, `docs/plan.md`

- [ ] **Step 1: Update the CSV**

`report-export.ts` has a `"paid"` column header at line 62 and 77. The per-gig paid figure now comes from allocations; confirm the exported number matches what the gig screen shows, and add a test in `report-export.test.ts` covering a gig paid by a split payment.

- [ ] **Step 2: Document the model**

In `docs/plan.md`, update the payments section: a payment is money received, an allocation says which work it paid for, `gigs.amountPaidCents` is derived and server-owned, and `payments.gigId` is a compatibility shim due for removal.

- [ ] **Step 3: Commit**

```bash
git add webapp/src/lib/report-export.ts webapp/src/lib/report-export.test.ts docs/plan.md
git commit -m "docs: record the allocation model"
```

---

## Verification

- [ ] `pnpm test` passes in both packages
- [ ] `pnpm typecheck` passes
- [ ] `pnpm --filter gigsy-webapp test:e2e` passes
- [ ] Manually: one $150 payment split $100/$50 shows the right paid total on both gigs and the right outstanding figure on the dashboard
- [ ] Manually: a payment recorded with no split shows its full amount as unallocated
- [ ] Manually: a client still on the previous build can save a payment with a gig attached and it arrives as one allocation
- [ ] `payments.gig_id` still exists and is still written — dropping it is a later release
