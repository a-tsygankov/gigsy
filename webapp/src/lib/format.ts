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
