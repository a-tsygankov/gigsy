import { describe, expect, it, vi } from "vitest";
import {
  downloadInvoiceFile,
  invoiceExportStrategy,
  invoiceFileName,
  invoiceHtml,
  shareInvoiceFile,
} from "./invoice-export.ts";
import type { InvoiceDocument } from "./invoice.ts";
import { isoDate } from "./report-export.ts";

const DOC: InvoiceDocument = {
  number: "INV-7",
  issuedAt: Date.UTC(2026, 8, 19),
  dueAt: Date.UTC(2026, 9, 3),
  business: {
    name: "Цыганков & Co <Ltd>",
    address: "1 High St\nNatick, MA",
    contact: "me@example.com",
    taxId: "TX-1",
    paymentDetails: "Zelle: me@example.com\nor cash",
  },
  client: { id: "c1", name: "ACME \"Tastings\"" },
  lines: [{ date: Date.UTC(2026, 7, 10), description: "Tasting tequilas", amountCents: 15000 }],
  expenses: [{ date: Date.UTC(2026, 7, 10), description: "Parking", amountCents: 1250 }],
  unpricedGigs: [{ id: "g9", description: "Evening shift (no rate)" }],
  totalCents: 16250,
};

const env = (over: { ua?: string; standalone?: boolean; displayMode?: boolean } = {}) => ({
  userAgent: over.ua ?? "Mozilla/5.0 (Windows NT 10.0) Chrome/150",
  ...(over.standalone !== undefined ? { standalone: over.standalone } : {}),
  matchMedia: (q: string) => ({
    matches: q === "(display-mode: standalone)" ? (over.displayMode ?? false) : false,
  }),
});
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15";

describe("invoiceExportStrategy — print where a dialog exists, share where it does not", () => {
  it("prints in a browser tab, on any device", () => {
    expect(invoiceExportStrategy(env())).toBe("print");
    expect(invoiceExportStrategy(env({ ua: IPHONE }))).toBe("print");
  });

  it("shares in the installed iOS app — window.print() is a no-op there", () => {
    // Either signal iOS gives for "launched from the home screen".
    expect(invoiceExportStrategy(env({ ua: IPHONE, standalone: true }))).toBe("share");
    expect(invoiceExportStrategy(env({ ua: IPHONE, displayMode: true }))).toBe("share");
  });

  it("still prints in an installed app that is not iOS — Chrome prints from standalone", () => {
    expect(
      invoiceExportStrategy(env({ ua: "Mozilla/5.0 (Linux; Android 15) Chrome/150", displayMode: true })),
    ).toBe("print");
  });
});

describe("invoiceFileName", () => {
  it("carries the invoice number and nothing a file system would refuse", () => {
    expect(invoiceFileName({ number: "INV-7" })).toBe("Invoice INV-7.html");
    expect(invoiceFileName({ number: "INV/7 draft?" })).toBe("Invoice INV-7-draft-.html");
  });
});

describe("invoiceHtml — the document as one self-contained file", () => {
  const html = invoiceHtml(DOC);

  it("is a complete page with its own styles and no app classes", () => {
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("<style>");
    expect(html).not.toMatch(/class="[^"]*(text-sm|rounded|space-y)/);
  });

  it("mirrors every section the screen renders", () => {
    expect(html).toContain("INV-7");
    expect(html).toContain(`Issued ${isoDate(DOC.issuedAt)}`);
    expect(html).toContain(`Due ${isoDate(DOC.dueAt)}`);
    expect(html).toContain("Billed to ACME");
    expect(html).toContain("Tasting tequilas");
    expect(html).toContain("Parking (expense)");
    expect(html).toContain("$12.50");
    expect(html).toContain("Total $162.50");
    expect(html).toContain("Zelle: me@example.com");
    expect(html).toContain("Tax no. TX-1");
  });

  it("keeps the could-not-price notice — a file that hides it under-bills in silence", () => {
    expect(html).toContain("could not be priced");
    expect(html).toContain("Evening shift (no rate)");
  });

  it("escapes what the user typed and keeps their line breaks", () => {
    expect(html).toContain("Цыганков &amp; Co &lt;Ltd&gt;");
    expect(html).toContain("ACME &quot;Tastings&quot;");
    expect(html).toContain("1 High St<br>Natick, MA");
    expect(html).not.toContain("<Ltd>");
  });

  it("says so when there is nothing to bill", () => {
    expect(invoiceHtml({ ...DOC, lines: [], expenses: [], unpricedGigs: [], totalCents: 0 })).toContain(
      "Nothing to invoice",
    );
  });

  it("leaves out what the business has not filled in", () => {
    const bare = invoiceHtml({
      ...DOC,
      business: { name: null, address: null, contact: null, taxId: null, paymentDetails: null },
    });
    expect(bare).toContain("No business details yet");
    expect(bare).not.toContain("Tax no.");
    expect(bare).not.toContain("Zelle");
  });
});

describe("shareInvoiceFile", () => {
  it("hands one HTML file, named for the invoice, to the share sheet", async () => {
    const share = vi.fn<(data: { files: File[]; title?: string }) => Promise<void>>(async () => undefined);
    const canShare = vi.fn(() => true);
    expect(await shareInvoiceFile({ share, canShare }, DOC)).toBe("shared");
    const data = share.mock.calls[0]![0] as { files: File[]; title: string };
    expect(data.files).toHaveLength(1);
    expect(data.files[0]!.name).toBe("Invoice INV-7.html");
    expect(data.files[0]!.type).toBe("text/html");
    expect(data.title).toBe("INV-7");
    expect(canShare).toHaveBeenCalledWith(data);
  });

  it("treats the sheet being closed as cancelled, not as a failure", async () => {
    const abort = Object.assign(new Error("closed"), { name: "AbortError" });
    expect(await shareInvoiceFile({ share: vi.fn(async () => Promise.reject(abort)) }, DOC)).toBe(
      "cancelled",
    );
  });

  it("reports a device that cannot share files, so the caller downloads instead", async () => {
    expect(await shareInvoiceFile({}, DOC)).toBe("unsupported");
    expect(await shareInvoiceFile({ share: vi.fn(), canShare: () => false }, DOC)).toBe("unsupported");
    const broken = vi.fn(async () => Promise.reject(new TypeError("not allowed")));
    expect(await shareInvoiceFile({ share: broken }, DOC)).toBe("unsupported");
  });
});

describe("downloadInvoiceFile", () => {
  it("clicks a download link for the same file and cleans up after itself", () => {
    const clicked: { href: string; download: string }[] = [];
    const anchor = {
      href: "",
      download: "",
      click() {
        clicked.push({ href: this.href, download: this.download });
      },
      remove: vi.fn(),
    };
    const docRoot = {
      createElement: () => anchor,
      body: { appendChild: vi.fn() },
    } as unknown as Document;
    const create = vi.fn(() => "blob:x");
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
    try {
      downloadInvoiceFile(DOC, docRoot);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(clicked).toEqual([{ href: "blob:x", download: "Invoice INV-7.html" }]);
    expect(anchor.remove).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("blob:x");
  });
});
