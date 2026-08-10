import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { openUserDb } from "./db.ts";
import { LocalStore } from "./local-store.ts";

let dbSeq = 0;

function makeStore(clockValue = () => 1000, userId = `u-${++dbSeq}`) {
  const db = openUserDb(userId);
  return { store: new LocalStore(db, clockValue), db, userId };
}

const G1 = "11111111-1111-4111-8111-111111111111";
const G2 = "22222222-2222-4222-8222-222222222222";
const C1 = "33333333-3333-4333-8333-333333333333";

describe("LocalStore CRUD + outbox", () => {
  it("putGig stores a readable record with clock timestamps", async () => {
    const { store } = makeStore(() => 1000);
    await store.putGig(G1, { status: "lead", location: "Costco" });

    const gig = await store.getGig(G1);
    expect(gig?.location).toBe("Costco");
    expect(gig?.createdAt).toBe(1000);
    expect(gig?.modifiedAt).toBe(1000);
  });

  it("second put preserves createdAt, bumps modifiedAt", async () => {
    let now = 1000;
    const { store } = makeStore(() => now);
    await store.putGig(G1, { status: "lead" });
    now = 2000;
    await store.putGig(G1, { status: "confirmed" });

    const gig = await store.getGig(G1);
    expect(gig?.status).toBe("confirmed");
    expect(gig?.createdAt).toBe(1000);
    expect(gig?.modifiedAt).toBe(2000);
  });

  it("keeps ONE pending op per entity+id, latest payload wins", async () => {
    let now = 1000;
    const { store } = makeStore(() => now);
    await store.putGig(G1, { status: "lead" });
    now = 2000;
    await store.putGig(G1, { status: "paid" });

    const ops = await store.pendingOps();
    expect(ops).toHaveLength(1);
    expect(ops[0]?.op).toBe("upsert");
    expect(ops[0]?.modifiedAt).toBe(2000);
    expect((ops[0]?.payload as { status: string }).status).toBe("paid");
  });

  it("remove deletes locally and converts the pending op to a delete", async () => {
    const { store } = makeStore();
    await store.putGig(G1, { status: "lead" });
    await store.removeGig(G1);

    expect(await store.getGig(G1)).toBeNull();
    const ops = await store.pendingOps();
    expect(ops).toHaveLength(1);
    expect(ops[0]?.op).toBe("delete");
    expect(ops[0]?.entity).toBe("gig");
  });

  it("lists gigs newest-date-first (mirrors the API ordering)", async () => {
    const { store } = makeStore();
    await store.putGig(G1, { dateTime: 100 });
    await store.putGig(G2, { dateTime: 200 });

    const gigs = await store.listGigs();
    expect(gigs.map((g) => g.id)).toEqual([G2, G1]);
  });

  it("orders pending ops oldest-first across entities", async () => {
    let now = 1000;
    const { store } = makeStore(() => now++);
    await store.putClient(C1, { name: "Acme" });
    await store.putGig(G1, { status: "lead" });

    const ops = await store.pendingOps();
    expect(ops.map((o) => o.entity)).toEqual(["client", "gig"]);
  });

  it("applyServerRecord writes locally WITHOUT enqueueing an op", async () => {
    const { store } = makeStore();
    await store.applyServerRecord("gig", {
      id: G1,
      clientId: null,
      status: "paid",
      location: null,
      dateTime: null,
      durationMinutes: null,
      calendarEventId: null,
      amountOfferedCents: 5000,
      amountPaidCents: 5000,
      notes: null,
      source: "manual",
      createdAt: 1,
      modifiedAt: 2,
    });

    expect((await store.getGig(G1))?.status).toBe("paid");
    expect(await store.pendingOps()).toHaveLength(0);
  });

  it("deleteOp clears a drained op; pendingCount tracks", async () => {
    const { store } = makeStore();
    await store.putGig(G1, { status: "lead" });
    const ops = await store.pendingOps();
    expect(await store.pendingCount()).toBe(1);

    await store.deleteOp(ops[0]!.opKey);
    expect(await store.pendingCount()).toBe(0);
  });

  it("outbox and records survive an app restart (new instances, same DB)", async () => {
    // Simulates a killed app: the first store/db go away, a fresh
    // Dexie instance over the SAME database must see everything.
    const userId = "restart-user";
    const first = new LocalStore(openUserDb(userId), () => 1000);
    await first.putGig(G1, { status: "lead", location: "made offline" });

    const second = new LocalStore(openUserDb(userId), () => 2000);
    expect((await second.getGig(G1))?.location).toBe("made offline");
    const ops = await second.pendingOps();
    expect(ops).toHaveLength(1);
    expect(ops[0]?.op).toBe("upsert");
  });

  it("stores services and payments with byGig queries and outbox ops", async () => {
    const { store } = makeStore(() => 1000);
    const PAY = "44444444-4444-4444-8444-444444444444";
    const SVC = "55555555-5555-4555-8555-555555555555";

    await store.putGig(G1, { status: "confirmed" });
    await store.putPayment(PAY, { gigId: G1, amountCents: 5000 });
    await store.putService(SVC, {
      gigId: G1,
      description: "Extra table",
      amountOfferedCents: 5000,
      paymentId: PAY,
      isCompleted: true,
    });

    const services = await store.listServicesByGig(G1);
    expect(services).toHaveLength(1);
    expect(services[0]?.isCompleted).toBe(true);
    expect((await store.listPaymentsByGig(G1))[0]?.amountCents).toBe(5000);

    const ops = await store.pendingOps();
    expect(ops.map((o) => o.entity).sort()).toEqual(["gig", "payment", "service"]);
  });

  it("removing a service enqueues its delete op", async () => {
    const { store } = makeStore();
    const SVC = "55555555-5555-4555-8555-555555555555";
    await store.putGig(G1, {});
    await store.putService(SVC, { gigId: G1, description: "x" });
    await store.removeService(SVC);

    expect(await store.getService(SVC)).toBeNull();
    const op = (await store.pendingOps()).find((o) => o.entity === "service");
    expect(op?.op).toBe("delete");
  });

  it("different users get isolated databases", async () => {
    const a = makeStore(() => 1, "user-a");
    const b = makeStore(() => 1, "user-b");
    await a.store.putGig(G1, { status: "lead" });

    expect(await b.store.getGig(G1)).toBeNull();
  });
});
