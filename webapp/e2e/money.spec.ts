import {
  test,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  devAccessToken,
  requireTestAuth,
  resetGigListView,
} from "./helpers/test-auth.ts";
import { dateTimeField } from "./helpers/datetime-field.ts";

/**
 * What a gig is worth, everywhere it is stated.
 *
 * Every defect this file exists for had the same shape: the figure was
 * right on the screen you typed it into and wrong everywhere else.
 *
 *   - An hourly gig priced itself correctly on the work card and
 *     contributed NOTHING to any total, because the aggregates summed
 *     `amount_offered_cents` — which on an hourly gig is only an
 *     optional override, so a rated shift counted as zero (migration
 *     0014 and the `expected_cents` column are the fix).
 *   - A cancelled gig is supposed to leave the money while its record
 *     survives.
 *   - Paid-ness stopped being a status somebody set (migration 0015)
 *     and became a fact derived from the money, which means it has to
 *     appear and disappear on its own.
 *
 * So nothing here asserts on the form that owns the number. Each test
 * types a figure in one place and reads it back in another.
 *
 * DELTAS, not absolutes. The dev user is shared and every prior run
 * leaves gigs behind, so no total on this screen has a knowable value
 * — but the CHANGE one gig makes to it does. The baseline comes from
 * the API rather than from the tile, because the tile is the thing
 * under test and cannot also be the reference.
 */

/** "$1,234.56" → 123456. Null while the tile has not rendered yet, so
 *  `expect.poll` retries rather than throwing on the first pass. */
function moneyToCents(text: string | null): number | null {
  if (text === null) return null;
  const match = /-?[\d,]+\.\d{2}/.exec(text);
  if (match === null) return null;
  return Math.round(Number(match[0].replace(/,/g, "")) * 100);
}

/**
 * The server's own answer for "expected", unwindowed.
 *
 * `/api/reports/dashboard` with no bounds is exactly what the "All
 * open" option asks for, so this and the tile are answering the same
 * question — the only difference is that this one cannot be served
 * from a stale query cache.
 */
async function serverExpectedCents(
  request: APIRequestContext,
  baseURL: string,
  token: string,
): Promise<number> {
  const res = await request.get(`${baseURL}/api/reports/dashboard`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { expectedCents: number }).expectedCents;
}

/**
 * Wait for the dashboard's "Expected" tile to reach `cents`.
 *
 * Always from a fresh mount with "All open" chosen: the window is
 * component state, so navigating here resets it to 90 days, and a
 * dateless gig would fall outside that window and prove nothing.
 *
 * A document load rather than a tap on Home, for the same reason
 * `gigRow` below does one: React Query holds every answer for 30
 * seconds (main.tsx's staleTime), so an in-app navigation can re-mount
 * this screen and re-render the tile from the reply that arrived
 * before the gig existed. A new document has an empty cache and has to
 * ask.
 */
async function expectDashboardExpected(page: Page, cents: number): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("dashboard-window")).toBeVisible();
  await page.getByTestId("dashboard-window").selectOption("all");
  await expect(page.getByTestId("tile-expected")).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(async () => moneyToCents(await page.getByTestId("tile-expected").textContent()), {
      timeout: 30_000,
      message: `the dashboard's Expected tile never reached ${cents} cents`,
    })
    .toBe(cents);
}

/**
 * The one row for `marker`, found by narrowing the list rather than by
 * hunting through everything prior runs left behind.
 *
 * Opened as a DOCUMENT, not by tapping the Gigs tab. Two of the
 * figures this file reads off a row — a gig's `amountPaidCents` and
 * its `expectedCents` column — are the server's, and they arrive on a
 * pull that writes into Dexie and tells React Query nothing
 * (lib/sync-engine.ts). Within the 30-second staleTime an in-app
 * navigation therefore re-renders the row from the copy this tab
 * already had; only a fresh mount re-reads the store.
 */
async function gigRow(page: Page, marker: string): Promise<Locator> {
  await page.goto("/gigs");
  await expect(page.getByRole("heading", { name: "Gigs" })).toBeVisible();
  await page.getByTestId("gig-search").fill(marker);
  await expect(page.getByTestId("gig-filter-count")).toHaveText(/Showing 1 of \d+/);
  return page.getByTestId("gig-list").getByRole("link").first();
}

