/**
 * What a capture "Report error" says about a reading — decided here,
 * pure, so the sheet that shows it and the tests that pin it read the
 * same rules (docs/superpowers/specs/2026-10-12-capture-report-error-
 * design.md, "What a report carries" and "Webapp").
 *
 * Three jobs, one per export:
 *
 *   - `correctedFromForm` turns the review form's strings (DraftReview
 *     holds "125.00", "2026-09-14T09:00", a ClientChoice) into the
 *     values a report carries: cents, epoch ms, a client NAME. The
 *     server stores this as `context_json.corrected`, so it is the
 *     same shape the design doc writes out.
 *   - `captureCorrections` compares that against what extraction read
 *     (`draft.extracted`) and keeps only the fields that differ, each
 *     with a human label and both sides as display strings — the
 *     table the sheet shows so the person sees exactly what is sent.
 *   - `captureReportMessage` is the message line: what the person
 *     typed when they typed something, otherwise one generated from
 *     the corrections, otherwise nothing — and "nothing" is how the
 *     sheet knows Send has nothing to send.
 *
 * The client's copy of `recognized` is only ever used for DISPLAY. The
 * server reads its own from the draft row (the design's "client's copy
 * is not trusted" rule), so nothing here needs to be tamper-proof — it
 * needs to agree with what the review form showed.
 */
import { clientChoiceName, type ClientChoice } from "./client-choice.ts";
import { formatLocalMoment, localInputToMs } from "./datetime.ts";
import { formatMoney } from "./format.ts";
import { parseMoney } from "./money.ts";
import type { Client, DraftExtracted } from "./types.ts";

/** The kinds the review form can be set to. `unknown` is a reading,
 *  never a choice — the form seeds it as a gig. */
export type CaptureKind = "gig" | "expense" | "payment";

/** The review form's values at the moment of reporting — the
 *  `corrected` part of a capture-error report. Field names are the
 *  design doc's `context_json.corrected` keys, one for one. */
export interface CorrectedCapture {
  kind: CaptureKind;
  clientName: string | null;
  location: string | null;
  /** Every date the form holds, primary first, blank rows dropped. */
  dateTimes: number[];
  amountCents: number | null;
  category: string | null;
  notes: string | null;
}

/** What DraftReview holds, as it holds it. `clients` is the local list
 *  the client select offers — what an `existing` choice is named by. */
export interface CaptureFormState {
  kind: CaptureKind;
  client: ClientChoice;
  clients: readonly Pick<Client, "id" | "name">[];
  location: string;
  dateTime: string;
  extraDates: readonly string[];
  amount: string;
  category: string;
  notes: string;
}

export type CaptureField = keyof CorrectedCapture;

/** One row of the recognised → corrected table. */
export interface CaptureCorrection {
  field: CaptureField;
  label: string;
  recognized: string;
  corrected: string;
}

/** The message when extraction failed and the person typed nothing —
 *  stated once so the sheet and its test cannot disagree. */
export const CAPTURE_UNREADABLE_MESSAGE = "Capture could not read this.";

/** A blank string is a missing value: the form cannot tell "" from
 *  "nothing read", and neither should the comparison. */
