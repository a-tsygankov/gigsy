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

  // Create a completed gig: offered 200. The status is not on the job
  // form any more — it is a fact about the work, so it lives on the hub
  // the save lands on. Neither is what has been PAID: that is derived
  // server-side from payment allocations now, so the $50 below is
  // recorded as a real payment naming this gig rather than typed into a
  // box (there is no such box any more — see GigEdit.tsx).
  await page.getByRole("link", { name: "Gigs" }).click();
  await page.getByRole("link", { name: "Add gig" }).click();
  await page.getByLabel("Location").fill(marker);
  await page.getByLabel("Offered ($)").fill("200");
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
  // Scoped to the section AND to the row's link, not a bare getByText:
  // the section's own explanatory copy mentions "an overtime hour", so
  // an unscoped match either resolves two elements (a strict-mode
  // failure) or — worse, and this happened — matches the paragraph
  // before the services query resolves and asserts nothing at all.
  await expect(
    page.getByTestId("gig-services").getByRole("link", { name: /Overtime hour/ }),
  ).toBeVisible();

  // Record the $50 as money that actually arrived. "+ Add payment"
  // opens /payments/new?gigId=<this gig>, so the Related gig select is
  // already on this gig and the saved payment carries `gigId` — which
  // the server turns into a payment_allocations row (the legacy-gigId
  // compat path in services/sync.ts) and sums back into the gig's
  // derived amountPaidCents. That is the whole chain the $190.00
  // assertion below depends on; typing 50 into the old "Paid ($)" box
  // never touched any of it.
  await page.getByRole("link", { name: "+ Add payment" }).click();
  await page.getByTestId("payment-amount").fill("50");
  await expect(page.getByTestId("payment-gig")).not.toHaveValue("");
  await page.getByTestId("payment-save").click();
  // Saving a new payment replaces the URL with the record's own id.
  await expect(page).toHaveURL(/\/payments\/(?!new$)[\w-]+/, { timeout: 15_000 });
  await page.getByTestId("payment-open-gig").click();
  await expect(page.getByTestId("gig-work-card")).toBeVisible({ timeout: 15_000 });

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
 * EVERY field of a gig, written offline, read back off the server.
 *
 * The defect this exists for did not fail anything. Phase 9 added
 * `durationMinutes` to the local record and forgot it in the outbox
 * payload, so every gig saved for months reached the server without a
 * length and calendar sync drew them all at its four-hour fallback.
 * Dexie kept the value perfectly; a test that saved and read straight
 * back saw it and said nothing was wrong. `OutboxPayload` is
 * `Required<...>` and `gigToInput` returns `Required<Omit<GigInput,
 * "source">>` because of that (lib/gig-input.ts) — this is the same
 * guard at the other end of the wire, where a type cannot reach.
 *
 * Three things make it able to fail:
 *
 *   - OFFLINE. Every field has to go through the outbox rather than a
 *     live PUT, which is the path that dropped them.
 *   - A FRESH CONTEXT for the readback — new browser, empty IndexedDB,
 *     a sign-in of its own. Nothing survives from the tab that wrote
 *     the gig, so what is on screen came from the server or came from
 *     nowhere. A reload cannot say that: the local copy is still there
 *     and a pull that quietly no-ops leaves it looking right.
 *   - The WORK LOG among the fields, and a job-form edit afterwards.
 *     That form renders none of it, and a save that rebuilt the record
 *     from the form alone would erase a recorded shift silently.
 */
