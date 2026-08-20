import { test, expect } from "@playwright/test";
import { requireTestAuth } from "./helpers/test-auth.ts";
import { dateTimeField } from "./helpers/datetime-field.ts";

// Signed-in flows via the test-auth bypass (POST /api/auth/test-login,
// which only exists outside production). Where it's disabled these
// skip, unless the job set E2E_REQUIRE_AUTH — see helpers/test-auth.ts.

test.beforeEach(async ({ page, request, baseURL }) => {
  await requireTestAuth(request, baseURL!);
  await page.goto("/login");
  await page.getByTestId("test-signin").click();
  await expect(page.getByTestId("tab-bar")).toBeVisible();
});

test("dev sign-in lands on the dashboard with navigation", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByTestId("tile-unpaid")).toBeVisible();
  // Calendar card renders in its disconnected state.
  await expect(page.getByTestId("calendar-section")).toContainText("Connect");
  await page.getByRole("link", { name: "Gigs" }).click();
  await expect(page.getByRole("heading", { name: "Gigs" })).toBeVisible();
  await page.getByRole("link", { name: "Clients" }).click();
  await expect(page.getByRole("heading", { name: "Clients" })).toBeVisible();
});

test("a completed unpaid gig with a service reaches the dashboard drill-down", async ({
  page,
}) => {
  const marker = `unpaid-booth-${Date.now()}`;

  // Create a completed gig: offered 200, paid 50. The status is not on
  // the job form any more — it is a fact about the work, so it lives on
  // the hub the save lands on.
  await page.getByRole("link", { name: "Gigs" }).click();
  await page.getByRole("link", { name: "Add gig" }).click();
  await page.getByLabel("Location").fill(marker);
  await page.getByLabel("Offered ($)").fill("200");
  await page.getByLabel("Paid ($)").fill("50");
  await page.getByRole("button", { name: "Save gig" }).click();

  await expect(page.getByTestId("gig-work-card")).toBeVisible({ timeout: 15_000 });
  await page.getByLabel("Status").selectOption("completed");
  // The pill is fed by the saved record, so waiting for it is waiting
  // for the write — the work card has no Save button to press.
  await expect(page.getByTestId("status-pill")).toHaveText("completed");

  // Add a service on it: offered 40, unpaid. That section is on this
  // screen now, not on the form.
  await page.getByRole("link", { name: "+ Add service" }).click();
  await page.getByLabel("Description").fill("Overtime hour");
  await page.getByLabel("Offered ($)").fill("40");
  await page.getByRole("button", { name: "Save service" }).click();
  await expect(page.getByText("Overtime hour")).toBeVisible();

  // Wait for the outbox to drain (badge clears) — the dashboard is
  // server-computed, so the data must be synced before it can show.
  await expect(page.getByTestId("sync-pending")).toBeHidden({ timeout: 15_000 });

  // Dashboard: the job shows in "waiting to be paid". Prior e2e runs
  // accumulate rows on the shared dev user — assert on the first
  // match rather than a unique one.
  await page.getByRole("link", { name: "Home" }).click();
  const row = page.getByTestId("unpaid-jobs").getByText("$190.00").first();
  await expect(row).toBeVisible({ timeout: 15_000 });
});

test("a gig created while offline shows up instantly and drains on reconnect", async ({
  page,
  context,
}) => {
  const marker = `offline-booth-${Date.now()}`;

  await page.getByRole("link", { name: "Gigs" }).click();
  await expect(page.getByRole("heading", { name: "Gigs" })).toBeVisible();

  await context.setOffline(true);

  await page.getByRole("link", { name: "Add gig" }).click();
  await page.getByLabel("Location").fill(marker);
  await page.getByRole("button", { name: "Save gig" }).click();
  // Saving opens the new gig's own screen; the list is one tap back.
  await expect(page.getByTestId("gig-work-card")).toBeVisible();
  await page.getByRole("link", { name: "Gigs" }).click();

  // Local-first: the gig is on the list with zero network, and the
  // header shows we're offline with unsynced work.
  await expect(page.getByText(marker)).toBeVisible();
  await expect(page.getByTestId("sync-offline")).toBeVisible();

  await context.setOffline(false);

  // Reconnect → the outbox drains → all badges clear, the gig stays.
  await expect(page.getByTestId("sync-offline")).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId("sync-pending")).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText(marker)).toBeVisible();
});

