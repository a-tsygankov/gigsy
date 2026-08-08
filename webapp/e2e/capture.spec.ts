import { test, expect, type APIRequestContext } from "@playwright/test";

// The Phase 5 signature journey: photo capture → AI draft → review →
// confirm → real gig. Runs against the deterministic stub extractor
// (AI_PROVIDER=stub, non-production only) — self-skips where either
// test auth or the stub is unavailable (e.g. PR previews → prod).

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

async function testAuthAvailable(request: APIRequestContext, baseURL: string) {
  try {
    const res = await request.get(`${baseURL}/api/auth/config`);
    if (!res.ok()) return false;
    return ((await res.json()) as { testAuthEnabled?: boolean }).testAuthEnabled === true;
  } catch {
    return false;
  }
}

test.beforeEach(async ({ page, request, baseURL }) => {
  test.skip(
    !(await testAuthAvailable(request, baseURL!)),
    "test auth disabled on this deployment",
  );
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

  // Lands on the created gig, prefilled from the draft.
  await expect(page.getByRole("heading", { name: "Edit gig" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByLabel("Location")).toHaveValue("Stubville Expo Hall");
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
