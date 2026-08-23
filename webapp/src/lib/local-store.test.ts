import "fake-indexeddb/auto";
import Dexie from "dexie";
import { describe, it, expect } from "vitest";
import { openUserDb } from "./db.ts";
import { LocalStore } from "./local-store.ts";
import { MAX_IMAGE_BYTES, MAX_QUEUE_BYTES } from "./image-queue.ts";
import type { Allocation, Payment } from "./types.ts";

let dbSeq = 0;

function makeStore(
  clockValue = () => 1000,
  userId = `u-${++dbSeq}`,
  newId: () => string = () => crypto.randomUUID(),
) {
  const db = openUserDb(userId);
  return { store: new LocalStore(db, clockValue, newId), db, userId };
}

const G1 = "11111111-1111-4111-8111-111111111111";
const G2 = "22222222-2222-4222-8222-222222222222";
const C1 = "33333333-3333-4333-8333-333333333333";
const P1 = "44444444-4444-4444-8444-444444444444";
const A1 = "55555555-5555-4555-8555-555555555555";
const A2 = "77777777-7777-4777-8777-777777777777";

describe("LocalStore CRUD + outbox", () => {
  it("putGig stores a readable record with clock timestamps", async () => {
    const { store } = makeStore(() => 1000);
    await store.putGig(G1, { status: "lead", location: "Costco" });

    const gig = await store.getGig(G1);
    expect(gig?.location).toBe("Costco");
    expect(gig?.createdAt).toBe(1000);
    expect(gig?.modifiedAt).toBe(1000);
  });

  it("putGig leaves expectedCents to the server and never sends it", async () => {
    const { store } = makeStore();
    await store.putGig(G1, {
      status: "confirmed",
      payType: "hourly",
      hourlyRateCents: 5000,
      durationMinutes: 480,
    });

    // Null, not the local derivation: the field means "what the server
    // said", and this edit has just invalidated whatever it last said.
    // The screens derive on read instead (storedOrDerivedExpectedCents).
    expect((await store.getGig(G1))?.expectedCents).toBeNull();

    // The one field that must NOT be in the payload, against the rule
    // the OutboxPayload comment states — it is derived and server-owned,
    // and GigInput has no such key.
    const payload = (await store.pendingOps())[0]?.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty("expectedCents");
    // Guard against the assertion above passing on an empty payload.
    expect(payload["hourlyRateCents"]).toBe(5000);
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
    await store.putGig(G1, { status: "completed" });

    const ops = await store.pendingOps();
    expect(ops).toHaveLength(1);
    expect(ops[0]?.op).toBe("upsert");
    expect(ops[0]?.modifiedAt).toBe(2000);
    expect((ops[0]?.payload as { status: string }).status).toBe("completed");
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
      title: null,
      status: "completed",
      location: null,
      dateTime: null,
      durationMinutes: null,
      payType: "fixed",
      hourlyRateCents: null,
      workStartedAt: null,
      workEndedAt: null,
      breakMinutes: null,
      calendarEventId: null,
      amountOfferedCents: 5000,
      amountPaidCents: 5000,
      expectedCents: null,
      notes: null,
      source: "manual",
      createdAt: 1,
      modifiedAt: 2,
    });

    expect((await store.getGig(G1))?.status).toBe("completed");
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
    // Four, not three: a payment given a gig now queues the allocation
    // that says so, because the payment op itself no longer carries
    // `gigId` (see the allocations suite at the bottom of this file).
    expect(ops.map((o) => o.entity).sort()).toEqual([
      "allocation",
      "gig",
      "payment",
      "service",
    ]);
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

describe("pendingIds", () => {
  it("names the records with unsent changes", async () => {
    const { store } = makeStore();
    await store.putGig(G1, { status: "lead" });
    await store.putGig(G2, { status: "lead" });

    expect(await store.pendingIds("gig")).toEqual(new Set([G1, G2]));
  });

  it("is empty once the ops are drained", async () => {
    const { store } = makeStore();
    await store.putGig(G1, { status: "lead" });
    for (const op of await store.pendingOps()) await store.deleteOp(op.opKey);

    expect(await store.pendingIds("gig")).toEqual(new Set());
  });

  it("does not mix entities", async () => {
    const { store } = makeStore();
    await store.putGig(G1, { status: "lead" });
    await store.putClient(C1, { name: "Acme" });

    expect(await store.pendingIds("gig")).toEqual(new Set([G1]));
    expect(await store.pendingIds("client")).toEqual(new Set([C1]));
  });

  it("includes a record queued for deletion", async () => {
    // It still differs from the server until the delete is sent.
    const { store } = makeStore();
    await store.putGig(G1, { status: "lead" });
    for (const op of await store.pendingOps()) await store.deleteOp(op.opKey);
    await store.removeGig(G1);

    expect(await store.pendingIds("gig")).toEqual(new Set([G1]));
  });
});

/**
 * The outbox payload is what the server actually receives. It is built
 * by hand, field by field, and a field left out of it is a field the
 * user loses — silently, because the local record still has it and the
 * screen still shows it until the next pull overwrites it.
 *
 * That is not hypothetical. `durationMinutes` and `reimbursable` were
 * both added in Phase 9 (946673b), both added to the record, and
 * neither added to the payload. Every gig saved since then reached the
 * server with no duration, which the calendar sync then rendered as its
 * four-hour fallback.
 *
 * TypeScript could not help: both fields are optional on their input
 * types, so an object literal that omits them is perfectly valid.
 */
describe("the outbox payload carries everything the server accepts", () => {
  it("sends the gig's duration", async () => {
    const { store } = makeStore();
    await store.putGig(G1, { status: "confirmed", durationMinutes: 90 });

    const op = (await store.pendingOps()).find((o) => o.entity === "gig");

    expect((op?.payload as { durationMinutes?: number }).durationMinutes).toBe(90);
  });

  it("sends a duration of null when there isn't one", async () => {
    // Distinct from omitting the key: null is "the user said no
    // duration", absent is "we forgot to tell you".
    const { store } = makeStore();
    await store.putGig(G1, { status: "confirmed" });

    const op = (await store.pendingOps()).find((o) => o.entity === "gig");

    expect(op?.payload).toHaveProperty("durationMinutes");
    expect((op?.payload as { durationMinutes: number | null }).durationMinutes).toBeNull();
  });

  it("sends every gig field the server will accept", async () => {
    // An exact key set, so the NEXT field added to a gig cannot be
    // added to the record and forgotten here.
    const { store } = makeStore();
    await store.putGig(G1, { status: "confirmed", durationMinutes: 90 });

    const op = (await store.pendingOps()).find((o) => o.entity === "gig");

    expect(Object.keys(op?.payload as object).sort()).toEqual([
      "amountOfferedCents",
      "amountPaidCents",
      "breakMinutes",
      "clientId",
      "dateTime",
      "durationMinutes",
      "hourlyRateCents",
      "location",
      "notes",
      "payType",
      "source",
      "status",
      "title",
      "workEndedAt",
      "workStartedAt",
    ]);
  });

  it("sends an hourly gig's rate and work log to both the record and the outbox payload", async () => {
    // Same bug class as durationMinutes/reimbursable (see the header
    // comment on OutboxPayload): these five fields were added together,
    // so a screen that logs a shift must have both halves land, not
    // just the local copy the screen itself reads back.
    const { store } = makeStore();
    await store.putGig(G1, {
      status: "confirmed",
      payType: "hourly",
      hourlyRateCents: 5000,
      workStartedAt: 1_000,
      workEndedAt: 15_000,
      breakMinutes: 5,
    });

    const gig = await store.getGig(G1);
    expect(gig?.payType).toBe("hourly");
    expect(gig?.hourlyRateCents).toBe(5000);
    expect(gig?.workStartedAt).toBe(1_000);
    expect(gig?.workEndedAt).toBe(15_000);
    expect(gig?.breakMinutes).toBe(5);

    const op = (await store.pendingOps()).find((o) => o.entity === "gig");
    const payload = op?.payload as {
      payType?: string;
      hourlyRateCents?: number | null;
      workStartedAt?: number | null;
      workEndedAt?: number | null;
      breakMinutes?: number | null;
    };
    expect(payload.payType).toBe("hourly");
    expect(payload.hourlyRateCents).toBe(5000);
    expect(payload.workStartedAt).toBe(1_000);
    expect(payload.workEndedAt).toBe(15_000);
    expect(payload.breakMinutes).toBe(5);
  });

  it("sends the expense's reimbursable flag", async () => {
    // Same bug, same commit: the server defaults this to false, so a
    // dropped `true` reads as the user having said "I'll absorb this".
    const { store } = makeStore();
    const E1 = "66666666-6666-4666-8666-666666666666";
    await store.putExpense(E1, { amountCents: 2500, reimbursable: true });

    const op = (await store.pendingOps()).find((o) => o.entity === "expense");

    expect((op?.payload as { reimbursable?: boolean }).reimbursable).toBe(true);
  });

  it("sends every expense field the server will accept", async () => {
    const { store } = makeStore();
    const E1 = "66666666-6666-4666-8666-666666666666";
    await store.putExpense(E1, { amountCents: 2500, reimbursable: true });

    const op = (await store.pendingOps()).find((o) => o.entity === "expense");

    expect(Object.keys(op?.payload as object).sort()).toEqual([
      "amountCents",
      "category",
      "gigId",
      "notes",
      "reimbursable",
    ]);
  });
});

// ── Phase 4: allocations, and the legacy `gigId` migration ─────────
//
// The rule these tests exist to hold in place: this build manages a
// payment's allocations itself and therefore must NOT send
// `PaymentInput.gigId`. Server-side that field triggers
// `AllocationsRepo.replaceSoleAllocation`, which rewrites a payment's
// allocations to a single one for the payment's FULL amount. Its guard
// only spares a payment carrying more than one, so a payment split
// 50.00 with 100.00 deliberately unallocated — the exact state the
// split editor exists to create — would come back rewritten to 150.00
// with the remainder gone.
describe("LocalStore allocations", () => {
  it("queues an allocation and lists it by payment and by gig", async () => {
    const { store } = makeStore();

    await store.putAllocation(A1, { paymentId: P1, gigId: G1, amountCents: 5000 });

    expect(await store.listAllocationsByPayment(P1)).toHaveLength(1);
    expect(await store.listAllocationsByGig(G1)).toHaveLength(1);
    expect((await store.getAllocation(A1))?.amountCents).toBe(5000);
    const op = (await store.pendingOps()).find((o) => o.entity === "allocation");
    expect(op?.op).toBe("upsert");
    expect(op?.payload).toEqual({ paymentId: P1, gigId: G1, amountCents: 5000 });
  });

  it("sends every allocation field the server will accept, and no other", async () => {
    const { store } = makeStore();
    await store.putAllocation(A1, { paymentId: P1, gigId: G1, amountCents: 5000 });

    const op = (await store.pendingOps()).find((o) => o.entity === "allocation");

    expect(Object.keys(op?.payload as object).sort()).toEqual([
      "amountCents",
      "gigId",
      "paymentId",
    ]);
  });

  it("removeAllocation deletes locally and queues the delete", async () => {
    const { store } = makeStore();
    await store.putAllocation(A1, { paymentId: P1, gigId: G1, amountCents: 5000 });

    await store.removeAllocation(A1);

    expect(await store.getAllocation(A1)).toBeNull();
    const op = (await store.pendingOps()).find((o) => o.entity === "allocation");
    expect(op?.op).toBe("delete");
  });

  it("putPayment NEVER sends gigId — it writes the allocation instead", async () => {
    const { store } = makeStore(() => 1000, `u-${++dbSeq}`, () => A1);

    await store.putPayment(P1, { gigId: G1, amountCents: 15000, notes: "cheque" });

    const paymentOp = (await store.pendingOps()).find((o) => o.entity === "payment");
    // The field that would trigger the server's compat rewrite.
    expect(paymentOp?.payload).not.toHaveProperty("gigId");
    // Guard against that assertion passing on an empty payload.
    expect(Object.keys(paymentOp?.payload as object).sort()).toEqual([
      "amountCents",
      "clientId",
      "notes",
      "paidAt",
    ]);
    // The link itself, now expressed the way the server can act on.
    expect(await store.listAllocationsByPayment(P1)).toEqual([
      expect.objectContaining({ id: A1, gigId: G1, amountCents: 15000 }),
    ]);
  });

  it("putPayment sends clientId, and PRESERVES it when the caller omits it", async () => {
    // The half of migration 0016 that only the wire can get wrong. The
    // server preserves an absent clientId (PaymentsRepo.upsert) purely
    // to protect the payment from builds that predate the column — this
    // build DOES send it, so the local record has to answer "absent" the
    // same way the server would, or a save from a screen that never
    // asked about a client would ship an explicit null and wipe one a
    // receipt draft had set.
    const { store } = makeStore(() => 1000);
    await store.putPayment(P1, { amountCents: 15000, clientId: C1 });
    expect((await store.getPayment(P1))?.clientId).toBe(C1);
    expect((await store.pendingOps())[0]?.payload).toMatchObject({ clientId: C1 });

    await store.putPayment(P1, { amountCents: 15000, notes: "no client asked for" });
    expect((await store.getPayment(P1))?.clientId).toBe(C1);
    expect((await store.pendingOps())[0]?.payload).toMatchObject({ clientId: C1 });

    // …and an explicit null still clears it. "Absent" and "empty" are
    // different answers, which is the whole reason for the distinction.
    await store.putPayment(P1, { amountCents: 15000, clientId: null });
    expect((await store.getPayment(P1))?.clientId).toBeNull();
    expect((await store.pendingOps())[0]?.payload).toMatchObject({ clientId: null });
  });

  it("resolves a payment's gig from its allocation once the server nulls the column", async () => {
    // What a pull looks like after this build has saved a payment: the
    // server took the write without a gigId, so the column comes back
    // null and the allocation carries the answer.
    const { store } = makeStore();
    const pulled: Payment = {
      id: P1,
      gigId: null,
      clientId: null,
      amountCents: 15000,
      paidAt: null,
      confirmationR2Key: null,
      notes: null,
      createdAt: 1,
      modifiedAt: 2,
    };
    await store.applyServerRecord("payment", pulled);
    const allocation: Allocation = {
      id: A1,
      paymentId: P1,
      gigId: G1,
      amountCents: 15000,
      createdAt: 1,
      modifiedAt: 2,
    };
    await store.applyServerRecord("allocation", allocation);

    expect((await store.getPayment(P1))?.gigId).toBe(G1);
    expect((await store.listPayments())[0]?.gigId).toBe(G1);
    expect(await store.listPaymentsByGig(G1)).toHaveLength(1);
  });

  it("resolves a SPLIT payment's gig to null rather than naming one of them", async () => {
    const { store } = makeStore();
    await store.applyServerRecord("payment", {
      id: P1,
      gigId: null,
      clientId: null,
      amountCents: 15000,
      paidAt: null,
      confirmationR2Key: null,
      notes: null,
      createdAt: 1,
      modifiedAt: 2,
    } satisfies Payment);
    await store.putAllocation(A1, { paymentId: P1, gigId: G1, amountCents: 10000 });
    await store.putAllocation(A2, { paymentId: P1, gigId: G2, amountCents: 5000 });

    expect((await store.getPayment(P1))?.gigId).toBeNull();
    // Still reachable from both gigs, which is the point of the split.
    expect(await store.listPaymentsByGig(G1)).toHaveLength(1);
    expect(await store.listPaymentsByGig(G2)).toHaveLength(1);
  });

  it("leaves a partial allocation alone when the payment is saved without a gigId", async () => {
    // The corruption this whole design is about: 50.00 allocated out of
    // 150.00, the remaining 100.00 deliberately unallocated. Saving the
    // payment (Task 7's screen passes no gigId) must not touch it. Were
    // gigId still on the wire, the server would inflate this allocation
    // to 150.00 and the remainder would vanish.
    let now = 1000;
    const { store } = makeStore(() => now);
    await store.putPayment(P1, { amountCents: 15000 });
    await store.putAllocation(A1, { paymentId: P1, gigId: G1, amountCents: 5000 });

    now = 2000;
    await store.putPayment(P1, { amountCents: 15000, notes: "bank transfer" });

    expect(await store.listAllocationsByPayment(P1)).toEqual([
      expect.objectContaining({ id: A1, amountCents: 5000 }),
    ]);
    const allocationOp = (await store.pendingOps()).find(
      (o) => o.entity === "allocation",
    );
    expect(allocationOp?.modifiedAt).toBe(1000); // untouched by the 2000 save
  });

  it("refuses to collapse a split even when a caller does pass a gigId", async () => {
    // The client-side twin of AllocationsRepo.replaceSoleAllocation's
    // guard: a `gigId` cannot have authored the split it would erase.
    const { store } = makeStore();
    await store.putPayment(P1, { amountCents: 15000 });
    await store.putAllocation(A1, { paymentId: P1, gigId: G1, amountCents: 10000 });
    await store.putAllocation(A2, { paymentId: P1, gigId: G2, amountCents: 5000 });

    await store.putPayment(P1, { gigId: G1, amountCents: 15000 });

    expect(await store.listAllocationsByPayment(P1)).toEqual([
      expect.objectContaining({ id: A1, gigId: G1, amountCents: 10000 }),
      expect.objectContaining({ id: A2, gigId: G2, amountCents: 5000 }),
    ]);
  });

  it("MIGRATION: edits the server-made allocation of an OLD client's payment in place", async () => {
    // A payment created before this release: the server holds a gigId
    // AND one allocation it minted itself (migration 0016's backfill, or
    // the compat path). Both arrive by pull. Editing the payment here
    // must reuse that allocation's id — minting a second would push the
    // payment over its own amount and the server would refuse it.
    const SERVER_ALLOC = "88888888-8888-4888-8888-888888888888";
    let now = 1000;
    const { store } = makeStore(() => now, `u-${++dbSeq}`, () => A1);
    await store.applyServerRecord("payment", {
      id: P1,
      gigId: G1,
      clientId: null,
      amountCents: 15000,
      paidAt: null,
      confirmationR2Key: null,
      notes: null,
      createdAt: 1,
      modifiedAt: 2,
    } satisfies Payment);
    await store.applyServerRecord("allocation", {
      id: SERVER_ALLOC,
      paymentId: P1,
      gigId: G1,
      amountCents: 15000,
      createdAt: 1,
      modifiedAt: 2,
    } satisfies Allocation);

    now = 3000;
    // The payment screen as it stands today: it reads back the gig it
    // resolved and sends it again, this time with a corrected amount.
    await store.putPayment(P1, { gigId: G1, amountCents: 5000 });

    expect(await store.listAllocationsByPayment(P1)).toEqual([
      expect.objectContaining({ id: SERVER_ALLOC, gigId: G1, amountCents: 5000 }),
    ]);
    const ops = await store.pendingOps();
    expect(ops.filter((o) => o.entity === "allocation")).toHaveLength(1);
    expect(ops.find((o) => o.entity === "allocation")?.entityId).toBe(SERVER_ALLOC);
    expect(ops.find((o) => o.entity === "payment")?.payload).not.toHaveProperty(
      "gigId",
    );
  });

  it("MIGRATION: leaves an outbox op queued by the OLD build exactly as it was", async () => {
    // The old build put gigId on every payment write. Such an op can
    // still be sitting in the outbox when this build starts up, and it
    // must drain through the server's compat path untouched — this
    // build neither rewrites it nor strips it.
    const { store, db } = makeStore();
    await db.pendingOps.put({
      opKey: `payment:${P1}`,
      entity: "payment",
      entityId: P1,
      op: "upsert",
      payload: { gigId: G1, amountCents: 15000, paidAt: null, notes: null },
      modifiedAt: 500,
      queuedAt: 500,
    });

    const op = (await store.pendingOps()).find((o) => o.entity === "payment");

    expect(op?.payload).toEqual({
      gigId: G1,
      amountCents: 15000,
      paidAt: null,
      notes: null,
    });
  });

  it("MIGRATION: a re-save on this build replaces the old build's queued payload", async () => {
    const { store, db } = makeStore(() => 1000, `u-${++dbSeq}`, () => A1);
    await db.pendingOps.put({
      opKey: `payment:${P1}`,
      entity: "payment",
      entityId: P1,
      op: "upsert",
      payload: { gigId: G1, amountCents: 15000, paidAt: null, notes: null },
      modifiedAt: 500,
      queuedAt: 500,
    });

    await store.putPayment(P1, { gigId: G1, amountCents: 15000 });

    const op = (await store.pendingOps()).find((o) => o.entity === "payment");
    expect(op?.payload).not.toHaveProperty("gigId");
    // Queued position is preserved, as it is for every folded op.
    expect(op?.queuedAt).toBe(500);
    // …and the link the stripped field expressed is now an allocation.
    expect(await store.listAllocationsByPayment(P1)).toHaveLength(1);
  });

  it("removePayment drops the payment's allocations without queueing ops for them", async () => {
    // Deleting a payment server-side already deletes its allocations
    // (payment_allocations.payment_id has no ON DELETE CASCADE, so both
    // doors do it explicitly). Queueing our own deletes on top could
    // only race with that.
    const { store } = makeStore();
    await store.putPayment(P1, { amountCents: 15000 });
    await store.putAllocation(A1, { paymentId: P1, gigId: G1, amountCents: 5000 });

    await store.removePayment(P1);

    expect(await store.listAllocationsByPayment(P1)).toEqual([]);
    const allocationOps = (await store.pendingOps()).filter(
      (o) => o.entity === "allocation",
    );
    expect(allocationOps.map((o) => o.op)).toEqual(["upsert"]); // the create, not a delete
  });
});

describe("GigsyUserDB v3 upgrade", () => {
  it("keeps v2 data and adds the allocations store", async () => {
    const userId = `upgrade-${++dbSeq}`;
    // A browser that last ran the previous release: v2 schema, v2 data.
    const v2 = new Dexie(`gigsy-user-${userId}`);
    v2.version(1).stores({
      gigs: "id, dateTime, modifiedAt",
      clients: "id, name, modifiedAt",
      expenses: "id, createdAt, modifiedAt",
      pendingOps: "opKey, queuedAt",
    });
    v2.version(2).stores({
      services: "id, gigId, modifiedAt",
      payments: "id, gigId, createdAt, modifiedAt",
    });
    await v2.open();
    await v2.table("payments").put({
      id: P1,
      gigId: G1,
      clientId: null,
      amountCents: 15000,
      paidAt: null,
      confirmationR2Key: null,
      notes: "recorded on the old build",
      createdAt: 1,
      modifiedAt: 2,
    });
    await v2.table("pendingOps").put({
      opKey: `payment:${P1}`,
      entity: "payment",
      entityId: P1,
      op: "upsert",
      payload: { gigId: G1, amountCents: 15000, paidAt: null, notes: null },
      modifiedAt: 500,
      queuedAt: 500,
    });
    v2.close();

    const { store } = makeStore(() => 1000, userId);

    // v3 is a pure addition: nothing is rewritten and nothing is lost —
    // including the outbox the user had not managed to drain.
    const payment = await store.getPayment(P1);
    expect(payment?.notes).toBe("recorded on the old build");
    expect(payment?.gigId).toBe(G1); // no allocation yet: the column still answers
    expect(await store.pendingCount()).toBe(1);
    // …and the new store is there and usable.
    await store.putAllocation(A1, { paymentId: P1, gigId: G1, amountCents: 15000 });
    expect(await store.listAllocationsByPayment(P1)).toHaveLength(1);
  });
});

// ── Phase 4 Task 10: the confirmation photo queue ──────────────────

const P2 = "99999999-9999-4999-8999-999999999999";
const P3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const P4 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const P5 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** A blob of known size AND known content. Content matters as much as
 *  size here: the bytes are what has to survive to the server, and a
 *  test that only checked a length would pass on the wrong image. */
function photo(bytes: number, marker = "p"): Blob {
  return new Blob([marker.repeat(bytes)], { type: "image/jpeg" });
}

describe("LocalStore photo queue", () => {
  it("holds the chosen bytes, and their content type", async () => {
    const { store } = makeStore(() => 1000);
    const result = await store.queueImage(P1, photo(12, "x"));

    expect(result.queued).toBe(true);
    const queued = await store.queuedImage(P1);
    expect(queued?.byteSize).toBe(12);
    expect(queued?.contentType).toBe("image/jpeg");
    expect(queued?.queuedAt).toBe(1000);
    expect(queued?.failedReason).toBeNull();
    expect(await queued!.blob!.text()).toBe("xxxxxxxxxxxx");
  });

  it("names a type for a blob that has none, so R2 is not left guessing", async () => {
    const { store } = makeStore();
    await store.queueImage(P1, new Blob(["bytes"]));
    expect((await store.queuedImage(P1))?.contentType).toBe("application/octet-stream");
  });

  it("keeps ONE photo per payment — a second choice replaces the first", async () => {
    // The same rule the outbox has, for the same reason: the
    // destination holds one object per payment (`confirmationKey()` in
    // backend/src/routes/payments.ts), so a queue that could hold two
    // would be promising something R2 cannot keep.
    const { store } = makeStore();
    await store.queueImage(P1, photo(4, "a"));
    await store.queueImage(P1, photo(4, "b"));

    expect(await store.queuedImageCount()).toBe(1);
    expect(await (await store.queuedImage(P1))!.blob!.text()).toBe("bbbb");
  });

  it("refuses a file too large to hold, and stores nothing", async () => {
    const { store } = makeStore();
    const result = await store.queueImage(P1, photo(MAX_IMAGE_BYTES + 1));

    expect(result).toEqual({ queued: false, refusal: "too-large" });
    // A refusal is not a partial write: nothing changed, so the screen
    // has nothing to un-say.
    expect(await store.queuedImage(P1)).toBeNull();
  });

  it("refuses a photo when the queue is full — and does NOT evict to make room", async () => {
    // The rule the whole bound turns on. Eviction is the usual answer
    // for a bounded store and the wrong one here: the oldest entry is
    // the proof the user has been carrying longest, and dropping it to
    // admit a newer one destroys data silently in order to avoid
    // saying no.
    const { store } = makeStore();
    const full = [P1, P2, P3, P4];
    for (const id of full) {
      expect((await store.queueImage(id, photo(MAX_IMAGE_BYTES))).queued).toBe(true);
    }
    expect(await store.queuedImageCount()).toBe(MAX_QUEUE_BYTES / MAX_IMAGE_BYTES);

    const result = await store.queueImage(P5, photo(1));

    expect(result).toEqual({ queued: false, refusal: "queue-full" });
    // Every one of them is still there, and the newcomer is not.
    expect(await store.queuedImageCount()).toBe(full.length);
    for (const id of full) expect(await store.queuedImage(id)).not.toBeNull();
    expect(await store.queuedImage(P5)).toBeNull();
  });

  it("lets a payment swap its own photo even when the queue is full", async () => {
    // The bytes about to be replaced must not be charged twice, or a
    // full queue would refuse the one write that cannot make it worse.
    const { store } = makeStore();
    for (const id of [P1, P2, P3, P4]) {
      await store.queueImage(id, photo(MAX_IMAGE_BYTES));
    }

    expect((await store.queueImage(P1, photo(MAX_IMAGE_BYTES, "z"))).queued).toBe(true);
    expect((await store.queuedImage(P1))?.byteSize).toBe(MAX_IMAGE_BYTES);
    expect(await (await store.queuedImage(P1))!.blob!.text()).toBe(
      "z".repeat(MAX_IMAGE_BYTES),
    );
  });

  it("offers the drain the oldest photo first", async () => {
    let now = 1000;
    const { store } = makeStore(() => now);
    await store.queueImage(P2, photo(2, "b"));
    now = 500;
    await store.queueImage(P1, photo(2, "a"));

    expect((await store.queuedImagesToUpload()).map((i) => i.paymentId)).toEqual([
      P1,
      P2,
    ]);
  });

  it("keeps the row but drops the bytes when an upload is refused for good", async () => {
    const { store } = makeStore();
    await store.queueImage(P1, photo(64));

    await store.failQueuedImage(P1, "the file was too large for the server");

    const dead = await store.queuedImage(P1);
    // The row survives so the payment screen can say what happened — a
    // photo that simply vanished is the failure this task is about.
    expect(dead?.failedReason).toBe("the file was too large for the server");
    // …but not the megabytes, which will never be accepted.
    expect(dead?.blob).toBeNull();
    expect(dead?.attempts).toBe(1);
    // And it is never offered to the drain again — no forever-retry.
    expect(await store.queuedImagesToUpload()).toEqual([]);
  });

  it("counts waiting photos as pending, and tombstones as nothing", async () => {
    // pendingCount is what SyncBadge renders. A payment saved with a
    // photo that had reached neither the server nor this number would
    // show as fully synced while its proof sat on the device.
    const { store } = makeStore();
    await store.putPayment(P1, { amountCents: 15000 });
    expect(await store.pendingCount()).toBe(1); // the payment's op

    await store.queueImage(P1, photo(32));
    expect(await store.pendingCount()).toBe(2);

    await store.failQueuedImage(P1, "gone");
    // Nothing is waiting on the photo now — it is never going.
    expect(await store.pendingCount()).toBe(1);
  });

  it("drops a queued photo when its payment is deleted", async () => {
    // The upload endpoint 404s on a payment the server does not have,
    // which this queue calls permanent — so keeping it would leave a
    // tombstone complaining about a record nobody can open.
    const { store } = makeStore();
    await store.putPayment(P1, { amountCents: 15000 });
    await store.queueImage(P1, photo(32));

    await store.removePayment(P1);

    expect(await store.queuedImage(P1)).toBeNull();
    expect(await store.queuedImageCount()).toBe(0);
  });

  it("records the uploaded key locally without queueing an op for it", async () => {
    // The key is server-owned — `confirmationKey()` derives it and the
    // PUT route has already written it to D1 — so this adopts a fact
    // rather than asserting one. Sending it back would be the
    // expectedCents mistake in another costume.
    const { store } = makeStore();
    await store.putPayment(P1, { amountCents: 15000 });
    const opsBefore = (await store.pendingOps()).length;

    await store.setConfirmationKey(P1, "u/dev/payments/p/confirmation");

    expect((await store.getPayment(P1))?.confirmationR2Key).toBe(
      "u/dev/payments/p/confirmation",
    );
    expect((await store.pendingOps()).length).toBe(opsBefore);
  });
});

describe("LocalStore.listAllocations", () => {
  it("returns every allocation across every payment in one read", async () => {
    const { store } = makeStore();
    await store.putPayment(P1, { amountCents: 15000 });
    await store.putAllocation(A1, { paymentId: P1, gigId: G1, amountCents: 10000 });
    await store.putAllocation(A2, { paymentId: P1, gigId: G2, amountCents: 5000 });

    const all = await store.listAllocations();

    expect(all.map((a) => a.id).sort()).toEqual([A1, A2].sort());
  });

  it("returns an empty list rather than throwing when nothing is allocated", async () => {
    const { store } = makeStore();
    expect(await store.listAllocations()).toEqual([]);
  });
});

describe("GigsyUserDB v4 upgrade", () => {
  it("keeps v3 data and adds the photo queue", async () => {
    const userId = `upgrade4-${++dbSeq}`;
    // A browser that last ran the allocations release: v3 schema, v3
    // data, and an outbox it never got to drain.
    const v3 = new Dexie(`gigsy-user-${userId}`);
    v3.version(1).stores({
      gigs: "id, dateTime, modifiedAt",
      clients: "id, name, modifiedAt",
      expenses: "id, createdAt, modifiedAt",
      pendingOps: "opKey, queuedAt",
    });
    v3.version(2).stores({
      services: "id, gigId, modifiedAt",
      payments: "id, gigId, createdAt, modifiedAt",
    });
    v3.version(3).stores({
      allocations: "id, paymentId, gigId, modifiedAt",
    });
    await v3.open();
    await v3.table("payments").put({
      id: P1,
      gigId: null,
      clientId: null,
      amountCents: 15000,
      paidAt: null,
      confirmationR2Key: null,
      notes: "recorded before the photo queue existed",
      createdAt: 1,
      modifiedAt: 2,
    });
    await v3.table("allocations").put({
      id: A1,
      paymentId: P1,
      gigId: G1,
      amountCents: 15000,
      createdAt: 1,
      modifiedAt: 2,
    });
    await v3.table("pendingOps").put({
      opKey: `payment:${P1}`,
      entity: "payment",
      entityId: P1,
      op: "upsert",
      payload: { amountCents: 15000, clientId: null, paidAt: null, notes: null },
      modifiedAt: 500,
      queuedAt: 500,
    });
    v3.close();

    const { store } = makeStore(() => 1000, userId);

    // v4 is a pure addition, on exactly the terms v3 was: nothing is
    // rewritten and nothing is lost — including the undrained outbox.
    expect((await store.getPayment(P1))?.notes).toBe(
      "recorded before the photo queue existed",
    );
    expect(await store.listAllocationsByPayment(P1)).toHaveLength(1);
    expect((await store.pendingOps()).length).toBe(1);

    // …and the new store is there and usable.
    expect((await store.queueImage(P1, photo(8, "q"))).queued).toBe(true);
    expect(await (await store.queuedImage(P1))!.blob!.text()).toBe("qqqqqqqq");
    // The op the old build left behind and the photo this one queued
    // are both counted as waiting.
    expect(await store.pendingCount()).toBe(2);
  });
});