// Reopening the app when the server can't be reached used to hang on
// the startup screen (fetch has no default timeout) and then bounce to
// /login — even though the whole ledger is local and the session was
// still valid. These drive the API-unreachable path directly; a true
// offline reload also needs the service worker, which only exists in a
// production build.
test("reopening with the API unreachable lands in the app, not the login screen", async ({
  page,
  context,
}) => {
  await expect(page.getByTestId("tab-bar")).toBeVisible();

  await context.route("**/api/**", (route) => route.abort());
  await page.reload();

  await expect(page.getByTestId("tab-bar")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("link", { name: "Gigs" }).click();
  await expect(page.getByRole("heading", { name: "Gigs" })).toBeVisible();

  await context.unroute("**/api/**");
});

test("a hung refresh cannot freeze startup indefinitely", async ({ page, context }) => {
  await expect(page.getByTestId("tab-bar")).toBeVisible();

  // A connection that accepts but never answers — a phone waking onto
  // a captive-portal Wi-Fi. Without the abort timeout this never
  // resolves and the app sits on the splash forever.
  await context.route("**/api/auth/refresh", async () => {
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  });

  await page.reload();
  await expect(page.getByTestId("splash")).toBeVisible();
  await expect(page.getByTestId("splash-status")).toBeVisible();
  // Bounded by the 8s refresh timeout, not by the hung request.
  await expect(page.getByTestId("tab-bar")).toBeVisible({ timeout: 25_000 });

  await context.unroute("**/api/auth/refresh");
});

/**
 * Phase 9: a gig's own length (which the calendar then honours) and an
 * expense the client is expected to cover.
 *
 * This test used to save and read straight back, which proved only
 * that Dexie kept the value — and it passed happily for months while
 * neither field was reaching the server at all, because the outbox
 * payload omitted both. So each half now drains the outbox and
 * reloads, forcing the pull that overwrites the local copy with the
 * server's. That reload is the step that used to erase the evidence.
 */
test("a gig duration and a billable expense survive a server round-trip", async ({
  page,
}) => {
  const marker = `dur-booth-${Date.now()}`;

  await page.getByRole("link", { name: "Gigs" }).click();
  await page.getByRole("link", { name: "Add gig" }).click();
  await page.getByLabel("Location").fill(marker);
  // A non-round duration — 3h20m — is the entire point of replacing
  // the old fixed-length `<select>` with DurationField, so both halves
  // need to survive the round trip, not just the hours.
  await page.getByTestId("gig-duration-hours").fill("3");
  await page.getByTestId("gig-duration-minutes").fill("20");
  await page.getByRole("button", { name: "Save gig" }).click();

  // Let the save land first: click() returns once the click is
  // dispatched, so reloading straight after cancels the write.
  // The save lands on the gig's own screen, which states the plan.
  await expect(page.getByText(marker)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("job-when")).toContainText("3h 20m");
  await expect(page.getByTestId("sync-pending")).toBeHidden({ timeout: 20_000 });
  await page.reload();

  // Both halves, in the form the server's copy fills in.
  await page.getByTestId("gig-edit").click();
  await expect(page.getByTestId("gig-duration-hours")).toHaveValue("3");
  await expect(page.getByTestId("gig-duration-minutes")).toHaveValue("20");

  // …and an expense flagged as the client's to cover.
  await page.getByRole("link", { name: "Expenses" }).click();
  await page.getByRole("link", { name: "Add expense" }).click();
  await page.getByLabel("Amount ($)").fill("18.75");
  await page.getByLabel("Category").fill(marker);
  await page.getByTestId("expense-reimbursable").check();
  await page.getByRole("button", { name: "Save expense" }).click();

  await expect(page.getByText(marker).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("sync-pending")).toBeHidden({ timeout: 20_000 });
  await page.reload();

  await page.getByText(marker).first().click();
  await expect(page.getByTestId("expense-reimbursable")).toBeChecked();
});

// Editing a gig then reopening it used to show the pre-edit values:
// save invalidated the LIST query but not the single-gig one, and the
// 30s staleTime happily served the old copy.
test("reopening a just-edited gig shows the new values", async ({ page }) => {
  const marker = `stale-check-${Date.now()}`;

  await page.getByRole("link", { name: "Gigs" }).click();
  await page.getByRole("link", { name: "Add gig" }).click();
  await page.getByLabel("Location").fill(marker);
  await page.getByRole("button", { name: "Save gig" }).click();
  await expect(page.getByText(marker)).toBeVisible({ timeout: 15_000 });

  // Edit it: change the duration, save, reopen immediately. Both saves
  // land on the hub, so the form is one "Edit" away each time.
  await page.getByTestId("gig-edit").click();
  await page.getByTestId("gig-duration-hours").fill("5");
  await page.getByRole("button", { name: "Save gig" }).click();
  await expect(page.getByTestId("job-when")).toBeVisible({ timeout: 15_000 });

  await page.getByTestId("gig-edit").click();
  await expect(page.getByTestId("gig-duration-hours")).toHaveValue("5");
});

/**
 * A gig's optional title, proven past Dexie. The same trap as the
 * duration: saving and reading straight back only shows the local copy
 * kept it, so this drains the outbox and reloads, forcing the pull that
 * replaces the local gig with the server's.
 *
 * The list assertion here is only that the gig survived the round-trip;
 * that the heading is the title is covered by gig-list.spec.ts.
 */
test("a gig title survives a server round-trip", async ({ page }) => {
  const marker = `title-booth-${Date.now()}`;
  const title = `Costco tasting ${Date.now()}`;

  await page.getByRole("link", { name: "Gigs" }).click();
  await page.getByRole("link", { name: "Add gig" }).click();
  await page.getByLabel("Location").fill(marker);
  await page.getByTestId("gig-title").fill(title);
  await page.getByRole("button", { name: "Save gig" }).click();

  // Let the save land before reloading — click() returns on dispatch.
  await expect(page.getByText(marker)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("sync-pending")).toBeHidden({ timeout: 20_000 });
  await page.reload();

  // The list is now populated from the server copy.
  await page.getByRole("link", { name: "Gigs" }).click();
  await expect(page.getByText(marker)).toBeVisible({ timeout: 15_000 });
  await page.getByText(marker).click();
  await page.getByTestId("gig-edit").click();
  await expect(page.getByTestId("gig-title")).toHaveValue(title);
});

/**
 * A gig time survives the round trip to the server.
 *
 * That every minute is enterable is asserted in gig-list.spec.ts against
 * the control itself. This is the other half: that a day off a calendar
 * and an hour off a time box compose into one stored moment, and come
 * back as the same one.
 *
 * The version before this asserted `step="900"` on a `datetime-local`
 * input, which was never a constraint on any platform and was ignored
 * outright by iOS.
 */
test("a gig date and time are stored together and come back", async ({
  page,
}) => {
  await page.getByRole("link", { name: "Gigs" }).click();
  await page.getByRole("link", { name: "Add gig" }).click();

  const marker = `gig-time-${Date.now()}`;
  await page.getByLabel("Location").fill(marker);
  await dateTimeField(page, "gig-datetime").set("2027-03-04", "10:45");
  await page.getByRole("button", { name: "Save gig" }).click();
  await expect(page.getByText(marker)).toBeVisible({ timeout: 15_000 });

  // The hub states the same moment in canonical form — what the row
  // READS is localised, so `data-value` is what a spec can assert on.
  await expect(page.getByTestId("job-when")).toHaveAttribute(
    "data-value",
    "2027-03-04T10:45",
  );

  // Reopened from storage, not from the form state left behind.
  await page.getByTestId("gig-edit").click();
  await dateTimeField(page, "gig-datetime").expectValue("2027-03-04T10:45");
});

/**
 * A payment's date survives the round trip.
 *
 * `payment-paid-at` is the one site whose control changed TYPE rather
 * than shape — it was a bare `<input type="datetime-local">`, the app's
 * second answer to a question the gig form already answered, and it had
 * no coverage at any level before this. Now it is the same popover, so
 * the same driver reaches it.
 */
test("a payment date is stored and comes back", async ({ page }) => {
  await page.goto("/payments/new");
  await page.getByTestId("payment-amount").fill("125.50");
  await dateTimeField(page, "payment-paid-at").set("2027-03-04", "10:45");
  await page.getByTestId("payment-save").click();

  // Saving a new payment replaces the URL with the record's own id.
  await expect(page).toHaveURL(/\/payments\/(?!new$)[\w-]+/, { timeout: 15_000 });

  // Reopened from storage, not from the form state left behind.
  await page.reload();
  await dateTimeField(page, "payment-paid-at").expectValue("2027-03-04T10:45");
  await expect(page.getByTestId("payment-amount")).toHaveValue("125.50");
});

/**
 * The dot has to be on the RIGHT row. An earlier version of this test
 * asserted only that some dot existed somewhere on the list, which is
 * why it stayed green while the query cached the pending id set under
 * the pending COUNT: after a drain, a second offline edit reused the
 * id set from the first one and marked a gig that had already synced.
 * Hence the second half — two rows, two counts of 1, different gigs.
 */
test("a gig with unsent changes is marked, and the mark clears on sync", async ({
  page,
  context,
}) => {
  const first = `dot-check-a-${Date.now()}`;
  const second = `dot-check-b-${Date.now()}`;
  const rowFor = (marker: string) => page.locator("a", { hasText: marker });

  await page.getByRole("link", { name: "Gigs" }).click();
  await context.setOffline(true);
  await page.getByRole("link", { name: "Add gig" }).click();
  await page.getByLabel("Location").fill(first);
  await page.getByRole("button", { name: "Save gig" }).click();
  // The save opens the gig itself; the dot being tested is a list mark.
  await page.getByRole("link", { name: "Gigs" }).click();

  await expect(page.getByText(first)).toBeVisible();
  await expect(rowFor(first).getByTestId("gig-unsynced")).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByTestId("sync-pending")).toBeHidden({ timeout: 20_000 });
  await expect(page.getByTestId("gig-unsynced")).toHaveCount(0, {
    timeout: 20_000,
  });

  // Second offline edit, different gig, same pending count as before.
  await context.setOffline(true);
  await page.getByRole("link", { name: "Add gig" }).click();
  await page.getByLabel("Location").fill(second);
  await page.getByRole("button", { name: "Save gig" }).click();
  await page.getByRole("link", { name: "Gigs" }).click();

  await expect(page.getByText(second)).toBeVisible();
  await expect(rowFor(second).getByTestId("gig-unsynced")).toBeVisible();
  await expect(rowFor(first).getByTestId("gig-unsynced")).toHaveCount(0);

  await context.setOffline(false);
  await expect(page.getByTestId("sync-pending")).toBeHidden({ timeout: 20_000 });
  await expect(page.getByTestId("gig-unsynced")).toHaveCount(0, {
    timeout: 20_000,
  });
});

