/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { AllocationsRepo } from "../src/repos/allocations.ts";
import { GigsRepo } from "../src/repos/gigs.ts";
import { recomputePaidTotals } from "../src/services/paid-totals.ts";

const U1 = "user-1";
const U2 = "user-2";
const PAY = "44444444-dddd-4ddd-8ddd-444444444444";
const GIG_A = "11111111-aaaa-4aaa-8aaa-111111111111";
const GIG_B = "22222222-bbbb-4bbb-8bbb-222222222222";

async function seedGig(id: string, userId: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO gigs (id, user_id, created_at, modified_at) VALUES (?, ?, ?, ?)",
  )
    .bind(id, userId, 1, 1)
    .run();
}

async function seedPayment(id: string, userId: string, amountCents: number): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO payments (id, user_id, amount_cents, created_at, modified_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, userId, amountCents, 1, 1)
    .run();
}

// beforeAll seeds the fixed cast of users/gigs/payment that every test
// below reuses. vitest-pool-workers' isolated storage rolls back each
// test's own writes, so every `it` creates the allocations it needs and
// none of them see another test's rows.
beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
  await seedUser(env.DB, U2);
  await seedGig(GIG_A, U1);
  await seedGig(GIG_B, U1);
  await seedPayment(PAY, U1, 15000);
});

describe("AllocationsRepo", () => {
  it("splits one payment across two gigs", async () => {
    const repo = AllocationsRepo.for(env.DB);
    await repo.upsert(
      U1,
      crypto.randomUUID(),
      { paymentId: PAY, gigId: GIG_A, amountCents: 10000 },
      { now: 1 },
    );
    await repo.upsert(
      U1,
      crypto.randomUUID(),
      { paymentId: PAY, gigId: GIG_B, amountCents: 5000 },
      { now: 1 },
    );
    expect(await repo.listByPayment(U1, PAY)).toHaveLength(2);
  });

  it("refuses another user's payment", async () => {
    const repo = AllocationsRepo.for(env.DB);
    const result = await repo.upsert(
      U2,
      crypto.randomUUID(),
      { paymentId: PAY, gigId: GIG_A, amountCents: 1 },
      { now: 4 },
    );
    expect(result).toBe("forbidden");
  });

  it("refuses a gig that isn't the caller's, even against their own payment", async () => {
    const repo = AllocationsRepo.for(env.DB);
    const strangersGig = crypto.randomUUID();
    await seedGig(strangersGig, U2);
    const result = await repo.upsert(
      U1,
      crypto.randomUUID(),
      { paymentId: PAY, gigId: strangersGig, amountCents: 1 },
      { now: 4 },
    );
    expect(result).toBe("forbidden");
  });

  it("lists only the allocations against one gig", async () => {
    const repo = AllocationsRepo.for(env.DB);
    await repo.upsert(
      U1,
      crypto.randomUUID(),
      { paymentId: PAY, gigId: GIG_A, amountCents: 10000 },
      { now: 1 },
    );
    await repo.upsert(
      U1,
      crypto.randomUUID(),
      { paymentId: PAY, gigId: GIG_B, amountCents: 5000 },
      { now: 1 },
    );

    const forA = await repo.listByGig(U1, GIG_A);
    expect(forA).toHaveLength(1);
    expect(forA[0]!.amountCents).toBe(10000);
    expect(await repo.listByGig(U1, GIG_B)).toHaveLength(1);
  });

  it("does not let one user read another user's allocation", async () => {
    const repo = AllocationsRepo.for(env.DB);
    const id = crypto.randomUUID();
    await repo.upsert(
      U1,
      id,
      { paymentId: PAY, gigId: GIG_A, amountCents: 10000 },
      { now: 1 },
    );

    expect(await repo.get(U2, id)).toBeNull();
    expect(await repo.list(U2)).toHaveLength(0);
  });
});

