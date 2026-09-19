/**
 * Getting the invoice out of the app.
 *
 * The PDF is the browser's: `window.print()` over `styles/print.css`,
 * and the person chooses "Save as PDF" in the dialog. That decision is
 * argued in docs/superpowers/specs/2026-08-28-invoice-pdf-design.md
 * (text in any alphabet comes out right; no PDF library) and it stands.
 *
 * What the design did not know: in the INSTALLED iOS app — launched
 * from the home screen, which is the surface this app is built for —
 * `window.print()` is a silent no-op. WebKit has no print sheet in
 * standalone mode, the call returns, and nothing happens. That is the
 * "Print or save as PDF does nothing" report, verbatim.
 *
 * So there are two ways out, chosen by where the app is running:
 *
 *   print  — everywhere the dialog exists. Browsers, and installed apps
 *            on Android, where Chrome prints from standalone.
 *   share  — the installed iOS app. The document is written out as one
 *            self-contained HTML file and handed to the share sheet
 *            (Web Share with files, which iOS supports from a home-screen
 *            app). From there it is one tap to Files, Mail, AirDrop —
 *            and opening it in Safari or Files gives the print dialog
 *            this app cannot: Print → Save as PDF.
 *
 * HTML rather than a PDF for the same reason the design chose the
 * browser's PDF: the client's name, the addresses and the notes are
 * text in whatever alphabet the user writes in, and only a real
 * renderer gets that right. The file is built from the document, not
 * scraped from the screen, so it carries its own styles and none of the
 * app's classes — it has to read as an invoice in a mail client that
 * has never heard of Tailwind.
 */
import { formatMoney } from "./format.ts";
import type { InvoiceDocument } from "./invoice.ts";
import { isIos, isStandalone, type PwaEnvSource } from "./pwa-env.ts";
import { isoDate } from "./report-export.ts";

export type InvoiceExportStrategy = "print" | "share";

export function invoiceExportStrategy(env: PwaEnvSource): InvoiceExportStrategy {
  return isIos(env) && isStandalone(env) ? "share" : "print";
}

/** "Invoice INV-7.html" — the number is already formatted for people. */
export function invoiceFileName(doc: Pick<InvoiceDocument, "number">): string {
  return `Invoice ${doc.number.replace(/[^\w-]+/g, "-")}.html`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Text with the user's own line breaks kept — addresses and payment
 *  details are entered as several lines and must print as several. */
function lines(text: string): string {
  return text.split(/\r?\n/).map(escapeHtml).join("<br>");
}

const STYLE = `
  body { font: 14px/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         color: #0f172a; margin: 0; padding: 24px; max-width: 720px; }
  section { border: 1px solid #cbd5e1; border-radius: 8px; padding: 16px; margin: 0 0 16px; }
  .head { display: flex; justify-content: space-between; gap: 24px; }
  .right { text-align: right; }
  .muted { color: #475569; }
  .warn { color: #b45309; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  p { margin: 0 0 4px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 4px 0; vertical-align: top; }
  td.amount { text-align: right; white-space: nowrap; }
  tr { break-inside: avoid; }
  .total { text-align: right; font-weight: 600; margin-top: 12px; }
  @page { margin: 16mm; }
`;

/**
 * The invoice as one file that stands on its own: no app, no classes,
 * no stylesheet to fetch. Mirrors what Invoice.tsx renders, section for
 * section, including the "could not price" notice — a file that hides
 * that is a file that under-bills in silence.
 */
export function invoiceHtml(doc: InvoiceDocument): string {
  const business = doc.business;
  const head = `
    <section>
      <div class="head">
        <div>
          ${
            business.name === null
              ? `<p class="warn">No business details yet.</p>`
              : `<h1>${escapeHtml(business.name)}</h1>`
          }
          ${business.address !== null ? `<p>${lines(business.address)}</p>` : ""}
          ${business.contact !== null ? `<p>${escapeHtml(business.contact)}</p>` : ""}
          ${business.taxId !== null ? `<p>Tax no. ${escapeHtml(business.taxId)}</p>` : ""}
        </div>
        <div class="right">
          <p><strong>${escapeHtml(doc.number)}</strong></p>
          <p>Issued ${isoDate(doc.issuedAt)}</p>
          <p>Due ${isoDate(doc.dueAt)}</p>
        </div>
      </div>
      <p style="margin-top:12px">Billed to ${escapeHtml(doc.client.name)}</p>
    </section>`;

  const unpriced =
    doc.unpricedGigs.length === 0
      ? ""
      : `
    <section>
      <p class="warn">Not billed — could not be priced:</p>
      <ul class="warn">${doc.unpricedGigs.map((g) => `<li>${escapeHtml(g.description)}</li>`).join("")}</ul>
    </section>`;

  const row = (date: number, description: string, cents: number) =>
    `<tr><td>${isoDate(date)}</td><td>${escapeHtml(description)}</td><td class="amount">${formatMoney(cents)}</td></tr>`;
  const empty = doc.lines.length === 0 && doc.expenses.length === 0;
  const body = empty
    ? `<section><p>Nothing to invoice — this client has no unpaid work in the period selected.</p></section>`
    : `
    <section>
      <table>
        <tbody>
          ${doc.lines.map((l) => row(l.date, l.description, l.amountCents)).join("")}
          ${doc.expenses.map((l) => row(l.date, `${l.description} (expense)`, l.amountCents)).join("")}
        </tbody>
      </table>
      <p class="total">Total ${formatMoney(doc.totalCents)}</p>
    </section>`;

  const payment =
    business.paymentDetails === null
      ? ""
      : `<section><p>${lines(business.paymentDetails)}</p></section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(doc.number)}</title>
<style>${STYLE}</style>
</head>
<body>${head}${unpriced}${body}${payment}</body>
</html>`;
}

/** Just what sharing a file needs off `navigator`. */
export interface FileSharer {
  canShare?(data: { files: File[] }): boolean;
  share?(data: { files: File[]; title?: string }): Promise<void>;
}

export type ShareOutcome = "shared" | "cancelled" | "unsupported";

/**
 * Hand the file to the share sheet.
 *
 * "cancelled" is the person closing the sheet — an AbortError — and is
 * not a failure to report. "unsupported" is a device with no Web Share
 * for files, which the caller turns into a download instead.
 */
export async function shareInvoiceFile(sharer: FileSharer, doc: InvoiceDocument): Promise<ShareOutcome> {
  const file = new File([invoiceHtml(doc)], invoiceFileName(doc), { type: "text/html" });
  const data = { files: [file], title: doc.number };
  if (sharer.share === undefined || sharer.canShare?.(data) === false) return "unsupported";
  try {
    await sharer.share(data);
    return "shared";
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return "cancelled";
    return "unsupported";
  }
}

/** The fallback for a device with no file sharing: a plain download of
 *  the same file, through an anchor the way every browser understands. */
export function downloadInvoiceFile(doc: InvoiceDocument, docRoot: Document = document): void {
  const blob = new Blob([invoiceHtml(doc)], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = docRoot.createElement("a");
  a.href = url;
  a.download = invoiceFileName(doc);
  docRoot.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
