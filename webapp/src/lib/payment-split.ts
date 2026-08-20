/**
 * Splitting one payment across several gigs — the arithmetic and the
 * rules, with no React in sight.
 *
 * `screens/PaymentEdit.tsx` renders a list of split rows; everything it
 * decides (what is still unallocated, which gigs a row may offer, what
 * the server will refuse, which allocation records to write and which
 * to delete) is decided here, where it can be tested without a DOM.
 *
 * THE MESSAGES ARE THE SERVER'S, VERBATIM. Over-allocation and the
 * client rule are enforced for real in
 * `backend/src/services/payment-invariants.ts`, at both doors a write
 * can arrive through, and the offline path means a rejection comes back
 * long after the screen that caused it has gone. Refusing the save here
 * — with the server's own wording — means the user reads the same
 * sentence whichever layer stops it, instead of a local invention that
 * has to be kept in step with a sentence they may also see. The two
 * messages below are quoted from that file and belong to it.
 *
 * The remaining two messages have no server counterpart because the
 * states they describe cannot be expressed on the wire at all: an
 * allocation with no gig, and an amount that is not a number. Those are
 * the screen's own, and read like it.
 */
import { centsToInput, parseMoney } from "./money.ts";
import type { Allocation, Gig } from "./types.ts";

/** One row of the split editor, as the form holds it: an allocation id
 *  (the row IS an allocation record — a half-finished split survives a
 *  reload because each row was saved as one), the gig it pays for, and
 *  the amount exactly as typed. */
export interface SplitRow {
  id: string;
  gigId: string;
  amount: string;
}

/** A row whose amount parsed. */
export interface ParsedSplit {
  id: string;
  gigId: string;
  amountCents: number;
}

export const SPLIT_MESSAGE = {
  /** backend/src/services/payment-invariants.ts, `checkAllocationWrite`. */
  overAllocated: "allocations exceed the payment",
  /** backend/src/services/payment-invariants.ts, the client rule. */
  wrongClient: "gigId does not reference the payment's client",
  /** Screen-only: no gig means no allocation to send. */
  missingGig: "Choose a gig for every split, or remove the row.",
  /** Screen-only: `AllocationInput.amountCents` is positiveCents. */
  badAmount: "Give every gig an amount greater than zero.",
} as const;

/**
 * The gigs a split row may offer.
 *
 * An unset client offers everything — the escape hatch for a transfer
 * you cannot yet attribute, and the reason this is a filter rather than
 * a required field. Once a client IS named, the list narrows to that
 * client's gigs, which is both a shorter list to read and the same rule
 * the server will apply to whatever is chosen from it.
 */
export function gigsForClient(gigs: Gig[], clientId: string): Gig[] {
  if (clientId === "") return gigs;
  return gigs.filter((gig) => gig.clientId === clientId);
}

/**
 * Rows left pointing at a gig that the newly-chosen client does not
 * own, cleared.
 *
 * Called when the client select changes, not from an effect: leaving a
 * row on a gig that is no longer in its own dropdown renders a select
 * with no matching option (which shows blank and reads as a bug), and
 * saving it would be refused by the server anyway. The amount is kept —
 * the money is still the user's to re-point, and re-typing it is a
 * worse answer than re-choosing the gig.
 */
export function clearMismatchedRows(
  rows: SplitRow[],
  gigs: Gig[],
  clientId: string,
): SplitRow[] {
  if (clientId === "") return rows;
  const allowed = new Set(gigsForClient(gigs, clientId).map((gig) => gig.id));
  return rows.map((row) =>
    row.gigId !== "" && !allowed.has(row.gigId) ? { ...row, gigId: "" } : row,
  );
}

export function allocatedCents(rows: ParsedSplit[]): number {
  return rows.reduce((sum, row) => sum + row.amountCents, 0);
}

/**
 * What the rows add up to WHILE they are being typed.
 *
 * Deliberately lenient where `validateSplit` is strict: a row halfway
 * through "10" is not yet a number, and a running total that refuses to
 * exist until every row is finished is a running total that is blank
 * exactly when it is being watched. Anything that does not parse
 * contributes nothing and the sum carries on.
 */
export function sumSplitRows(rows: SplitRow[]): number {
  return rows.reduce((sum, row) => sum + (parseMoney(row.amount) ?? 0), 0);
}

/**
 * Deliberately allowed to be POSITIVE. A transfer can land before you
 * know which gigs it covers, and refusing to save it until you do is
 * how a payment ends up not recorded at all.
 *
 * Negative is the error case, and the only one: that is
 * over-allocation, which the server rejects outright.
 */
export function unallocatedCents(amountCents: number, rows: SplitRow[]): number {
  return amountCents - sumSplitRows(rows);
}

