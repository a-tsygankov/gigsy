import { describe, expect, it, vi } from "vitest";
import { createGigBatch } from "./gig-batch.ts";
import type { Gig, GigInput } from "./types.ts";

/** A `putGig` that echoes what it was given as a stored record, so the
 *  assertions can read the input back off the return value as well as
 *  off the mock's calls. */
function makeData() {
  const putGig = vi.fn(
    async (id: string, input: GigInput): Promise<Gig> => ({
      id,
      clientId: input.clientId ?? null,
      parentGigId: input.parentGigId ?? null,
      batchId: input.batchId ?? null,
      title: input.title ?? null,
      status: input.status ?? "lead",
      location: input.location ?? null,
      dateTime: input.dateTime ?? null,
      durationMinutes: input.durationMinutes ?? null,
      payType: input.payType ?? "fixed",
      hourlyRateCents: input.hourlyRateCents ?? null,
      workStartedAt: null,
      workEndedAt: null,
      breakMinutes: null,
      calendarEventId: null,
      amountOfferedCents: input.amountOfferedCents ?? null,
      amountPaidCents: null,
      expectedCents: null,
      notes: input.notes ?? null,
      source: input.source ?? "manual",
      createdAt: 0,
      modifiedAt: 0,
    }),
  );
  return { putGig };
}

/** Predictable ids, in order: the first is the batch id when there is a
 *  batch, and the rest are gig ids. */
function idsFrom(...ids: string[]): () => string {
  const queue = [...ids];
  return () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("ran out of ids");
    return next;
  };
}

const BASE: GigInput = {
  clientId: "c1",
  title: "Tasting",
  status: "lead",
  location: "Costco on 5th",
  durationMinutes: 240,
  payType: "fixed",
  amountOfferedCents: 15000,
  notes: "Booth 12",
  source: "manual",
  // Deliberately set on the base, to prove they are overwritten rather
  // than copied — the dates are the list, and the batch id is the
  // helper's to mint.
  dateTime: 1,
  batchId: "stale",
};

describe("createGigBatch", () => {
  it("creates one gig per date, sharing one fresh batch id", async () => {
    const data = makeData();
    const created = await createGigBatch(
      data,
      BASE,
      [1000, 2000, 3000],
      idsFrom("batch", "g1", "g2", "g3"),
    );

    expect(data.putGig).toHaveBeenCalledTimes(3);
    expect(created.map((g) => g.id)).toEqual(["g1", "g2", "g3"]);
    // In the order given, never sorted.
    expect(created.map((g) => g.dateTime)).toEqual([1000, 2000, 3000]);
    // One id, minted once, on all of them.
    expect(created.map((g) => g.batchId)).toEqual(["batch", "batch", "batch"]);
  });

  it("copies every other field onto every sibling", async () => {
    const data = makeData();
    await createGigBatch(data, BASE, [1000, 2000], idsFrom("batch", "g1", "g2"));

    for (const [, input] of data.putGig.mock.calls) {
      // Everything but the two fields the helper owns.
      const { dateTime: _d, batchId: _b, ...rest } = input;
      const { dateTime: _bd, batchId: _bb, ...expected } = BASE;
      expect(rest).toEqual(expected);
    }
  });

  it("leaves batchId null for a batch of one", async () => {
    // A batch of one is not a batch (the design's decision table): the
    // column means "created with these others", and there are none.
    const data = makeData();
    const created = await createGigBatch(data, BASE, [1000], idsFrom("g1"));

    expect(data.putGig).toHaveBeenCalledTimes(1);
    expect(created[0]?.batchId).toBeNull();
    expect(created[0]?.dateTime).toBe(1000);
    // And no id was spent on a batch that does not exist.
    expect(created[0]?.id).toBe("g1");
  });

  it("makes an undated gig from a null date, exactly like the plain form", async () => {
    const data = makeData();
    const created = await createGigBatch(data, BASE, [null], idsFrom("g1"));
    expect(created[0]?.dateTime).toBeNull();
    expect(created[0]?.batchId).toBeNull();
  });

  it("returns the records putGig produced, not the inputs", async () => {
    const data = makeData();
    const created = await createGigBatch(data, BASE, [1000, 2000], idsFrom("b", "g1", "g2"));
    expect(created).toEqual(await Promise.all(data.putGig.mock.results.map((r) => r.value)));
  });
});
