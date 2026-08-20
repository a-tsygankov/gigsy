import { test, expect } from "@playwright/test";
import { requireTestAuth } from "./helpers/test-auth.ts";

// The Phase 5 signature journey: photo capture → AI draft → review →
// confirm → real gig. Runs against the deterministic stub extractor
// (AI_PROVIDER=stub, non-production only) — see helpers/test-auth.ts
// for when these skip versus fail.

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);


test.beforeEach(async ({ page, request, baseURL }) => {
  await requireTestAuth(request, baseURL!);
  await page.goto("/login");
  await page.getByTestId("test-signin").click();
  await expect(page.getByTestId("tab-bar")).toBeVisible();
});

test("photo capture → draft review → confirm creates the gig", async ({
  page,
}) => {
  await page.getByRole("link", { name: "Capture a gig or receipt" }).click();
  await page.getByTestId("capture-input").setInputFiles({
    name: "flyer.png",
    mimeType: "image/png",
    buffer: TINY_PNG,
  });

  // Review screen with the stub's extraction + new-client banner
  // (or, on later runs, the matched-client banner — both count).
  await expect(page.getByTestId("match-banner")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("match-banner")).toContainText("Stub Staffing Co");
  await expect(page.getByLabel("Offered ($)")).toHaveValue("125.00");

  await page.getByRole("button", { name: "Confirm gig" }).click();

  // Lands on the created gig's own screen, filled in from the draft.
  await expect(page.getByTestId("gig-job-card")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("job-location")).toHaveText("Stubville Expo Hall");
});

test("discarding a draft removes it from the pending list", async ({ page }) => {
  await page.getByRole("link", { name: "Capture a gig or receipt" }).click();
  await page.getByTestId("capture-input").setInputFiles({
    name: "flyer.png",
    mimeType: "image/png",
    buffer: TINY_PNG,
  });
  await expect(page.getByTestId("match-banner")).toBeVisible({ timeout: 15_000 });
  const draftUrl = page.url();

  page.on("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Discard draft" }).click();
  await expect(page).toHaveURL(/\/drafts$/);

  // Reopening the discarded draft shows the already-reviewed notice.
  await page.goto(draftUrl);
  await expect(page.getByText(/already discarded/)).toBeVisible();
});
