/**
 * CSV writing for the export feature (docs/plan.md §10). Pure
 * functions — the DOM helper is the only impure part.
 *
 * Two rules the rest of the app depends on:
 * - RFC 4180 quoting, CRLF row separators (what Excel expects).
 * - A formula-injection guard. Capture (docs/plan.md §8) writes text
 *   extracted from forwarded emails and photos straight into notes and
 *   locations, so a cell can arrive starting with `=`, `+`, `-`, `@`,
 *   a tab, or a CR — all of which Excel and Google Sheets execute when
 *   the file is opened. Such cells are prefixed with an apostrophe,
 *   which both tools read as "this is text".
 */

export type CsvValue = string | number | null | undefined;

const NEEDS_QUOTING = /[",\r\n]/;
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/** One field, escaped and guarded. Numbers stay bare so spreadsheets
 * parse them as values (a negative number is a value, not a formula). */
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);

  const guarded = FORMULA_TRIGGER.test(value) ? `'${value}` : value;
  return NEEDS_QUOTING.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

/** Header row + one row per record. */
export function toCsv(headers: string[], rows: CsvValue[][]): string {
  const line = (cells: CsvValue[]) => cells.map(csvCell).join(",");
  return [line(headers), ...rows.map(line)].join("\r\n");
}

/** Hand the file to the browser. Client-side by necessity: the API
 * authenticates with a bearer header, so a plain download link could
 * never carry auth — and generating locally means exports work
 * offline, from the Dexie ledger. */
export function downloadCsv(filename: string, csv: string): void {
  // The BOM makes Excel read the file as UTF-8 instead of the local
  // codepage, which otherwise mangles non-ASCII client names.
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
