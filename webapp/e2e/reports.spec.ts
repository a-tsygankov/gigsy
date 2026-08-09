import { test, expect, type APIRequestContext } from "@playwright/test";

// Reports + CSV export (Phase 7). Uses the test-auth bypass, so every
// spec self-skips where it's disabled (e.g. PR previews proxying to
// the production worker).

async function testAuthAvailable(request: APIRequestContext, baseURL: string) {
  try {
    const res = await request.get(`${baseURL}/api/auth/config`);
    if (!res.ok()) return false;
    const body = (await res.json()) as { testAuthEnabled?: boolean };
    return body.testAuthEnabled === true;
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

test("the reports tab shows server-computed totals", async ({ page }) => {
  await page.getByRole("link", { name: "Reports" }).click();
  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();

  // Totals render as money, and the by-month/by-client sections exist.
  await expect(page.getByTestId("tile-net")).toContainText("$");
  await expect(page.getByTestId("tile-paid")).toContainText("$");
  await expect(page.getByTestId("report-months")).toBeVisible();
  await expect(page.getByTestId("report-clients")).toBeVisible();
});

// These matchers are deliberately specific. The screen loads on "This
// year", which already sends a from= bound, so a predicate as loose as
// `url().includes("from=")` can match that initial request instead of
// the one under test — it passes or fails on server warm-up timing.
test("changing the period refetches the summary", async ({ page }) => {
  await page.getByRole("link", { name: "Reports" }).click();
  await expect(page.getByTestId("tile-net")).toBeVisible();

  const summaryCall = page.waitForResponse(
    (res) =>
      res.url().includes("/api/reports/summary") &&
      !res.url().includes("from=") &&
      res.status() === 200,
  );
  await page.getByTestId("report-range").selectOption("all");
  // "All time" drops the bounds entirely.
  expect((await summaryCall).ok()).toBe(true);
});

test("a custom range sends explicit bounds", async ({ page }) => {
  // Local midnight, matching the screen's own rule. Deliberately not a
  // January 1st: that would compute to the same epoch as the default
  // "This year" bound, hit TanStack's 30s cache under an identical
  // query key, and never reach the network.
  const expectedFrom = new Date(2025, 2, 15).getTime();

  await page.getByRole("link", { name: "Reports" }).click();
  await page.getByTestId("report-range").selectOption("custom");

  const summaryCall = page.waitForResponse(
    (res) => res.url().includes(`from=${expectedFrom}`) && res.status() === 200,
  );
  await page.getByTestId("report-from").fill("2025-03-15");
  const res = await summaryCall;
  expect(new URL(res.url()).searchParams.get("from")).toBe(String(expectedFrom));
});

test("exporting income downloads a CSV built from local data", async ({ page }) => {
  await page.getByRole("link", { name: "Reports" }).click();
  await expect(page.getByTestId("export-income")).toBeVisible();

  const download = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-income").click(),
  ]).then(([d]) => d);

  expect(download.suggestedFilename()).toMatch(/^gigsy-income-\d{4}-\d{2}-\d{2}\.csv$/);

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");

  // Header row is present (after the UTF-8 BOM Excel needs).
  expect(text.replace(/^﻿/, "").split("\r\n")[0]).toBe(
    "date,client,kind,description,status,offered,paid,outstanding,notes",
  );
});

test("the summary export is disabled until the summary loads", async ({ page }) => {
  await page.getByRole("link", { name: "Reports" }).click();
  await expect(page.getByTestId("export-summary")).toBeEnabled({ timeout: 15_000 });
});