// 09:00 to 12:18 is 198 minutes; an 18-minute break leaves 180 worked,
// which at $50/h is $150.00 — proves the whole chain (lib/gig-pay.ts's
// workedMinutes → expectedCents) reaches the screen, not just the model.
//
// The work log lives on the gig's own screen since the Phase 3 split,
// so this creates the gig first and records against it — which is also
// the real sequence: nobody logs a shift they have not been booked for.
test("an hourly gig prices itself from the time worked", async ({ page }) => {
  await page.goto("/gigs/new");
  await page.getByTestId("gig-pay-type").selectOption("hourly");
  await page.getByTestId("gig-rate").fill("50");
  await page.getByTestId("gig-save").click();

  await expect(page.getByTestId("gig-work-card")).toBeVisible({ timeout: 15_000 });
  await dateTimeField(page, "gig-work-start").set("2027-03-04", "09:00");
  await dateTimeField(page, "gig-work-end").set("2027-03-04", "12:18");
  await page.getByTestId("gig-break").fill("18");
  // Committed on blur — the card saves as you go and has no button.
  await page.getByTestId("gig-break").blur();
  await expect(page.getByTestId("gig-expected-pay")).toContainText("$150.00");
});

/**
 * The whole point of the phase: recording what happened cannot move
 * what was planned.
 *
 * The two assertions on `job-when` either side of Start/Stop are what
 * would catch a work control writing into `dateTime` — the fault the
 * old single form made possible.
 */