function text(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/** Read the review form into the shape a report carries. An amount the
 *  form would refuse on Confirm reads as none — the report is about
 *  what extraction got wrong, and a half-typed number is not an answer. */
export function correctedFromForm(state: CaptureFormState): CorrectedCapture {
  const dateTimes = [state.dateTime, ...state.extraDates]
    .map(localInputToMs)
    .filter((ms): ms is number => ms !== null);
  return {
    kind: state.kind,
    clientName: text(clientChoiceName(state.client, state.clients)),
    location: text(state.location),
    dateTimes,
    amountCents: state.amount.trim() === "" ? null : parseMoney(state.amount),
    category: text(state.category),
    notes: text(state.notes),
  };
}

/** `draft.extracted` in the corrected shape, read the way DraftReview
 *  seeds its form from it — so an untouched form compares equal. The
 *  kind stays as read, `unknown` included: a person settling it IS a
 *  correction. */
type RecognizedCapture = Omit<CorrectedCapture, "kind"> & { kind: DraftExtracted["kind"] };

function recognizedCapture(extracted: DraftExtracted): RecognizedCapture {
  // Same fallback as DraftReview's seeding: every date when the
  // provider named them, else the single `dateTimeMs` older drafts have.
  const dates =
    extracted.dateTimesMs != null && extracted.dateTimesMs.length > 0
      ? extracted.dateTimesMs
      : [extracted.dateTimeMs ?? null];
  // Same split as DraftReview's: a gig names what was OFFERED, an
  // expense or payment the amount that changed hands.
  const cents =
    extracted.kind === "expense" || extracted.kind === "payment"
      ? extracted.amountCents
      : extracted.amountOfferedCents;
  return {
    kind: extracted.kind,
    clientName: text(extracted.clientName),
    location: text(extracted.location),
    dateTimes: dates.filter((ms): ms is number => ms != null),
    amountCents: cents ?? null,
    category: text(extracted.category),
    notes: text(extracted.notes),
  };
}

const KIND_LABEL: Record<DraftExtracted["kind"], string> = {
  gig: "Gig",
  expense: "Expense",
  payment: "Payment",
  unknown: "Not sure",
};

/** How an absent value is shown — a dash, so "removed" never renders
 *  as an empty cell that looks like a layout bug. */
const NONE = "—";

/** The date box holds minutes; seconds a provider returned are not
 *  something the person could have kept or changed. */
const MINUTE_MS = 60_000;
const toMinute = (ms: number) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;

/**
 * Per field: its label, when two values count as the same, and how one
 * is shown. A table rather than a branch per field so adding a field is
 * one row, and the comparison rules the design names (money as cents,
 * dates as moments, strings trimmed and case-sensitive) sit side by
 * side where a reviewer can check them. Order is the review form's.
 */
interface FieldSpec<K extends CaptureField> {
  field: K;
  label: string;
  same: (a: RecognizedCapture[K], b: RecognizedCapture[K]) => boolean;
  show: (value: RecognizedCapture[K]) => string;
}

const exact = <T>(a: T, b: T) => a === b;
const showText = (value: string | null) => value ?? NONE;

const FIELD_SPECS: { [K in CaptureField]: FieldSpec<K> }[CaptureField][] = [
  { field: "kind", label: "Kind", same: exact, show: (kind) => KIND_LABEL[kind] },
  { field: "clientName", label: "Client", same: exact, show: showText },
  { field: "location", label: "Location", same: exact, show: showText },
  {
    field: "dateTimes",
    label: "Date & time",
    same: (a, b) => a.length === b.length && a.every((ms, i) => toMinute(ms) === toMinute(b[i]!)),
    // "; " between moments — each one already has commas in it.
    show: (dates) => (dates.length === 0 ? NONE : dates.map(formatLocalMoment).join("; ")),
  },
  {
    field: "amountCents",
    label: "Amount",
    same: exact,
    show: (cents) => (cents === null ? NONE : formatMoney(cents)),
  },
  { field: "category", label: "Category", same: exact, show: showText },
  { field: "notes", label: "Notes", same: exact, show: showText },
];

/** One spec applied to one pair. Generic so `same` and `show` see the
 *  field's own type; the array above loses that, this gets it back. */
function compare<K extends CaptureField>(
  spec: FieldSpec<K>,
  recognized: RecognizedCapture,
  corrected: CorrectedCapture,
): CaptureCorrection | null {
  const before = recognized[spec.field];
  const after = corrected[spec.field] as RecognizedCapture[K];
  if (spec.same(before, after)) return null;
  return {
    field: spec.field,
    label: spec.label,
    recognized: spec.show(before),
    corrected: spec.show(after),
  };
}

/** The fields the person changed from what extraction read, in form
 *  order. Unchanged fields are left out: the table is "what was wrong",
 *  and seven rows of which six agree would bury the one that matters. */
export function captureCorrections(
  recognized: DraftExtracted,
  corrected: CorrectedCapture,
): CaptureCorrection[] {
  const read = recognizedCapture(recognized);
  // Both sides through the same string rule: `correctedFromForm`
  // already trims, but a caller handing in its own values must not
  // turn a stray space into a "correction".
  const held: CorrectedCapture = {
    ...corrected,
    clientName: text(corrected.clientName),
    location: text(corrected.location),
    category: text(corrected.category),
    notes: text(corrected.notes),
  };
  return FIELD_SPECS.map((spec) =>
    compare(spec as FieldSpec<CaptureField>, read, held),
  ).filter((row): row is CaptureCorrection => row !== null);
}

/**
 * The message a report goes out with, or null when there is nothing to
 * say. `corrections` is null when nothing was recognised at all (the
 * extraction-failed path), where the failure itself is the report.
 *
 * Typed text wins: the person's words beat any summary of them. With
 * no text, a review report names its corrected fields, so the mail
 * subject says what went wrong without anyone opening it; a review
 * with neither text nor corrections has nothing to report, and the
 * sheet holds Send.
 */
export function captureReportMessage(
  typed: string,
  corrections: readonly CaptureCorrection[] | null,
): string | null {
  const own = typed.trim();
  if (own !== "") return own;
  if (corrections === null) return CAPTURE_UNREADABLE_MESSAGE;
  if (corrections.length === 0) return null;
  const n = corrections.length;
  return `Capture read ${n} field${n === 1 ? "" : "s"} wrong: ${corrections
    .map((row) => row.label)
    .join(", ")}`;
}