/** The line under the split list, as `payment-unallocated` states it. */
export function unallocatedLabel(
  unallocated: number,
  formatMoney: (cents: number) => string,
): string {
  return unallocated === 0 ? "Fully allocated" : `Unallocated ${formatMoney(unallocated)}`;
}

/**
 * A blank row — no gig and no amount — is not an error and not a split;
 * it is the empty row the editor always leaves at the bottom for the
 * next gig. It is dropped before anything is validated or written.
 */
export function isBlankRow(row: SplitRow): boolean {
  return row.gigId === "" && row.amount.trim() === "";
}

export interface SplitValidation {
  /** The rows to write, blank ones dropped. Empty when `error` is set. */
  rows: ParsedSplit[];
  error: string | null;
}

/**
 * Everything that must hold before the split may be saved.
 *
 * Ordered so the user fixes the row in front of them before being told
 * about a total: a missing gig or an unreadable amount is a fault in
 * one row and is reported first, and only once every row is readable
 * does the sum mean anything.
 */
export function validateSplit(args: {
  amountCents: number;
  clientId: string;
  rows: SplitRow[];
  gigs: Gig[];
}): SplitValidation {
  const gigsById = new Map(args.gigs.map((gig) => [gig.id, gig]));
  const parsed: ParsedSplit[] = [];
  for (const row of args.rows) {
    if (isBlankRow(row)) continue;
    if (row.gigId === "") {
      return { rows: [], error: SPLIT_MESSAGE.missingGig };
    }
    const cents = parseMoney(row.amount);
    if (cents === null || cents <= 0) {
      return { rows: [], error: SPLIT_MESSAGE.badAmount };
    }
    // The rule the server applies to the gig, applied to the same gig
    // here. `gigsForClient` keeps a mismatch out of the dropdown, but a
    // gig's client can change on another device between the pull that
    // filled the list and this save.
    if (args.clientId !== "" && gigsById.get(row.gigId)?.clientId !== args.clientId) {
      return { rows: [], error: SPLIT_MESSAGE.wrongClient };
    }
    parsed.push({ id: row.id, gigId: row.gigId, amountCents: cents });
  }
  if (allocatedCents(parsed) > args.amountCents) {
    return { rows: [], error: SPLIT_MESSAGE.overAllocated };
  }
  return { rows: parsed, error: null };
}

/**
 * What the amount box does to a single untouched row.
 *
 * The one-gig payment is still the common one, and asking for the same
 * figure twice to record it would be a screen that got worse at its
 * main job in order to do a rarer one. So while nothing about the split
 * has been touched — one row, no amount edited, no row added or removed
 * — that row's amount simply IS the payment's.
 *
 * Only once a gig is chosen, though. `/payments/new` with no gig
 * carries an empty row, and mirroring the amount into it would turn
 * "record this transfer, attribute it later" into a validation error
 * about a gig the user never asked to name.
 *
 * A pure function over the state rather than an effect that writes it
 * back: the mirror is a VIEW of the amount, and storing it would make
 * "did the user type this?" unanswerable a moment later.
 */
export function applyAutoBalance(
  rows: SplitRow[],
  amountText: string,
  autoBalance: boolean,
): SplitRow[] {
  const only = rows[0];
  if (!autoBalance || rows.length !== 1 || only === undefined) return rows;
  return [{ ...only, amount: only.gigId === "" ? "" : amountText }];
}

export interface SplitWrites {
  /** Allocations to `putAllocation` — new rows and changed ones only. */
  upserts: ParsedSplit[];
  /** Allocation ids to `deleteAllocation`. */
  deletes: string[];
}

/**
 * The difference between the allocations a payment has and the ones the
 * form is asking for.
 *
 * Unchanged rows are left out of `upserts` on purpose. Every write goes
 * through the outbox, and re-sending a row nobody edited costs a sync
 * op and a server-side recompute of the gig's derived paid total to
 * arrive at the number already there.
 */
export function splitWrites(
  existing: Allocation[],
  rows: ParsedSplit[],
): SplitWrites {
  const wanted = new Map(rows.map((row) => [row.id, row]));
  const upserts = rows.filter((row) => {
    const before = existing.find((allocation) => allocation.id === row.id);
    return (
      before === undefined ||
      before.gigId !== row.gigId ||
      before.amountCents !== row.amountCents
    );
  });
  const deletes = existing
    .filter((allocation) => !wanted.has(allocation.id))
    .map((allocation) => allocation.id);
  return { upserts, deletes };
}

/** A saved payment's allocations, as editable rows. */
export function rowsFromAllocations(allocations: Allocation[]): SplitRow[] {
  return allocations.map((allocation) => ({
    id: allocation.id,
    gigId: allocation.gigId,
    amount: centsToInput(allocation.amountCents),
  }));
}
