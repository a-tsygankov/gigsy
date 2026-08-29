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