test("every field of a gig survives an offline save and a pull from the server", async ({
  page,
  context,
  browser,
}) => {
  const stamp = Date.now();
  const marker = `full-field-${stamp}`;
  const title = `Costco tasting ${stamp}`;
  const clientName = `Full Field Agency ${stamp}`;
  const notes = `Park behind the loading bay.\nAsk for Dana ${stamp}.`;

  // The client is made while still ONLINE, deliberately. A gig naming a
  // client the server has never seen is a 400, and sync-engine drops a
  // rejected op — a real hazard, but a different one from the field
  // completeness this test is about.
  await page.getByRole("link", { name: "Clients" }).click();
  await page.getByRole("link", { name: "Add client" }).click();
  await page.getByTestId("client-name").fill(clientName);
  await page.getByTestId("client-save").click();
  await expect(page.getByText(clientName).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("sync-pending")).toBeHidden({ timeout: 20_000 });

  await page.getByRole("link", { name: "Gigs" }).click();
  await page.getByRole("link", { name: "Add gig" }).click();

  // The calendar is a lazy chunk (components/DateTimeField.tsx), and
  // under `vite dev` there is no service worker to have precached it —
  // so opening the popover for the first time with the network cut
  // hangs on a module that will never arrive. The installed app does
  // not have that problem; the dev server does. Warming it here costs
  // one open and keeps the offline half honest, because what is being
  // proven is what the SAVE queues, and the save is still offline.
  const when = dateTimeField(page, "gig-datetime");
  await when.open();
  await when.close();

  await context.setOffline(true);

  await page.getByTestId("gig-title").fill(title);
  await page.getByTestId("gig-client").selectOption({ label: clientName });
  await when.set("2027-05-06", "08:15");
  // A non-round length — 4h05m — because the hours alone surviving is
  // exactly what the old fixed-length `<select>` could express and the
  // regression could hide behind.
  await page.getByTestId("gig-duration-hours").fill("4");
  await page.getByTestId("gig-duration-minutes").fill("5");
  await page.getByTestId("gig-location").fill(marker);
  await page.getByTestId("gig-pay-type").selectOption("hourly");
  await page.getByTestId("gig-rate").fill("42.50");
  await page.getByTestId("gig-paid").fill("10");
  await page.getByTestId("gig-notes").fill(notes);
  await page.getByTestId("gig-save").click();

  // The rest of the record lives on the hub, which is where the save
  // lands — and none of it is on the form above.
  await expect(page.getByTestId("gig-work-card")).toBeVisible();
  const gigPath = new URL(page.url()).pathname;
  await page.getByLabel("Status").selectOption("confirmed");
  await expect(page.getByTestId("status-pill")).toHaveText("confirmed");
  await dateTimeField(page, "gig-work-start").set("2027-05-06", "08:20");
  await dateTimeField(page, "gig-work-end").set("2027-05-06", "13:00");
  // Each of the two typed fields waits for the previous write's receipt
  // first. The card re-seeds its draft from the record whenever that
  // record changes (a documented trade in WorkCard.tsx), so text typed
  // while a save is still in flight is replaced when it lands.
  await expect(page.getByTestId("work-save-state")).toContainText(/Saved at/);
  await page.getByTestId("gig-break").fill("25");
  await page.getByTestId("gig-break").blur();
  // The override — the only way to reach `amountOfferedCents` on an
  // hourly gig, and the field a job-form save is most able to clobber.
  await expect(page.getByTestId("work-save-state")).toContainText(/Saved at/);
  await page.getByTestId("gig-override").fill("199.99");
  await page.getByTestId("gig-override").blur();
  await expect(page.getByTestId("gig-expected-pay")).toContainText("$199.99");

  // Nothing above touched the network. Now let it.
  await expect(page.getByTestId("sync-offline")).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByTestId("sync-offline")).toBeHidden({ timeout: 20_000 });
  await expect(page.getByTestId("sync-pending")).toBeHidden({ timeout: 20_000 });

  // ── The readback, with nothing carried over ──
  const fresh = await browser.newContext();
  const freshPage = await fresh.newPage();
  await freshPage.goto("/login");
  await freshPage.getByTestId("test-signin").click();
  await expect(freshPage.getByTestId("tab-bar")).toBeVisible();
  // Wait for the first pull to have brought the CLIENT down before
  // opening the gig. The gig's client row resolves an id against a
  // separate query with a 30s staleTime, so a screen that mounted
  // while that list was still empty shows no client name and does not
  // re-render when the pull lands — a failure about timing wearing the
  // costume of a lost field. Reloading is what re-reads the store.
  await expect(async () => {
    await freshPage.goto("/clients");
    await expect(freshPage.getByText(clientName)).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 40_000 });
  await freshPage.goto(gigPath);

  await expect(freshPage.getByTestId("gig-heading")).toHaveText(title, {
    timeout: 15_000,
  });
  await expect(freshPage.getByTestId("status-pill")).toHaveText("confirmed");
  await expect(freshPage.getByTestId("job-client")).toHaveText(clientName);
  await expect(freshPage.getByTestId("job-title")).toHaveText(title);
  await expect(freshPage.getByTestId("job-when")).toHaveAttribute(
    "data-value",
    "2027-05-06T08:15",
  );
  await expect(freshPage.getByTestId("job-when")).toContainText("4h 5m");
  await expect(freshPage.getByTestId("job-location")).toHaveText(marker);
  await expect(freshPage.getByTestId("job-pay")).toContainText("$42.50 / hour");
  await expect(freshPage.getByTestId("job-notes")).toContainText("loading bay");
  await expect(freshPage.getByTestId("job-notes")).toContainText(`Dana ${stamp}`);

  // The work log, which no form on the screen that was edited renders.
  await expect(freshPage.getByTestId("gig-work-start")).toHaveAttribute(
    "data-value",
    "2027-05-06T08:20",
  );
  await expect(freshPage.getByTestId("gig-work-end")).toHaveAttribute(
    "data-value",
    "2027-05-06T13:00",
  );
  await expect(freshPage.getByTestId("gig-break")).toHaveValue("25");
  await expect(freshPage.getByTestId("gig-override")).toHaveValue("199.99");
  await expect(freshPage.getByTestId("gig-expected-pay")).toContainText("$199.99");

  // And the two the job form owns but the hub does not state.
  await freshPage.getByTestId("gig-edit").click();
  await expect(freshPage.getByTestId("gig-rate")).toHaveValue("42.50");
  await expect(freshPage.getByTestId("gig-paid")).toHaveValue("10.00");
  await expect(freshPage.getByTestId("gig-duration-hours")).toHaveValue("4");
  await expect(freshPage.getByTestId("gig-duration-minutes")).toHaveValue("5");

  // ── A job edit must not take the work log with it ──
  // This form shows none of the four fields asserted again below, and
  // rebuilds the record on save. `commitGigPatch` merges over the
  // STORED gig for exactly this reason (lib/gig-write.ts).
  await freshPage.getByTestId("gig-location").fill(`${marker}-moved`);
  await freshPage.getByTestId("gig-save").click();
  await expect(freshPage.getByTestId("gig-work-card")).toBeVisible({ timeout: 15_000 });
  await expect(freshPage.getByTestId("sync-pending")).toBeHidden({ timeout: 20_000 });
  await freshPage.reload();

  await expect(freshPage.getByTestId("job-location")).toHaveText(`${marker}-moved`);
  await expect(freshPage.getByTestId("status-pill")).toHaveText("confirmed");
  await expect(freshPage.getByTestId("gig-work-start")).toHaveAttribute(
    "data-value",
    "2027-05-06T08:20",
  );
  await expect(freshPage.getByTestId("gig-work-end")).toHaveAttribute(
    "data-value",
    "2027-05-06T13:00",
  );
  await expect(freshPage.getByTestId("gig-break")).toHaveValue("25");
  await expect(freshPage.getByTestId("gig-override")).toHaveValue("199.99");
  await fresh.close();
});

