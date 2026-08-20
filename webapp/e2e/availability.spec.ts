import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { devAccessToken, requireTestAuth } from "./helpers/test-auth.ts";
import { dateTimeField } from "./helpers/datetime-field.ts";

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
  // One control: a calendar in a popover with a time box under it. The
  // time box is a native <input type="time">, so any minute goes in.
  const localDate = `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}`;
  const localTime = `${pad(soon.getHours())}:${pad(soon.getMinutes())}`;

  await page.getByRole("link", { name: "Gigs" }).click();
  await page.getByRole("link", { name: "Add gig" }).click();
  await page.getByLabel("Location").fill(secret);
  await dateTimeField(page, "gig-datetime").set(localDate, localTime);
  await page.getByTestId("gig-duration-hours").fill("2");
  await page.getByLabel("Offered ($)").fill("2500");
  await page.getByRole("button", { name: "Save gig" }).click();

  // The status is a fact about the work, so it is set on the gig's own
  // screen — which is where saving lands — rather than on the job form.
  // The pill is fed by the saved record, so waiting for it is waiting
  // for the write: the work card saves as you go and has no button.
  await expect(page.getByTestId("gig-work-card")).toBeVisible({ timeout: 15_000 });
  await page.getByLabel("Status").selectOption("confirmed");
  await expect(page.getByTestId("status-pill")).toHaveText("confirmed");

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

/* ── A cancelled gig gives its time back ─────────────────────────────
 *
 * `cancelled` is not a stage the work passes through — it is the job
 * falling over. The gig's record survives (see money.spec.ts for that
 * half, and for the money leaving the dashboard at the same moment),
 * but it stops occupying anything: `BUSY_STATUSES` in
 * backend/src/services/availability.ts is `confirmed | completed` and
 * deliberately not this.
 *
 * That rule is only visible from OUTSIDE. The owner's own list shows a
 * cancelled gig struck through; the agency reading the share link sees
 * free time or does not, and getting it wrong means the user turns
 * down work for a job that fell through weeks ago.
 *
 * Everything this reasons about is pinned rather than assumed. The
 * shared dev user's availability settings are whatever the last spec
 * or help scenario left behind, and a working week that shifted
 * underneath would turn this into a test that passes because the day
 * was never offered in the first place.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A gig as the server hands it back, in the fields a write has to
 *  send straight back unchanged. */