/**
 * Re-open the row until `check` passes.
 *
 * Even a fresh mount can be a moment early: the pull runs AFTER the
 * drain that clears the pending badge (syncNow in lib/sync-engine.ts
 * does both, in that order), so waiting for the badge to clear only
 * proves the write went up, not that its consequences came back.
 *
 * `check` must lead with something that is only true once they have —
 * a figure that changes, not an absence. An assertion that the paid
 * badge is missing passes on the first, ignorant render just as
 * happily as on the informed one.
 */
async function rowEventually(
  page: Page,
  marker: string,
  check: (row: Locator) => Promise<void>,
): Promise<void> {
  await expect(async () => {
    await check(await gigRow(page, marker));
  }).toPass({ timeout: 45_000 });
}

/**
 * Record money against the gig whose hub is open, the only way there
 * is to record any.
 *
 * "+ Add payment" opens `/payments/new?gigId=<this gig>`, so the
 * Related gig select arrives already on it. The save queues TWO ops:
 * the payment, and the `payment_allocations` row that says which gig
 * it paid for — written by the client now (lib/local-store.ts's
 * `putPayment`), not inferred by the server from a `gigId` on the
 * payment, which this build no longer sends. The server sums those
 * allocations back into the gig's derived `amountPaidCents`. That last
 * step is on the server, which is why this waits for the outbox to
 * drain before returning — and why nothing it does can be asserted
 * until a pull has been round the loop as well.
 *
 * There is no shortcut, and that is the point: the "Paid ($)" box this
 * spec used to type into was removed with the column it could not
 * write (GigEdit.tsx).
 */
async function recordPayment(page: Page, dollars: string): Promise<void> {
  await page.getByTestId("gig-add-payment").click();
  await page.getByTestId("payment-amount").fill(dollars);
  await expect(page.getByTestId("payment-gig")).not.toHaveValue("");
  await page.getByTestId("payment-save").click();
  // Saving a new payment replaces the URL with the record's own id.
  await expect(page).toHaveURL(/\/payments\/(?!new$)[\w-]+/, { timeout: 15_000 });
  await page.getByTestId("payment-open-gig").click();
  await expect(page.getByTestId("gig-work-card")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("sync-pending")).toBeHidden({ timeout: 20_000 });
}

test.beforeEach(async ({ page, request, baseURL }) => {
  await requireTestAuth(request, baseURL!);
  // Every test here narrows the list by typing in the search box, and a
  // status filter left behind by another spec would hide the row it is
  // looking for. Same reason gig-list.spec.ts does this.
  await resetGigListView(request, baseURL!);
  await page.goto("/login");
  await page.getByTestId("test-signin").click();
  await expect(page.getByTestId("tab-bar")).toBeVisible();
});

test.afterEach(async ({ request, baseURL }) => {
  await resetGigListView(request, baseURL!);
});

/**
 * An hourly gig is worth something to the TOTALS, not only to itself.
 *
 * 09:00 to 12:18 less an 18-minute break is 180 minutes, which at $50/h
 * is $150.00. The work card stating that was never the broken part —
 * e2e/signed-in.spec.ts already pins it. What broke is everything
 * downstream: the dashboard summed a column an hourly gig leaves null,
 * so this gig moved the "Expected" tile by exactly nothing, and the
 * list row showed no figure at all.
 *
 * The gig is left as a lead with no planned date on purpose. "All open"
 * drops the date bounds, so the only thing that can put $150 into the
 * total is the work log — there is no fee, and no plan to price.
 */