/**
 * Phase 9's other half: an expense the client is expected to cover.
 *
 * Same trap as the gig fields above and the same shape of proof —
 * `reimbursable` was the second field left out of the outbox payload,
 * so this drains and reloads rather than reading its own Dexie write
 * straight back.
 */
test("a billable expense survives a server round-trip", async ({ page }) => {
  const marker = `expense-booth-${Date.now()}`;

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
 * The assertions on `job-when` either side of Start/Stop are what would
 * catch a work control writing into `dateTime` — the fault the old
 * single form made possible.
 *
 * The plan is then asserted a THIRD time, after the outbox has drained
 * and the page has been reloaded, and that pass is the one that cannot
 * be fooled. Until the reload every reading comes from a record this
 * tab wrote and is still holding; only the pull can show what was
 * actually sent. A work-card write that merged onto a stale base would
 * revert the plan locally AND queue the reverted copy — the plan is
 * what the calendar event and the public availability page are built
 * from (domain/gig-time.ts), so a shift moved sideways here turns into
 * an agency being offered a booked afternoon.
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
  //
  // Typed only once Stop's write has landed. The card re-seeds its
  // draft from the record every time that record changes — a documented
  // trade in WorkCard.tsx, and the right one for a card whose job is to
  // be current — so text typed while a save is still in flight is
  // replaced when the saved copy comes back. Waiting for the receipt is
  // waiting for the last thing that could do that.
  await expect(page.getByTestId("work-save-state")).toContainText(/Saved at/);
  await page.getByTestId("gig-override").fill("189.17");
  await page.getByTestId("gig-override").blur();
  await expect(page.getByTestId("gig-expected-pay")).toContainText("$189.17");
  await page.getByTestId("gig-override-clear").click();
  await expect(page.getByTestId("gig-expected-pay")).not.toContainText("$189.17");

  // Byte-identical after the round trip: the same instant and the same
  // booked length, read back off the record the server now holds.
  await expect(page.getByTestId("sync-pending")).toBeHidden({ timeout: 20_000 });
  await page.reload();
  await expect(page.getByTestId("job-when")).toHaveAttribute(
    "data-value",
    "2027-03-04T09:00",
  );
  await expect(page.getByTestId("job-when")).toContainText("3h");
  // …and in the form that owns the plan, where the duration is stated
  // as the two numbers that were typed rather than as prose.
  await page.getByTestId("gig-edit").click();
  await dateTimeField(page, "gig-datetime").expectValue("2027-03-04T09:00");
  await expect(page.getByTestId("gig-duration-hours")).toHaveValue("3");
  await expect(page.getByTestId("gig-duration-minutes")).toHaveValue("0");
});

