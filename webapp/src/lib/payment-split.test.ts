import { describe, expect, it } from "vitest";
import { formatMoney } from "./format.ts";
import {
  SPLIT_MESSAGE,
  allocatedCents,
  applyAutoBalance,
  clearMismatchedRows,
  gigsForClient,
  isBlankRow,
  rowsFromAllocations,
  splitWrites,
  sumSplitRows,
  unallocatedCents,
  unallocatedLabel,
  validateSplit,
  type SplitRow,
} from "./payment-split.ts";
import type { Allocation, Gig } from "./types.ts";

const CLIENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLIENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function gig(id: string, clientId: string | null): Gig {
  return {
    id,
    clientId,
    parentGigId: null,
    title: id,
    status: "confirmed",
    location: null,
    dateTime: null,
    durationMinutes: null,
    payType: "fixed",
    hourlyRateCents: null,
    workStartedAt: null,
    workEndedAt: null,
    breakMinutes: null,
    calendarEventId: null,
    amountOfferedCents: null,
    amountPaidCents: null,
    expectedCents: null,
    notes: null,
    source: "manual",
    createdAt: 1,
    modifiedAt: 1,
  };
}

function row(id: string, gigId: string, amount: string): SplitRow {
  return { id, gigId, amount };
}

function allocation(id: string, gigId: string, amountCents: number): Allocation {
  return { id, paymentId: "p1", gigId, amountCents, createdAt: 1, modifiedAt: 1 };
}

const GIG_A1 = gig("a1", CLIENT_A);
const GIG_A2 = gig("a2", CLIENT_A);
const GIG_B1 = gig("b1", CLIENT_B);
const GIG_NONE = gig("n1", null);
const ALL_GIGS = [GIG_A1, GIG_A2, GIG_B1, GIG_NONE];

describe("gigsForClient", () => {
  it("offers everything while no client is named", () => {
    // The escape hatch: a transfer you cannot yet attribute is still
    // worth recording against whatever gig it turns out to cover.
    expect(gigsForClient(ALL_GIGS, "")).toEqual(ALL_GIGS);
  });

  it("narrows to the named client's gigs", () => {
    expect(gigsForClient(ALL_GIGS, CLIENT_A).map((g) => g.id)).toEqual(["a1", "a2"]);
  });

  it("excludes clientless gigs from a named client's list", () => {
    // A gig with no client is not "everyone's gig" — the server would
    // refuse the allocation (`gig.clientId !== payment.clientId`), so
    // offering it here would be offering a save that cannot happen.
    expect(gigsForClient(ALL_GIGS, CLIENT_B).map((g) => g.id)).toEqual(["b1"]);
  });

  it("offers nothing when the client has no gigs, rather than falling back to all", () => {
    const orphan = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    expect(gigsForClient(ALL_GIGS, orphan)).toEqual([]);
  });
});

describe("clearMismatchedRows", () => {
  it("clears a gig that the newly-chosen client does not own, keeping the amount", () => {
    const rows = [row("r1", "b1", "50.00"), row("r2", "a1", "25.00")];
    expect(clearMismatchedRows(rows, ALL_GIGS, CLIENT_A)).toEqual([
      row("r1", "", "50.00"),
      row("r2", "a1", "25.00"),
    ]);
  });

  it("touches nothing when the client is cleared", () => {
    const rows = [row("r1", "b1", "50.00")];
    expect(clearMismatchedRows(rows, ALL_GIGS, "")).toEqual(rows);
  });
});