test("an hourly gig's earnings reach the dashboard total and its list row", async ({
  page,
  request,
  baseURL,
}) => {
  const token = await devAccessToken(request, baseURL!);
  const before = await serverExpectedCents(request, baseURL!, token);
  const marker = `hourly-total-${Date.now()}`;

  await page.getByRole("link", { name: "Gigs" }).click();
  await page.getByRole("link", { name: "Add gig" }).click();
  await page.getByTestId("gig-title").fill(marker);
  await page.getByTestId("gig-pay-type").selectOption("hourly");
  await page.getByTestId("gig-rate").fill("50");
  await page.getByTestId("gig-save").click();

  await expect(page.getByTestId("gig-work-card")).toBeVisible({ timeout: 15_000 });
  await dateTimeField(page, "gig-work-start").set("2027-03-04", "09:00");
  await dateTimeField(page, "gig-work-end").set("2027-03-04", "12:18");
  // Typed only once the previous write's receipt is on screen: the card
  // re-seeds its draft from the record whenever that record changes (a
  // documented trade in WorkCard.tsx), so a break typed while a save is
  // still in flight is replaced when the saved copy comes back.
  await expect(page.getByTestId("work-save-state")).toContainText(/Saved at/);
  await page.getByTestId("gig-break").fill("18");
  await page.getByTestId("gig-break").blur();
  await expect(page.getByTestId("gig-expected-pay")).toContainText("$150.00");

  // The totals are server-computed, so the work log has to arrive
  // before anything downstream can count it.
  await expect(page.getByTestId("sync-pending")).toBeHidden({ timeout: 20_000 });

  await expectDashboardExpected(page, before + 15_000);

  // …and on the row, which reads the same derived figure. Scoped to the
  // row and matched exactly: an unscoped `$150.00` would happily find
  // some other gig from some other run.
  const row = await gigRow(page, marker);
  await expect(row.getByText("$150.00", { exact: true })).toBeVisible();
});

/**
 * Cancelling is not deleting.
 *
 * A gig that fell through stops being money — it leaves the dashboard,
 * the reports and the availability projection (see availability.spec.ts
 * for that half) — but the record stays, because "we did not do this
 * job" is something the user may want to look at later.
 *
 * Both halves are asserted here, and the second is what stops the first
 * from passing for the wrong reason: a gig deleted outright would also
 * take its money off the tile.
 */
test("a cancelled gig leaves the money behind but keeps its record", async ({
  page,
  request,
  baseURL,
}) => {
  const token = await devAccessToken(request, baseURL!);
  const before = await serverExpectedCents(request, baseURL!, token);
  const marker = `cancel-money-${Date.now()}`;

  await page.getByRole("link", { name: "Gigs" }).click();
  await page.getByRole("link", { name: "Add gig" }).click();
  await page.getByTestId("gig-title").fill(marker);
  await page.getByTestId("gig-offered").fill("300");
  await page.getByTestId("gig-save").click();

  await expect(page.getByTestId("gig-work-card")).toBeVisible({ timeout: 15_000 });
  const gigUrl = page.url();
  await expect(page.getByTestId("sync-pending")).toBeHidden({ timeout: 20_000 });

  // It counts while it is still a live lead…
  await expectDashboardExpected(page, before + 30_000);

  await page.goto(gigUrl);
  await page.getByLabel("Status").selectOption("cancelled");
  await expect(page.getByTestId("status-pill")).toHaveText("cancelled");
  await expect(page.getByTestId("sync-pending")).toBeHidden({ timeout: 20_000 });

  // …and stops the moment it falls through.
  await expectDashboardExpected(page, before);

  // The record survives, still saying what happened to it.
  const row = await gigRow(page, marker);
  await expect(row.getByTestId("status-pill")).toHaveText("cancelled");
});

/**
 * The paid badge is a conclusion, not a setting.
 *
 * `paid` used to be a gig status somebody chose, sitting beside a
 * payment record that said the same thing independently — and the two
 * could disagree. Migration 0015 removed it: a gig is paid when what
 * has landed covers what is expected (lib/gig-pay.ts's `isPaid`), and
 * nothing anywhere sets that.
 *
 * So the same gig is asserted twice, with only the money changed
 * between them. A badge driven by the status would be wrong both times
 * — absent after the balance lands, or present from the moment the gig
 * was marked completed.
 *
 * The money is moved the way the app moves money: two payments, each
 * recorded against the gig, summed into `gigs.amount_paid_cents` by
 * the server (migration 0016, services/paid-totals.ts). Two rather
 * than one for the total, because a badge is a claim about an
 * ACCUMULATION — a gig settled by a deposit and a balance is the
 * ordinary case, and "the last payment covered it" is a different and
 * weaker rule than "everything that landed covers it".
 *
 * This test used to type both figures into a "Paid ($)" box on the job
 * form. That box is gone, and while it existed it was writing a column
 * nobody read — which is the same defect, one layer down.
 */
