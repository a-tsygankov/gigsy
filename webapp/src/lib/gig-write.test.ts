import { describe, expect, it, vi } from "vitest";
import { commitGigPatch, type GigWriter } from "./gig-write.ts";
import type { Gig, GigInput } from "./types.ts";

/** What a pull has just written into the local store. */
const STORED: Gig = {
  id: "g1",
  clientId: "c1",
  title: "Costco tasting",
  status: "confirmed",
  location: "Costco on 5th",
  // The plan, as another device moved it.
  dateTime: 1_800_000_000_000,
  durationMinutes: 240,
  payType: "hourly",
  hourlyRateCents: 5000,
  workStartedAt: 1_800_003_600_000,
  workEndedAt: null,
  breakMinutes: null,
  calendarEventId: "evt-1",
  amountOfferedCents: null,
  amountPaidCents: null,
  expectedCents: 20000,
  notes: "Booth 12",
  source: "email",
  createdAt: 1,
  modifiedAt: 2,
};

/**
 * What a screen's React Query cache is still holding: the same gig as it
 * was BEFORE the pull, inside the 30s staleTime. Nothing in this file
 * ever passes it to `commitGigPatch` — the point is that there is no
 * parameter it could be passed through, and these fields must therefore
 * never appear in a write.
 */
const STALE_CACHE_COPY: Gig = {
  ...STORED,
  dateTime: 1_700_000_000_000,
  durationMinutes: 60,
  status: "lead",
};

function fakeWriter(stored: Gig = STORED): {
  writer: GigWriter;
  putGig: ReturnType<typeof vi.fn>;
} {
  const putGig = vi.fn(async (_id: string, input: GigInput) => ({
    ...stored,
    ...input,
  }));
  const writer: GigWriter = {
    getGig: async () => stored,
    putGig: putGig as unknown as GigWriter["putGig"],
  };
  return { writer, putGig };
}

const payloadOf = (putGig: ReturnType<typeof vi.fn>): GigInput =>
  putGig.mock.calls[0]![1] as GigInput;

describe("commitGigPatch", () => {
  it("merges onto what the STORE holds, so a work write cannot revert the plan", async () => {
    // The regression this exists for: the work card commits a stamp
    // while the cache still holds the pre-pull copy. If the base came
    // from anywhere but the store, `dateTime` and `durationMinutes`
    // would go back to the stale figures and be queued for the server.
    const { writer, putGig } = fakeWriter();
    await commitGigPatch(writer, "g1", { workEndedAt: 1_800_010_000_000 });

    const payload = payloadOf(putGig);
    expect(payload.dateTime).toBe(STORED.dateTime);
    expect(payload.durationMinutes).toBe(STORED.durationMinutes);
    expect(payload.dateTime).not.toBe(STALE_CACHE_COPY.dateTime);
    expect(payload.durationMinutes).not.toBe(STALE_CACHE_COPY.durationMinutes);
    expect(payload.workEndedAt).toBe(1_800_010_000_000);
  });

  it("carries the work log through a job-form write it does not render", async () => {
    // The same hole from the other side: the job form shows none of
    // these three fields, so a stale base reverts a recorded shift with
    // nothing on screen to show for it.
    const { writer, putGig } = fakeWriter();
    await commitGigPatch(writer, "g1", { location: "Costco on 7th" });

    const payload = payloadOf(putGig);
    expect(payload.workStartedAt).toBe(STORED.workStartedAt);
    expect(payload.workEndedAt).toBeNull();
    expect(payload.breakMinutes).toBeNull();
    expect(payload.location).toBe("Costco on 7th");
  });

  it("sends every writable field, not only the patch", async () => {
    const { writer, putGig } = fakeWriter();
    await commitGigPatch(writer, "g1", { status: "completed" });

    expect(payloadOf(putGig)).toEqual({
      clientId: "c1",
      title: "Costco tasting",
      status: "completed",
      location: "Costco on 5th",
      dateTime: 1_800_000_000_000,
      durationMinutes: 240,
      payType: "hourly",
      hourlyRateCents: 5000,
      workStartedAt: 1_800_003_600_000,
      workEndedAt: null,
      breakMinutes: null,
      amountOfferedCents: null,
      amountPaidCents: null,
      notes: "Booth 12",
    });
  });

  it("writes under the id it was given", async () => {
    const { writer, putGig } = fakeWriter();
    await commitGigPatch(writer, "g1", { status: "cancelled" });
    expect(putGig.mock.calls[0]![0]).toBe("g1");
  });

  it("builds a patch from the stored record when given a function", async () => {
    // GigEdit's "was this gig already hourly?" — a question the cache
    // can answer wrongly, so it is answered from the record being
    // merged onto.
    const { writer, putGig } = fakeWriter();
    await commitGigPatch(writer, "g1", (current) => ({
      amountOfferedCents: current.payType === "hourly" ? current.amountOfferedCents : 15000,
    }));
    expect(payloadOf(putGig).amountOfferedCents).toBeNull();

    const fixed = fakeWriter({ ...STORED, payType: "fixed" });
    await commitGigPatch(fixed.writer, "g1", (current) => ({
      amountOfferedCents: current.payType === "hourly" ? current.amountOfferedCents : 15000,
    }));
    expect(payloadOf(fixed.putGig).amountOfferedCents).toBe(15000);
  });

  it("rejects rather than writing when the gig is gone", async () => {
    // The delete race: the work card's unmount flush fires after the
    // record has been removed. `getGig` throwing is what stops the
    // flush resurrecting it.
    const putGig = vi.fn();
    const writer: GigWriter = {
      getGig: async () => {
        throw new Error("not found");
      },
      putGig: putGig as unknown as GigWriter["putGig"],
    };
    await expect(commitGigPatch(writer, "gone", { status: "completed" })).rejects.toThrow(
      "not found",
    );
    expect(putGig).not.toHaveBeenCalled();
  });
});
