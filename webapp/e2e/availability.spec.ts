import { test, expect, type Page } from "@playwright/test";
import { requireTestAuth } from "./helpers/test-auth.ts";

/**
 * The public availability page (Phase 12).
 *
 * Every other test in this suite runs as a signed-in user. These are
 * about someone who is not: an agency opening a link on a phone, with
 * no account and no session. The interesting assertions are therefore
 * made in a FRESH browser context — same browser, no cookies, no
 * IndexedDB, nothing carried over — because a page that only works
 * because the tab happened to be logged in would prove nothing.
 */

/**
 * Mint a link through the real Settings screen and return its URL.
 *
 * The token is revealed exactly once, at creation, so this is the only
 * place it can be captured — which is precisely the property being
 * exercised. "Create" and "Regenerate" are the same operation; which
 * one is on screen depends on whether a previous run left a link
 * behind on the shared dev user.
 */
async function mintLink(page: Page): Promise<string> {
  await page.goto("/settings");

  const create = page.getByTestId("availability-link-create");
  const regenerate = page.getByTestId("availability-link-regenerate");
  await expect(create.or(regenerate)).toBeVisible({ timeout: 15_000 });

  if (await create.isVisible()) await create.click();
  else await regenerate.click();

  const value = page.getByTestId("availability-link-value");
  await expect(value).toBeVisible({ timeout: 15_000 });
  const url = (await value.textContent())?.trim() ?? "";
  expect(url).toMatch(/\/a\/[A-Za-z0-9_-]{22}$/);
  return url;
}

test.beforeEach(async ({ page, request, baseURL }) => {
  await requireTestAuth(request, baseURL!);
  await page.goto("/login");
  await page.getByTestId("test-signin").click();
  await expect(page.getByTestId("tab-bar")).toBeVisible();
});

test("a dead link says so without hinting it was ever real", async ({ browser }) => {
  // Needs no setup and no session: this is what an agency sees after a
  // link is regenerated or turned off. Unknown, revoked and expired are
  // deliberately one message.
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();

  await anonPage.goto("/a/definitely-not-a-real-token");

  await expect(anonPage.getByTestId("availability-message")).toContainText(
    "isn't active",
  );
  await anon.close();
});

test("the link opens for someone with no account at all", async ({
  page,
  browser,
}) => {
  const url = await mintLink(page);

  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto(url);

  // No redirect to /login, no sign-in prompt — the token IS the access.
  await expect(anonPage.getByTestId("availability-title")).toBeVisible();
  await expect(anonPage).toHaveURL(/\/a\//);
  await expect(anonPage.getByTestId("availability-basis")).toBeVisible();
  await anon.close();
});

test("it never shows what fills the busy time", async ({ page, browser }) => {
  // The whole feature's promise, at the level a person can see: a gig
  // whose location is unmistakable, and a page that must not contain it.
  //
  // The gig needs a DATE and a confirmed status, or the projection
  // never looks at it and this passes for the wrong reason — a gig
  // that is not part of the computation proves nothing about what the
  // computation leaks. Three days out keeps it inside the horizon.
  const secret = `pier-39-secret-${Date.now()}`;
  const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  soon.setHours(11, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  // Date and time are two controls now — the time is a quarter-hour
  // <select>, because no native datetime picker can be held to the grid.
  // 11:00 above is already on it.
  const localDate = `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}`;
  const localTime = `${pad(soon.getHours())}:${pad(soon.getMinutes())}`;

  await page.getByRole("link", { name: "Gigs" }).click();
  await page.getByRole("link", { name: "Add gig" }).click();
  await page.getByLabel("Location").fill(secret);
  await page.getByLabel("Status").selectOption("confirmed");
  await page.getByTestId("gig-datetime-date").fill(localDate);
  await page.getByTestId("gig-datetime-time").selectOption(localTime);
  await page.getByTestId("gig-duration").selectOption("120");
  await page.getByLabel("Offered ($)").fill("2500");
  await page.getByRole("button", { name: "Save gig" }).click();

  // Wait for the save to actually land before anything that could
  // interrupt it: click() returns once the click is dispatched, and the
  // write is async. Reloading here without this cancels it mid-flight —
  // which silently produced a passing, meaningless test.
  await expect(page.getByText(secret)).toBeVisible({ timeout: 15_000 });

  // The page is computed server-side, so the gig has to arrive first.
  await expect(page.getByTestId("sync-pending")).toBeHidden({ timeout: 20_000 });
  await page.reload();
  // Proves the setup survived the round trip rather than silently
  // no-oping, which would make the assertion below meaningless.
  await expect(page.getByText(secret)).toBeVisible({ timeout: 15_000 });

  const url = await mintLink(page);
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto(url);
  await expect(anonPage.getByTestId("availability-title")).toBeVisible();

  const rendered = await anonPage.locator("body").innerText();
  expect(rendered).not.toContain(secret);
  // Nor the amount, in either of the ways it gets written.
  expect(rendered).not.toContain("2500");
  expect(rendered).not.toContain("$2,500");
  await anon.close();
});

test("crawlers are told to stay away", async ({ page, request }) => {
  // A shared link is not a published one. The header is what actually
  // binds a crawler; robots.txt only helps the ones that ask first.
  const url = await mintLink(page);
  const token = url.split("/a/")[1]!;

  const res = await request.get(`/api/a/${token}`);

  expect(res.status()).toBe(200);
  expect(res.headers()["x-robots-tag"]).toContain("noindex");
  expect(res.headers()["cache-control"]).toContain("no-store");
});

test("turning the link off stops it immediately", async ({ page, browser }) => {
  const url = await mintLink(page);

  await page.getByTestId("availability-link-revoke").click();
  await expect(page.getByTestId("availability-link-create")).toBeVisible({
    timeout: 15_000,
  });

  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto(url);

  await expect(anonPage.getByTestId("availability-message")).toContainText(
    "isn't active",
  );
  await anon.close();
});
