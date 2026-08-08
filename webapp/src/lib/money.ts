/**
 * Money input parsing — the edit-form counterpart of format.ts.
 * Users type dollars; storage and APIs are integer cents only
 * (docs/plan.md §4).
 */

/** "123.45" | "$1,234.5" | "-5" → integer cents; null on anything
 * that isn't a plain money amount (max 2 decimals). */
export function parseMoney(input: string): number | null {
  const cleaned = input.trim().replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const negative = cleaned.startsWith("-");
  const [whole = "0", frac = ""] = (negative ? cleaned.slice(1) : cleaned).split(".");
  const cents = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return negative ? -cents : cents;
}

/** Integer cents → editable "123.45" (no symbol — inputs stay plain). */
export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}