test("the paid badge follows the money, not the status", async ({ page }) => {
  const marker = `paid-badge-${Date.now()}`;

  await page.goto("/gigs/new");
  await page.getByTestId("gig-title").fill(marker);
  await page.getByTestId("gig-offered").fill("200");
  await page.getByTestId("gig-save").click();

  await expect(page.getByTestId("gig-work-card")).toBeVisible({ timeout: 15_000 });
  const gigUrl = page.url();
  await page.getByLabel("Status").selectOption("completed");
  await expect(page.getByTestId("status-pill")).toHaveText("completed");
  await expect(page.getByTestId("sync-pending")).toBeHidden({ timeout: 20_000 });

  // ── A deposit: $50 of $200 ──
  await recordPayment(page, "50");

  // The row's figure is what proves the DERIVED total came back. It
  // reads `amountPaidCents` when there is one and the expected pay
  // otherwise (screens/Gigs.tsx), so $50.00 standing where $200.00 was
  // is the server's allocation sum arriving — and the badge assertion
  // beside it is then about a screen that has heard about the payment,
  // rather than about one that has not.
  await rowEventually(page, marker, async (row) => {
    await expect(row.getByText("$50.00", { exact: true })).toBeVisible();
    // Completed, and emphatically not settled. Asserted with the
    // lifecycle pill present, so this cannot pass because the badge
    // pair failed to render at all.
    await expect(row.getByTestId("status-pill")).toHaveText("completed");
    await expect(row.getByTestId("paid-badge")).toHaveCount(0);
  });

  // Same store, same moment, on the gig's own screen.
  await page.goto(gigUrl);
  await expect(page.getByTestId("status-pill")).toHaveText("completed");
  await expect(page.getByTestId("paid-badge")).toHaveCount(0);

  // ── The balance: $150 more, and nothing about the WORK changed ──
  await recordPayment(page, "150");

  await rowEventually(page, marker, async (row) => {
    await expect(row.getByTestId("paid-badge")).toBeVisible();
    await expect(row.getByTestId("status-pill")).toHaveText("completed");
    // $50 + $150, added up by the server rather than replaced by the
    // later payment.
    await expect(row.getByText("$200.00", { exact: true })).toBeVisible();
  });

  await page.goto(gigUrl);
  await expect(page.getByTestId("status-pill")).toHaveText("completed");
  await expect(page.getByTestId("paid-badge")).toBeVisible();

  // And an edit that has nothing to do with the money cannot take it
  // away. The job form does not render the paid total and cannot write
  // it, but it does REPLACE the gig (lib/gig-input.ts) — so a save
  // rebuilt from the form alone would blank a figure only the server
  // is allowed to state.
  await page.getByTestId("gig-edit").click();
  await page.getByTestId("gig-location").fill(`${marker}-moved`);
  await page.getByTestId("gig-save").click();
  await expect(page.getByTestId("gig-work-card")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("sync-pending")).toBeHidden({ timeout: 20_000 });
  await page.goto(gigUrl);
  await expect(page.getByTestId("paid-badge")).toBeVisible();
});