interface SeededGig {
  id: string;
  status: string;
  dateTime: number | null;
  durationMinutes: number | null;
  payType: "fixed" | "hourly";
  hourlyRateCents: number | null;
  amountOfferedCents: number | null;
  amountPaidCents: number | null;
  clientId: string | null;
  title: string | null;
  location: string | null;
  notes: string | null;
  workStartedAt: number | null;
  workEndedAt: number | null;
  breakMinutes: number | null;
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** Everything the projection depends on, set to the documented
 *  defaults so the arithmetic below is the arithmetic that runs. */
async function pinAvailabilitySettings(
  request: APIRequestContext,
  baseURL: string,
  token: string,
): Promise<void> {
  const nineToFive = { startMinute: 9 * 60, endMinute: 17 * 60 };
  const res = await request.patch(`${baseURL}/api/settings`, {
    headers: authHeaders(token),
    data: {
      availabilityTimeZone: "UTC",
      // Sunday first, matching Date#getDay.
      availabilityWorkingWeek: [
        null,
        nineToFive,
        nineToFive,
        nineToFive,
        nineToFive,
        nineToFive,
        null,
      ],
      availabilityHorizonWeeks: 4,
      availabilityMinSlotMinutes: 60,
      // Google's freebusy would otherwise put blocks in this window
      // that no amount of cancelling could remove.
      availabilityUseCalendar: false,
    },
  });
  expect(res.ok()).toBe(true);
}

/**
 * 09:00 UTC on a Wednesday, eight to fourteen days out.
 *
 * Comfortably inside the four-week horizon, never today (whose
 * remaining hours depend on when the suite runs), and always a working
 * day — the day has to be OFFERED before a gig taking it away proves
 * anything.
 */
function nextWednesdayAt9(now: number): number {
  const at = new Date(now + 8 * DAY_MS);
  at.setUTCHours(9, 0, 0, 0);
  while (at.getUTCDay() !== 3) at.setUTCDate(at.getUTCDate() + 1);
  return at.getTime();
}

/**
 * Cancel anything already holding the target day.
 *
 * A run that died between seeding and cancelling would leave a
 * confirmed gig sitting on that Wednesday forever, and every later run
 * would fail at the last assertion for a reason that has nothing to do
 * with the behaviour. Written as a full-record round trip because
 * `PUT /api/gigs/:id` REPLACES — sending `{status}` alone would blank
 * the rest of whatever it found.
 */
async function releaseDay(
  request: APIRequestContext,
  baseURL: string,
  token: string,
  dayStart: number,
): Promise<void> {
  const res = await request.get(`${baseURL}/api/gigs`, { headers: authHeaders(token) });
  expect(res.ok()).toBe(true);
  const { items } = (await res.json()) as { items: SeededGig[] };
  for (const gig of items) {
    const busy = gig.status === "confirmed" || gig.status === "completed";
    const onDay =
      gig.dateTime !== null &&
      gig.dateTime >= dayStart &&
      gig.dateTime < dayStart + DAY_MS;
    if (!busy || !onDay) continue;
    const put = await request.put(`${baseURL}/api/gigs/${gig.id}`, {
      headers: authHeaders(token),
      data: {
        clientId: gig.clientId,
        title: gig.title,
        status: "cancelled",
        location: gig.location,
        dateTime: gig.dateTime,
        durationMinutes: gig.durationMinutes,
        payType: gig.payType,
        hourlyRateCents: gig.hourlyRateCents,
        workStartedAt: gig.workStartedAt,
        workEndedAt: gig.workEndedAt,
        breakMinutes: gig.breakMinutes,
        amountOfferedCents: gig.amountOfferedCents,
        amountPaidCents: gig.amountPaidCents,
        notes: gig.notes,
      },
    });
    expect(put.ok()).toBe(true);
  }
}

test("cancelling a gig hands its time back to the public page", async ({
  page,
  browser,
  request,
  baseURL,
}) => {
  const token = await devAccessToken(request, baseURL!);
  await pinAvailabilitySettings(request, baseURL!, token);

  const start = nextWednesdayAt9(Date.now());
  const dayStart = start - 9 * HOUR_MS;
  // The owner's zone is UTC, pinned above, so the calendar date and the
  // instant agree — which is the whole reason `data-day-key` can be
  // read as a date at all.
  const dayKey = new Date(dayStart).toISOString().slice(0, 10);
  await releaseDay(request, baseURL!, token, dayStart);

  // 09:00 to 17:00 is the entire working day, so any free time left on
  // it is time this gig failed to block — no need to reason about
  // which fragment survived.
  const gigId = crypto.randomUUID();
  const shift = {
    title: `availability-cancel-${Date.now()}`,
    dateTime: start,
    durationMinutes: 8 * 60,
    payType: "fixed" as const,
    amountOfferedCents: 25_000,
  };
  const seed = await request.put(`${baseURL!}/api/gigs/${gigId}`, {
    headers: authHeaders(token),
    data: { ...shift, status: "confirmed" },
  });
  expect(seed.ok()).toBe(true);

  const url = await mintLink(page);
  const dayCard = (target: Page) => target.locator(`[data-day-key="${dayKey}"]`);

  const booked = await browser.newContext();
  const bookedPage = await booked.newPage();
  await bookedPage.goto(url);
  await expect(bookedPage.getByTestId("availability-title")).toBeVisible();
  // Other days ARE on the page, so the absence below is about this day
  // rather than about a list that never rendered.
  await expect(bookedPage.getByTestId("availability-day").first()).toBeVisible();
  await expect(dayCard(bookedPage)).toHaveCount(0);
  await booked.close();

  // The job falls through.
  const cancelled = await request.put(`${baseURL!}/api/gigs/${gigId}`, {
    headers: authHeaders(token),
    data: { ...shift, status: "cancelled" },
  });
  expect(cancelled.ok()).toBe(true);

  // A fresh context, not a reload: someone who has never opened this
  // link is the only reader the feature has.
  const freed = await browser.newContext();
  const freedPage = await freed.newPage();
  await freedPage.goto(url);
  await expect(freedPage.getByTestId("availability-title")).toBeVisible();
  await expect(dayCard(freedPage)).toHaveCount(1);
  // The whole working day, back in one piece.
  await expect(dayCard(freedPage).getByTestId("availability-slot")).toHaveCount(1);
  await freed.close();
});