describe("split arithmetic", () => {
  it("sums what parses and ignores what does not, so the total survives typing", () => {
    expect(sumSplitRows([row("r1", "a1", "100"), row("r2", "a2", "")])).toBe(10000);
    expect(sumSplitRows([row("r1", "a1", "100"), row("r2", "a2", "1.")])).toBe(10000);
    expect(sumSplitRows([row("r1", "a1", "$1,200.50")])).toBe(120050);
  });

  it("leaves a POSITIVE remainder, which is a legitimate state", () => {
    const rows = [row("r1", "a1", "50")];
    expect(unallocatedCents(15000, rows)).toBe(10000);
    expect(unallocatedLabel(unallocatedCents(15000, rows), formatMoney)).toBe(
      "Unallocated $100.00",
    );
  });

  it("says Fully allocated at exactly zero", () => {
    const rows = [row("r1", "a1", "100"), row("r2", "a2", "50")];
    expect(unallocatedCents(15000, rows)).toBe(0);
    expect(unallocatedLabel(0, formatMoney)).toBe("Fully allocated");
  });

  it("goes negative when the splits exceed the payment", () => {
    const rows = [row("r1", "a1", "100"), row("r2", "a2", "100")];
    expect(unallocatedCents(15000, rows)).toBe(-5000);
  });

  it("adds cents as integers, never as floats", () => {
    // 0.1 + 0.2 in dollars is the classic wrong answer; in cents it is
    // 10 + 20 and there is nothing to get wrong.
    expect(sumSplitRows([row("r1", "a1", "0.10"), row("r2", "a2", "0.20")])).toBe(30);
    expect(unallocatedCents(30, [row("r1", "a1", "0.10"), row("r2", "a2", "0.20")])).toBe(0);
  });

  it("allocatedCents sums parsed rows", () => {
    expect(allocatedCents([{ id: "r1", gigId: "a1", amountCents: 10000 }])).toBe(10000);
    expect(allocatedCents([])).toBe(0);
  });

  it("treats a row with neither gig nor amount as blank", () => {
    expect(isBlankRow(row("r1", "", ""))).toBe(true);
    expect(isBlankRow(row("r1", "", "  "))).toBe(true);
    expect(isBlankRow(row("r1", "a1", ""))).toBe(false);
    expect(isBlankRow(row("r1", "", "50"))).toBe(false);
  });
});

describe("validateSplit", () => {
  const base = { clientId: "", gigs: ALL_GIGS };

  it("accepts a partial allocation — the remainder is not an error", () => {
    const result = validateSplit({ ...base, amountCents: 15000, rows: [row("r1", "a1", "50")] });
    expect(result.error).toBeNull();
    expect(result.rows).toEqual([{ id: "r1", gigId: "a1", amountCents: 5000 }]);
  });

  it("accepts a payment with nothing allocated at all", () => {
    const result = validateSplit({ ...base, amountCents: 15000, rows: [row("r1", "", "")] });
    expect(result.error).toBeNull();
    expect(result.rows).toEqual([]);
  });

  it("refuses over-allocation in the server's own words", () => {
    const rows = [row("r1", "a1", "100"), row("r2", "a2", "100")];
    expect(validateSplit({ ...base, amountCents: 15000, rows }).error).toBe(
      "allocations exceed the payment",
    );
    expect(SPLIT_MESSAGE.overAllocated).toBe("allocations exceed the payment");
  });

  it("allows the split to reach the payment exactly", () => {
    const rows = [row("r1", "a1", "100"), row("r2", "a2", "50")];
    const result = validateSplit({ ...base, amountCents: 15000, rows });
    expect(result.error).toBeNull();
    expect(result.rows).toHaveLength(2);
  });

  it("refuses an amount with no gig to put it against", () => {
    expect(
      validateSplit({ ...base, amountCents: 15000, rows: [row("r1", "", "50")] }).error,
    ).toBe(SPLIT_MESSAGE.missingGig);
  });

  it("refuses a gig with no readable amount", () => {
    for (const amount of ["", "abc", "0", "-5"]) {
      expect(
        validateSplit({ ...base, amountCents: 15000, rows: [row("r1", "a1", amount)] })
          .error,
        `amount ${JSON.stringify(amount)}`,
      ).toBe(SPLIT_MESSAGE.badAmount);
    }
  });

  it("refuses a gig belonging to a different client than the payment names", () => {
    // The rule `checkAllocationWrite` enforces, with its message. The
    // dropdown normally makes this unreachable — but a gig's client can
    // change on another device between the pull and this save.
    const result = validateSplit({
      amountCents: 15000,
      clientId: CLIENT_A,
      gigs: ALL_GIGS,
      rows: [row("r1", "b1", "50")],
    });
    expect(result.error).toBe("gigId does not reference the payment's client");
  });

  it("allows any client's gig while the payment names none", () => {
    const rows = [row("r1", "a1", "50"), row("r2", "b1", "50")];
    expect(validateSplit({ ...base, amountCents: 15000, rows }).error).toBeNull();
  });

  it("refuses a gig that is not in the list at all when a client is named", () => {
    const result = validateSplit({
      amountCents: 15000,
      clientId: CLIENT_A,
      gigs: ALL_GIGS,
      rows: [row("r1", "gone", "50")],
    });
    expect(result.error).toBe(SPLIT_MESSAGE.wrongClient);
  });

  it("reports the faulty row before the total, so the fix is the one in front of you", () => {
    // Both wrong at once: a row with no gig, and a sum over the
    // payment. The row wins — a total means nothing while a row is
    // still unreadable.
    const rows = [row("r1", "", "500"), row("r2", "a1", "500")];
    expect(validateSplit({ ...base, amountCents: 15000, rows }).error).toBe(
      SPLIT_MESSAGE.missingGig,
    );
  });
});