/**
 * A gig nobody can price is not a gig that pays nothing.
 *
 * `expectedCents` returns NULL, not zero, when an hourly gig has
 * nothing to multiply — no rate, or no time to charge for
 * (lib/gig-pay.ts). Everything downstream has to carry that
 * distinction rather than flatten it:
 *
 *   - `outstandingCents` is null, so `isPaid` is FALSE however much
 *     money has landed. Zero-instead-of-null would make an unpriced
 *     gig with a single payment against it "paid" — the app quietly
 *     agreeing that a job whose value it does not know is settled.
 *   - The work card renders no pay line at all rather than "$0.00",
 *     and the list row shows no figure. A gig that reads $0.00 is a
 *     gig that earns nothing, which is a different and wrong claim.
 *   - The dashboard's Expected total is unmoved. A null column sums as
 *     nothing (COALESCE in services/dashboard.ts) — the honest answer
 *     while the figure is unknown, and the one that must not be
 *     confused with the gig having been dropped.
 *
 * The rate itself cannot be the missing half here: zero and blank are
 * both refused before a gig exists — by GigEdit's `submit`, and again
 * by the backend, whose GigInput requires a rate on an hourly gig
 * (domain/schemas.ts) and refuses a non-positive one. That refusal has
 * its own test in signed-in.spec.ts. What is left, and is perfectly
 * ordinary, is the gig booked at a rate before anyone knows how long
 * it runs: rated, unpriced, and unpayable until it is worked.
 *
 * The last act is what stops the first assertions from passing for the
 * wrong reason. Once the shift is recorded the same gig prices itself,
 * the same money settles it, and the badge appears — so the nulls
 * above were "not yet known", not "nothing here".
 */
test("an hourly gig with nothing to price shows no figure and cannot be settled", async ({
  page,
  request,
  baseURL,
}) => {
  const token = await devAccessToken(request, baseURL!);
  const before = await serverExpectedCents(request, baseURL!, token);
  const marker = `unpriced-${Date.now()}`;

  // Rated, but with no planned length and no work logged — so there is
  // a rate and nothing for it to multiply.
  await page.goto("/gigs/new");
  await page.getByTestId("gig-title").fill(marker);
  await page.getByTestId("gig-pay-type").selectOption("hourly");
  await page.getByTestId("gig-rate").fill("50");
  await page.getByTestId("gig-save").click();

  await expect(page.getByTestId("gig-work-card")).toBeVisible({ timeout: 15_000 });
  const gigUrl = page.url();
  // No pay line — not a zero one. The card only renders the figure
  // when there is one to render, so its absence beside a visible card
  // is the assertion.
  await expect(page.getByTestId("gig-expected-pay")).toHaveCount(0);
  await expect(page.getByTestId("paid-badge")).toHaveCount(0);
  await expect(page.getByTestId("sync-pending")).toBeHidden({ timeout: 20_000 });

  // Nothing to add up, so the total does not move — while the gig is
  // demonstrably there, on its own row, saying no amount at all.
  await expectDashboardExpected(page, before);
  await rowEventually(page, marker, async (row) => {
    await expect(row.getByTestId("status-pill")).toHaveText("lead");
    await expect(row.getByText(/\$/)).toHaveCount(0);
  });

  // ── Money lands anyway, and settles nothing ──
  // $150 against a gig whose worth is unknown. `isPaid` says no,
  // because "what should this earn?" has no answer yet — and it is
  // exactly here that treating the unknown as zero would put a paid
  // badge on a gig nobody has priced.
  await page.goto(gigUrl);
  await recordPayment(page, "150");

  await rowEventually(page, marker, async (row) => {
    // The payment did reach the row — this is the same witness the
    // badge test uses, and it is what makes the absence below mean
    // something.
    await expect(row.getByText("$150.00", { exact: true })).toBeVisible();
    await expect(row.getByTestId("paid-badge")).toHaveCount(0);
  });
  await page.goto(gigUrl);
  await expect(page.getByTestId("gig-work-card")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("paid-badge")).toHaveCount(0);

  // ── The shift is worked, and everything resolves ──
  // 09:00 to 12:00 at $50/h is $150.00: the figure exists now, the
  // money already there covers it, and the badge follows.
  await dateTimeField(page, "gig-work-start").set("2027-06-09", "09:00");
  await dateTimeField(page, "gig-work-end").set("2027-06-09", "12:00");
  await expect(page.getByTestId("gig-expected-pay")).toContainText("$150.00");
  await expect(page.getByTestId("sync-pending")).toBeHidden({ timeout: 20_000 });

  await rowEventually(page, marker, async (row) => {
    await expect(row.getByTestId("paid-badge")).toBeVisible();
  });
  await page.goto(gigUrl);
  await expect(page.getByTestId("paid-badge")).toBeVisible();

  // …and the total it contributed nothing to now takes the real
  // figure, which is what says the earlier zero was ignorance rather
  // than a lost gig.
  await expectDashboardExpected(page, before + 15_000);
});