// The guard lives on the repo method rather than only in
// services/payment-invariants.ts because there are three callers, not
// two: routes/payments.ts and services/sync.ts share the invariants
// module, but routes/drafts.ts's confirm-payment does not — it runs its
// own gigId ownership check and calls this method directly. A guard
// only in the invariants module would leave that door open, and any
// future caller with it.
describe("AllocationsRepo.replaceSoleAllocation", () => {
  const rowsFor = async (paymentId: string) =>
    (
      await env.DB.prepare(
        "SELECT gig_id AS gigId, amount_cents AS amountCents FROM payment_allocations WHERE payment_id = ? ORDER BY gig_id",
      )
        .bind(paymentId)
        .all<{ gigId: string; amountCents: number }>()
    ).results;

  it("writes one allocation when the payment has none — the creation path", async () => {
    const repo = AllocationsRepo.for(env.DB);
    const affected = await repo.replaceSoleAllocation(U1, PAY, GIG_A, 15000, 5);
    expect(affected).toEqual([GIG_A]);
    expect(await rowsFor(PAY)).toEqual([{ gigId: GIG_A, amountCents: 15000 }]);
  });

  it("replaces a lone allocation and reports the gig it moved away from", async () => {
    const repo = AllocationsRepo.for(env.DB);
    await repo.upsert(
      U1,
      crypto.randomUUID(),
      { paymentId: PAY, gigId: GIG_A, amountCents: 4000 },
      { now: 1 },
    );

    const affected = await repo.replaceSoleAllocation(U1, PAY, GIG_B, 15000, 5);
    expect([...affected].sort()).toEqual([GIG_A, GIG_B].sort());
    expect(await rowsFor(PAY)).toEqual([{ gigId: GIG_B, amountCents: 15000 }]);
  });

  it("declines to collapse a split, and reports no gig as affected", async () => {
    const repo = AllocationsRepo.for(env.DB);
    await repo.upsert(
      U1,
      crypto.randomUUID(),
      { paymentId: PAY, gigId: GIG_A, amountCents: 4000 },
      { now: 1 },
    );
    await repo.upsert(
      U1,
      crypto.randomUUID(),
      { paymentId: PAY, gigId: GIG_B, amountCents: 3000 },
      { now: 1 },
    );

    const affected = await repo.replaceSoleAllocation(U1, PAY, GIG_A, 15000, 5);

    // Empty, not [GIG_A]: nothing moved, so nothing needs recomputing —
    // and a caller that recomputed GIG_A anyway would only rewrite the
    // same 4000 it already holds.
    expect(affected).toEqual([]);
    expect(await rowsFor(PAY)).toEqual([
      { gigId: GIG_A, amountCents: 4000 },
      { gigId: GIG_B, amountCents: 3000 },
    ]);
  });

  it("counts rows, not distinct gigs — two allocations to one gig are still a split", async () => {
    // Nothing forbids two rows against the same gig, and a payment
    // holding two rows was necessarily written by an allocations-aware
    // client. A legacy payload has no business rewriting either.
    const repo = AllocationsRepo.for(env.DB);
    await repo.upsert(
      U1,
      crypto.randomUUID(),
      { paymentId: PAY, gigId: GIG_A, amountCents: 4000 },
      { now: 1 },
    );
    await repo.upsert(
      U1,
      crypto.randomUUID(),
      { paymentId: PAY, gigId: GIG_A, amountCents: 3000 },
      { now: 1 },
    );

    expect(await repo.replaceSoleAllocation(U1, PAY, GIG_A, 15000, 5)).toEqual([]);
    expect(await rowsFor(PAY)).toHaveLength(2);
  });

  it("ignores another payment's allocations when deciding", async () => {
    // The count must be scoped to this payment — a second payment
    // carrying its own allocation must not make this one look split.
    const repo = AllocationsRepo.for(env.DB);
    const otherPayment = crypto.randomUUID();
    await seedPayment(otherPayment, U1, 5000);
    await repo.upsert(
      U1,
      crypto.randomUUID(),
      { paymentId: otherPayment, gigId: GIG_B, amountCents: 5000 },
      { now: 1 },
    );
    await repo.upsert(
      U1,
      crypto.randomUUID(),
      { paymentId: PAY, gigId: GIG_A, amountCents: 4000 },
      { now: 1 },
    );

    await repo.replaceSoleAllocation(U1, PAY, GIG_A, 15000, 5);
    expect(await rowsFor(PAY)).toEqual([{ gigId: GIG_A, amountCents: 15000 }]);
    expect(await rowsFor(otherPayment)).toEqual([{ gigId: GIG_B, amountCents: 5000 }]);
  });
});

describe("recomputePaidTotals", () => {
  it("writes each gig's paid total back to the gig", async () => {
    const repo = AllocationsRepo.for(env.DB);
    const gigsRepo = GigsRepo.for(env.DB);
    await repo.upsert(
      U1,
      crypto.randomUUID(),
      { paymentId: PAY, gigId: GIG_A, amountCents: 10000 },
      { now: 1 },
    );
    await repo.upsert(
      U1,
      crypto.randomUUID(),
      { paymentId: PAY, gigId: GIG_B, amountCents: 5000 },
      { now: 1 },
    );

    await recomputePaidTotals(env.DB, U1, [GIG_A, GIG_B], 2);

    expect((await gigsRepo.get(U1, GIG_A))?.amountPaidCents).toBe(10000);
    expect((await gigsRepo.get(U1, GIG_B))?.amountPaidCents).toBe(5000);
  });

  it("nulls the total when the last allocation goes, rather than leaving zero", async () => {
    const repo = AllocationsRepo.for(env.DB);
    const gigsRepo = GigsRepo.for(env.DB);
    const id = crypto.randomUUID();
    await repo.upsert(
      U1,
      id,
      { paymentId: PAY, gigId: GIG_A, amountCents: 10000 },
      { now: 1 },
    );
    await recomputePaidTotals(env.DB, U1, [GIG_A], 2);
    expect((await gigsRepo.get(U1, GIG_A))?.amountPaidCents).toBe(10000);

    await repo.remove(U1, id);
    await recomputePaidTotals(env.DB, U1, [GIG_A], 3);

    expect((await gigsRepo.get(U1, GIG_A))?.amountPaidCents).toBeNull();
  });

  it("bumps the gig's serverModifiedAt so the new total reaches other devices", async () => {
    const repo = AllocationsRepo.for(env.DB);
    const gigsRepo = GigsRepo.for(env.DB);
    const before = (await gigsRepo.get(U1, GIG_B))!.serverModifiedAt;

    await repo.upsert(
      U1,
      crypto.randomUUID(),
      { paymentId: PAY, gigId: GIG_B, amountCents: 1000 },
      { now: 9 },
    );
    await recomputePaidTotals(env.DB, U1, [GIG_B], 9);

    expect((await gigsRepo.get(U1, GIG_B))!.serverModifiedAt).toBeGreaterThan(before);
  });

  it("is a no-op for an empty gig list, rather than touching every gig", async () => {
    const gigsRepo = GigsRepo.for(env.DB);
    const before = await gigsRepo.get(U1, GIG_A);

    await recomputePaidTotals(env.DB, U1, [], 99);

    const after = await gigsRepo.get(U1, GIG_A);
    expect(after?.amountPaidCents).toBe(before?.amountPaidCents);
    expect(after?.serverModifiedAt).toBe(before?.serverModifiedAt);
  });
});