/**
 * A non-positive rate has to be stopped HERE, or it is lost silently.
 *
 * Zero and -50 both parse — `parseMoney` returns 0 and -5000, not null
 * — so nothing downstream refuses them until the backend's
 * `positiveCents` does, by which time the gig has been written locally
 * and queued. sync-engine.ts drops an op the server rejects with a
 * warn and no UI at all, so the record sits in Dexie looking saved and
 * never exists on the server. Refusing the submit is the only place
 * this can be caught where somebody is still looking at it.
 *
 * The message alone is not the assertion. What matters is that nothing
 * was WRITTEN: a form that showed the error and queued the gig anyway
 * would pass a message check and still lose the edit.
 */
test("a non-positive hourly rate is refused, and nothing is queued", async ({
  page,
}) => {
  const marker = `zero-rate-${Date.now()}`;
  const refusal = page.getByText("The hourly rate must be greater than zero.");

  await page.goto("/gigs/new");
  await page.getByTestId("gig-location").fill(marker);
  await page.getByTestId("gig-pay-type").selectOption("hourly");

  // Each attempt is checked for BOTH: the message, and still being on
  // the form the save was refused from. A save that fired lands on the
  // new gig's hub, so the URL is what says the guard actually stopped
  // it rather than merely complaining alongside it.
  for (const rate of ["0", "-50"]) {
    // 0 fails the `<= 0` guard as itself; -50 fails it after parsing to
    // -5000 — two routes to the same refusal.
    await page.getByTestId("gig-rate").fill(rate);
    await page.getByRole("button", { name: "Save gig" }).click();
    await expect(refusal).toBeVisible();
    await expect(page).toHaveURL(/\/gigs\/new$/);
    await expect(page.getByTestId("gig-rate")).toHaveValue(rate);
    await expect(page.getByTestId("gig-work-card")).toHaveCount(0);
  }

  // Nothing queued, and nothing stored: the outbox badge never appears,
  // and the gig is on no list. Both, because a local write and its
  // outbox op happen in the same call (lib/local-store.ts) — either one
  // showing up means the guard let a poison record through.
  await expect(page.getByTestId("sync-pending")).toBeHidden();
  await page.getByRole("link", { name: "Gigs" }).click();
  await expect(page.getByRole("heading", { name: "Gigs" })).toBeVisible();
  // Wait for the list to have actually rendered before claiming the gig
  // is absent from it — an empty screen agrees with any such claim.
  await expect(
    page.getByTestId("gig-list").or(page.getByText("No gigs yet")),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(marker)).toHaveCount(0);
});
