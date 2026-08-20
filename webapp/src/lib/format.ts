/**
 * Money is stored as integer cents everywhere (docs/plan.md §4) and
 * only formatted at the display edge. USD hardcoded for now —
 * currency preference is a future settings concern.
 */
const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export function formatMoney(cents: number): string {
  return usd.format(cents / 100);
}

/**
 * A length of time as "3h 20m" — the reading half of `DurationField`,
 * which edits the same number as two boxes.
 *
 * Zero renders as "" rather than "0m". Nothing in this app stores a
 * zero-length span: the write schema makes `durationMinutes` positive
 * when present and treats unknown as null (backend/src/domain/
 * schemas.ts), and `workedMinutes` returns null rather than 0 for a
 * shift that has not finished. So "" only appears if a zero ever gets
 * this far, and an empty string is the honest rendering of a length
 * that should not exist — "0m" would read as a measured result.
 *
 * Lived in GigEdit.tsx until the gig screen split in three; the job
 * card, the work card and the form all state a duration, and three
 * copies would have drifted.
 */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h > 0 ? `${h}h` : "", m > 0 ? `${m}m` : ""].filter(Boolean).join(" ");
}
