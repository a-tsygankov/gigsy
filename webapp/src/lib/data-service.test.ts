import "fake-indexeddb/auto";
import { describe, it, expect, vi } from "vitest";
import { openUserDb } from "./db.ts";
import { LocalStore } from "./local-store.ts";
import { OfflineDataService } from "./data-service.ts";
import type { ReportSummary } from "./types.ts";

let seq = 0;
const G1 = "11111111-1111-4111-8111-111111111111";

function makeService() {
  const store = new LocalStore(openUserDb(`ds-${++seq}`), () => 1000);
  const engine = { notifyLocalChange: vi.fn(async () => undefined) };
  const reports = {
    getReportSummary: vi.fn(async () => ({ totals: {} }) as ReportSummary),
  };
  const data = new OfflineDataService(
    store,
    engine as never,
    reports as never,
  );
  return { data, store, engine, reports };
}

describe("OfflineDataService", () => {
  it("writes locally and nudges the sync engine", async () => {
    const { data, store, engine } = makeService();

    const gig = await data.putGig(G1, { status: "lead" });

    expect(gig.id).toBe(G1);
    expect(await store.getGig(G1)).not.toBeNull();
    expect(engine.notifyLocalChange).toHaveBeenCalled();
  });

  it("reads come from the local store, not the network", async () => {
    const { data } = makeService();
    await data.putGig(G1, { status: "confirmed" });

    const list = await data.listGigs();
    expect(list.map((g) => g.id)).toEqual([G1]);
    expect((await data.getGig(G1)).status).toBe("confirmed");
  });

  it("getGig throws for a missing id (screens expect an error state)", async () => {
    const { data } = makeService();
    await expect(data.getGig(G1)).rejects.toThrow("not found");
  });

  it("delete removes locally and nudges the engine", async () => {
    const { data, store, engine } = makeService();
    await data.putGig(G1, { status: "lead" });

    await data.deleteGig(G1);

    expect(await store.getGig(G1)).toBeNull();
    expect(engine.notifyLocalChange).toHaveBeenCalledTimes(2);
  });

  it("reports delegate to the server (never computed locally)", async () => {
    const { data, reports } = makeService();
    await data.getReportSummary();
    expect(reports.getReportSummary).toHaveBeenCalled();
  });

  it("rejects zero/negative money before it can reach the outbox", async () => {
    // A locally-stored bad amount would sync-error later and be
    // poison-dropped — block it at the write, offline included.
    const { data, store, engine } = makeService();
    const SVC = "22222222-2222-4222-8222-222222222222";
    const PAY = "33333333-3333-4333-8333-333333333333";
    const EXP = "44444444-4444-4444-8444-444444444444";

    await expect(data.putGig(G1, { amountOfferedCents: 0 })).rejects.toThrow(
      /positive/,
    );
    await expect(
      data.putService(SVC, { gigId: G1, description: "x", amountPaidCents: -1 }),
    ).rejects.toThrow(/positive/);
    await expect(data.putPayment(PAY, { amountCents: 0 })).rejects.toThrow(
      /positive/,
    );
    await expect(data.putExpense(EXP, { amountCents: -500 })).rejects.toThrow(
      /positive/,
    );

    expect(await store.pendingCount()).toBe(0);
    expect(engine.notifyLocalChange).not.toHaveBeenCalled();
  });

  it("still accepts positive amounts and null (not set)", async () => {
    const { data } = makeService();
    await expect(
      data.putGig(G1, { amountOfferedCents: 15000, amountPaidCents: null }),
    ).resolves.toMatchObject({ amountOfferedCents: 15000 });
  });

  it("rejects a zero or negative hourly rate before it can reach the outbox", async () => {
    // Same poison-drop risk as the amount fields above: a bad
    // hourlyRateCents synced to the backend's positiveCents schema
    // errors there, and sync-engine.ts drops the whole op — silently
    // destroying the rest of the edit along with it.
    const { data, store, engine } = makeService();

    await expect(
      data.putGig(G1, { payType: "hourly", hourlyRateCents: 0 }),
    ).rejects.toThrow(/positive/);
    await expect(
      data.putGig(G1, { payType: "hourly", hourlyRateCents: -5000 }),
    ).rejects.toThrow(/positive/);

    expect(await store.pendingCount()).toBe(0);
    expect(engine.notifyLocalChange).not.toHaveBeenCalled();
  });
});