test("recording work never touches the planned time", async ({ page }) => {
  await page.goto("/gigs/new");
  await page.getByTestId("gig-pay-type").selectOption("hourly");
  await page.getByTestId("gig-rate").fill("50");
  await dateTimeField(page, "gig-datetime").set("2027-03-04", "09:00");
  await page.getByTestId("gig-duration-hours").fill("3");
  await page.getByTestId("gig-save").click();

  // Saving lands on the detail hub, not the list.
  await expect(page.getByTestId("gig-work-card")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("job-when")).toHaveAttribute(
    "data-value",
    "2027-03-04T09:00",
  );

  // Start stamps the current minute…
  await page.getByTestId("work-start").click();
  await expect(page.getByTestId("gig-work-start")).not.toHaveAttribute(
    "data-value",
    "",
  );

  // …then the stamp is corrected backwards, which is what the field
  // under the button is for. Stop below then closes a real span:
  // stopping in the same minute you started is a zero-length shift and
  // the card refuses it, exactly as the write schema does.
  const started = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  await dateTimeField(page, "gig-work-start").set(
    `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())}`,
    `${pad(started.getHours())}:${pad(started.getMinutes())}`,
  );
  await page.getByTestId("work-stop").click();

  // The plan is untouched; the actuals now exist and are priced.
  await expect(page.getByTestId("job-when")).toHaveAttribute(
    "data-value",
    "2027-03-04T09:00",
  );
  await expect(page.getByTestId("gig-expected-pay")).toContainText("$");

  // …and the override, which is the only way to reach amountOfferedCents
  // on an hourly gig (Phase 3 Task 4b).
  await page.getByTestId("gig-override").fill("189.17");
  await page.getByTestId("gig-override").blur();
  await expect(page.getByTestId("gig-expected-pay")).toContainText("$189.17");
  await page.getByTestId("gig-override-clear").click();
  await expect(page.getByTestId("gig-expected-pay")).not.toContainText("$189.17");
});

// A zero rate parses fine (parseMoney("0") === 0) but must still be
// refused: saved as-is it fails the backend's positiveCents check later
// and sync-engine.ts drops the whole op, silently losing the edit.
test("an hourly gig with a zero rate is refused, not silently saved", async ({
  page,
}) => {
  await page.goto("/gigs/new");
  await page.getByTestId("gig-pay-type").selectOption("hourly");
  await page.getByTestId("gig-rate").fill("0");
  await page.getByRole("button", { name: "Save gig" }).click();
  await expect(
    page.getByText("The hourly rate must be greater than zero."),
  ).toBeVisible();
  // The save never fired — still on the form, rate field untouched.
  await expect(page.getByTestId("gig-rate")).toHaveValue("0");
});
