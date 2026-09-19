/**
 * The invoice, end to end — and the one thing about it that cannot be
 * tested at all.
 *
 * No browser automation can drive a native print dialog, so this never
 * asserts that a PDF appeared. What it CAN assert is the two halves
 * that decide whether the PDF is right: the document says what it
 * should, and the print rules are actually in force. The second is
 * read as a computed style rather than inferred from a class name —
 * the same move reachability.spec.ts makes to prove help.css reached
 * the page.
 *
 * A fourth thing this file deliberately does NOT attempt: picking a
 * real client from the dropdown, pressing "Create invoice", and
 * landing on a document whose number is one more than before. That
 * path needs a client with billable, unpaid work inside the default
 * report period — a client alone is not enough (Reports.tsx only
 * shows the Create button once one is selected, and it renders
 * `invoice-empty` instead of navigating for a client with nothing to
 * bill). No helper in this suite seeds a priced, unpaid gig, and the
 * shared dev account this suite runs against currently has zero
 * clients — building that fixture here would mean inventing gig data
 * this suite has no other use for and no reset helper to keep clean,
 * which is exactly the kind of shared-state risk `resetGigListView`
 * exists to guard against elsewhere. Left to the manual walkthrough in
 * Task 10.
 */
import { expect, test } from "@playwright/test";
import { requireTestAuth, resetGigListView } from "./helpers/test-auth.ts";

test.beforeEach(async ({ page, request, baseURL }) => {
  await requireTestAuth(request, baseURL!);
  await resetGigListView(request, baseURL!);
  await page.goto("/login");
  await page.getByTestId("test-signin").click();
  await expect(page.getByTestId("tab-bar")).toBeVisible();
});

test("an invoice needs a client before it can be created", async ({ page }) => {
  await page.goto("/reports");
  // "All clients" is the default — Reports.tsx's `clientId` is a plain
  // `useState("")`, not a persisted filter, so this holds on a fresh
  // load regardless of what the shared dev account's saved gig-list
  // view (reset above) or any other persisted state says.
  await expect(page.getByTestId("invoice-needs-client")).toBeVisible();
  await expect(page.getByTestId("invoice-create")).toHaveCount(0);
});

test("a bad invoice link refuses rather than printing a nonsense number", async ({
  page,
}) => {
  await page.goto("/reports/invoice?client=c1");
  await expect(page.getByTestId("invoice-bad-link")).toBeVisible();
  await expect(page.getByTestId("invoice-number")).toHaveCount(0);
});

test("the print stylesheet actually hides the app chrome", async ({ page }) => {
  // A complete link: `issued` is required now that the issue date
  // travels in the URL, so a link without it renders the bad-link
  // card instead of a document.
  await page.goto(`/reports/invoice?client=whoever&n=1&issued=${Date.now()}`);
  await expect(page.getByTestId("invoice-document")).toBeVisible();
  // Emulating print is the only way to observe @media print rules; the
  // dialog itself is out of reach.
  await page.emulateMedia({ media: "print" });
  const tabBar = page.getByTestId("tab-bar");
  await expect
    .poll(async () => tabBar.evaluate((el) => getComputedStyle(el).display))
    .toBe("none");
  await page.emulateMedia({ media: "screen" });
  await expect
    .poll(async () => tabBar.evaluate((el) => getComputedStyle(el).display))
    .not.toBe("none");
});

/**
 * What the button DOES — the one thing invoice.spec never asserted,
 * which is how "Print or save as PDF does nothing" reached a phone
 * unnoticed. The native dialog is still out of reach; `window.print`
 * itself is not, so it is replaced before the app loads and the click
 * is judged by whether it was called.
 */
test("the print button really calls window.print in a browser", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __prints: number }).__prints = 0;
    window.print = () => {
      (window as unknown as { __prints: number }).__prints += 1;
    };
  });
  await page.goto(`/reports/invoice?client=whoever&n=1&issued=${Date.now()}`);
  const button = page.getByTestId("invoice-print");
  await expect(button).toHaveText("Print or save as PDF");
  await button.click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __prints: number }).__prints))
    .toBe(1);
});

/**
 * The installed iOS app, emulated: an iPhone user agent, Safari's
 * `navigator.standalone`, and a share sheet that records what it was
 * handed. There `window.print()` is a silent no-op — WebKit has no
 * print sheet in standalone mode — so the button must hand the invoice
 * to the share sheet as a file instead (lib/invoice-export.ts). This is
 * the report, verbatim, and the test that would have caught it.
 */
test("in the installed iOS app the button shares the invoice as a file", async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    baseURL: baseURL!,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { value: true });
    const w = window as unknown as { __shared: { name: string; type: string }[]; __prints: number };
    w.__shared = [];
    w.__prints = 0;
    window.print = () => {
      w.__prints += 1;
    };
    Object.defineProperty(navigator, "canShare", { value: () => true });
    Object.defineProperty(navigator, "share", {
      value: async (data: { files: File[] }) => {
        w.__shared.push(...data.files.map((f) => ({ name: f.name, type: f.type })));
      },
    });
  });
  // Signed in through this fresh context, the same way beforeEach does.
  await page.goto("/login");
  await page.getByTestId("test-signin").click();
  await expect(page.getByTestId("tab-bar")).toBeVisible();

  await page.goto(`/reports/invoice?client=whoever&n=2&issued=${Date.now()}`);
  const button = page.getByTestId("invoice-print");
  await expect(button).toHaveText("Share as a file");
  await expect(page.getByTestId("invoice-print-hint")).toBeVisible();
  await button.click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared))
    .toEqual([{ name: "Invoice INV-0002.html", type: "text/html" }]);
  expect(await page.evaluate(() => (window as unknown as { __prints: number }).__prints)).toBe(0);
  await context.close();
});