describe("applyAutoBalance", () => {
  it("mirrors the payment amount into a single untouched row that has a gig", () => {
    expect(applyAutoBalance([row("r1", "a1", "")], "150", true)).toEqual([
      row("r1", "a1", "150"),
    ]);
  });

  it("leaves a gig-less row empty, so an unattributed transfer still saves", () => {
    // /payments/new with no gig: mirroring here would turn "record it
    // now, attribute it later" into a validation error about a gig the
    // user never named.
    expect(applyAutoBalance([row("r1", "", "")], "150", true)).toEqual([
      row("r1", "", ""),
    ]);
  });

  it("stops mirroring once the split has been touched", () => {
    expect(applyAutoBalance([row("r1", "a1", "100")], "150", false)).toEqual([
      row("r1", "a1", "100"),
    ]);
  });

  it("never mirrors into a real split", () => {
    const rows = [row("r1", "a1", "100"), row("r2", "a2", "50")];
    expect(applyAutoBalance(rows, "150", true)).toEqual(rows);
  });

  it("handles an empty row list without inventing one", () => {
    expect(applyAutoBalance([], "150", true)).toEqual([]);
  });
});

describe("splitWrites", () => {
  it("writes a brand-new row", () => {
    const writes = splitWrites([], [{ id: "r1", gigId: "a1", amountCents: 5000 }]);
    expect(writes.upserts).toHaveLength(1);
    expect(writes.deletes).toEqual([]);
  });

  it("leaves an unchanged row alone — no op, no server recompute", () => {
    const existing = [allocation("r1", "a1", 5000)];
    const writes = splitWrites(existing, [{ id: "r1", gigId: "a1", amountCents: 5000 }]);
    expect(writes.upserts).toEqual([]);
    expect(writes.deletes).toEqual([]);
  });

  it("writes a row whose amount changed", () => {
    const existing = [allocation("r1", "a1", 5000)];
    const writes = splitWrites(existing, [{ id: "r1", gigId: "a1", amountCents: 2000 }]);
    expect(writes.upserts).toEqual([{ id: "r1", gigId: "a1", amountCents: 2000 }]);
  });

  it("writes a row whose gig changed", () => {
    const existing = [allocation("r1", "a1", 5000)];
    const writes = splitWrites(existing, [{ id: "r1", gigId: "a2", amountCents: 5000 }]);
    expect(writes.upserts).toEqual([{ id: "r1", gigId: "a2", amountCents: 5000 }]);
  });

  it("deletes an allocation whose row was removed", () => {
    const existing = [allocation("r1", "a1", 5000), allocation("r2", "a2", 2000)];
    const writes = splitWrites(existing, [{ id: "r1", gigId: "a1", amountCents: 5000 }]);
    expect(writes.deletes).toEqual(["r2"]);
    expect(writes.upserts).toEqual([]);
  });

  it("deletes every allocation when the split is emptied", () => {
    const existing = [allocation("r1", "a1", 5000), allocation("r2", "a2", 2000)];
    expect(splitWrites(existing, []).deletes).toEqual(["r1", "r2"]);
  });
});

describe("rowsFromAllocations", () => {
  it("renders stored cents as an editable dollar string, keeping the allocation id", () => {
    // The id matters more than it looks: it is the outbox key, so a row
    // that came back from storage and was edited folds into ONE op
    // instead of arriving as a second allocation for the same money.
    expect(rowsFromAllocations([allocation("r1", "a1", 12345)])).toEqual([
      row("r1", "a1", "123.45"),
    ]);
  });
});
