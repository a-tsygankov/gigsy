/**
 * What capture got wrong, field by field: the "Recognised → Corrected"
 * block of a capture-error mail
 * (docs/superpowers/specs/2026-10-12-capture-report-error-design.md).
 *
 * Pure and defensive. `recognized` is a draft's extracted_json (the
 * ExtractedData shape, capture/extraction.ts) and `corrected` is the
 * review form's values as the webapp sent them — two DIFFERENT shapes
 * naming the same facts, which is why this file maps them field by
 * field rather than comparing objects:
 *
 *   recognised side                         corrected side
 *   kind, clientName, location,             same names
 *   category, notes
 *   amountCents (expense, payment) or       amountCents
 *   amountOfferedCents (anything else)
 *   dateTimesMs, or [dateTimeMs] when       dateTimes
 *   that list is missing or empty
 *
 * Both fallbacks are exactly how DraftReview seeds its form, so a form
 * the user left alone compares equal: a gig reads the offered amount,
 * an expense or payment the amount that changed hands, and the dates
 * are the list when the provider named any, else the single date kept
 * for drafts stored before the list existed.
 *
 * The rules match the webapp's `captureCorrections` (lib/capture-
 * report.ts), so the table the user saw before sending is the block the
 * admin reads: strings trimmed and case-sensitive, with null, undefined
 * and "" all meaning "absent"; money compared as integer cents; dates
 * compared to the minute (the date box holds minutes, so seconds a
 * provider returned are nothing the user could have kept or changed). Anything of the wrong type reads as absent rather
 * than throwing — a mail that cannot be built is a report that is lost.
 */

export interface CaptureDiffLine {
  /** Stable name: one of the keys below, or "amount" / "dates". */
  field: string;
  /** What the admin reads. */
  label: string;
  /** Display values, "—" when absent. Strings are quoted so a trailing
   *  space or an empty-vs-missing difference is visible in the mail. */
  recognized: string;
  corrected: string;
}

type Side = Record<string, unknown> | null;

const ABSENT = "—";

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function cents(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function msList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

function showText(value: string | null): string {
  return value === null ? ABSENT : JSON.stringify(value);
}

/** Cents as a plain decimal. No currency symbol: the draft does not
 *  record one, and guessing would make the mail say something false. */
function showCents(value: number | null): string {
  return value === null ? ABSENT : (value / 100).toFixed(2);
}

function showDates(value: number[]): string {
  return value.length === 0 ? ABSENT : value.map((ms) => new Date(ms).toISOString()).join(", ");
}

const MINUTE_MS = 60_000;
const toMinute = (ms: number) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;

function sameMoments(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => toMinute(v) === toMinute(b[i]!));
}

/** Text fields, by the name both sides share, with their labels. */
const TEXT_FIELDS = [
  ["kind", "Kind"],
  ["clientName", "Client"],
  ["location", "Location"],
] as const;
const TRAILING_TEXT_FIELDS = [
  ["category", "Category"],
  ["notes", "Notes"],
] as const;

function textLines(
  fields: readonly (readonly [string, string])[],
  recognized: Record<string, unknown>,
  corrected: Record<string, unknown>,
): CaptureDiffLine[] {
  const lines: CaptureDiffLine[] = [];
  for (const [field, label] of fields) {
    const r = text(recognized[field]);
    const c = text(corrected[field]);
    if (r !== c) lines.push({ field, label, recognized: showText(r), corrected: showText(c) });
  }
  return lines;
}

/**
 * The fields that differ, in the order the review form shows them —
 * kind, client, location, date, amount, category, notes — and nothing
 * for a field the user left alone.
 *
 * `corrected === null` means the client sent no corrections (the
 * extraction-failed path has nothing to correct), so nothing differs.
 * `recognized === null` with corrections present compares them against
 * an all-absent reading: every value the user typed is a difference.
 */
export function captureDiff(recognized: Side, corrected: Side): CaptureDiffLine[] {
  if (corrected === null) return [];
  const r = recognized ?? {};

  const lines = textLines(TEXT_FIELDS, r, corrected);

  // DraftReview's seeding rule: the list when it names any date, else
  // the single field — so an untouched form never reads as a change.
  const listed = msList(r["dateTimesMs"]);
  const recognizedDates = listed.length > 0 ? listed : msList([r["dateTimeMs"]]);
  const correctedDates = msList(corrected["dateTimes"]);
  if (!sameMoments(recognizedDates, correctedDates)) {
    lines.push({
      field: "dates",
      label: "Date",
      recognized: showDates(recognizedDates),
      corrected: showDates(correctedDates),
    });
  }

  // DraftReview's split: an expense or payment shows the amount that
  // changed hands, anything else (a gig, an unsure reading) the offer.
  const paidKind = r["kind"] === "expense" || r["kind"] === "payment";
  const recognizedCents = paidKind ? cents(r["amountCents"]) : cents(r["amountOfferedCents"]);
  const correctedCents = cents(corrected["amountCents"]);
  if (recognizedCents !== correctedCents) {
    lines.push({
      field: "amount",
      label: "Amount",
      recognized: showCents(recognizedCents),
      corrected: showCents(correctedCents),
    });
  }

  lines.push(...textLines(TRAILING_TEXT_FIELDS, r, corrected));
  return lines;
}
