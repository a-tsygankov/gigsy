import { test, expect } from "@playwright/test";
import { requireTestAuth } from "./helpers/test-auth.ts";

/**
 * The client's delivery switch, round-tripped (docs/superpowers/specs/
 * 2026-09-20-optional-delivery-design.md).
 *
 * The unit tests prove the pieces: ClientEdit.test.tsx that the form
 * sends `needsDelivery` to `putClient`, local-store.test.ts that the
 * outbox payload carries it. What only a round trip proves is that the
 * value SURVIVES — through the sync engine, the server's ClientInput,
 * the column, and the pull that rewrites the local record — and comes
 * back checked when the client is reopened from the list. That last
 * hop is the one a missing wire field would break silently: the form
 * would look right until the first pull reverted it (see the
 * `OutboxPayload` comment in src/lib/local-store.ts).
 *
 * The shared dev user accumulates clients from every prior run, so the
 * name carries a unique marker and the list is searched for it.
 */

/**
 * The input is `sr-only` and the switch you see is a sibling span
 * (components/Toggle.tsx). Clicks go to the PAINTED switch — the same
 * locator settings.spec.ts and help/targets.ts use — because clicking
 * the testid resolves to the hidden input and passes either way.
 * Assertions read the input, which is where the checked state lives.
 */
function paintedSwitch(page: import("@playwright/test").Page, testId: string) {
  return page.locator(`label:has([data-testid="${testId}"]) span[aria-hidden="true"]`).first();
}

test.beforeEach(async ({ page, request, baseURL }) => {
  await requireTestAuth(request, baseURL!);
  await page.goto("/login");
  await page.getByTestId("test-signin").click();
  await expect(page.getByTestId("tab-bar")).toBeVisible();
});

test("a client saved with the delivery switch on reopens with it on", async ({ page }) => {
  const clientName = `Delivery Client ${Date.now()}`;

  await page.goto("/clients/new");
  await page.getByTestId("client-name").fill(clientName);

  // Off by default: the setting behind it defaults to false on the
  // server and nothing in this suite turns it on. Asserted rather than
  // assumed, so a run against a user whose setting IS on fails here
  // with a readable reason instead of on the reopen.
  const toggle = page.getByTestId("client-needs-delivery");
  await expect(toggle).not.toBeChecked();
  await paintedSwitch(page, "client-needs-delivery").click();
  await expect(toggle).toBeChecked();

  await page.getByTestId("client-save").click();

  // Saving lands on the list; wait for the sync to drain before
  // reopening so what comes back has been through the server.
  await expect(page).toHaveURL(/\/clients$/, { timeout: 15_000 });
  await expect(page.getByText(clientName).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("sync-pending")).toBeHidden({ timeout: 20_000 });

  // Reload rather than navigate, so the record read is the one the
  // pull wrote and not the in-memory query cache from the save.
  await page.reload();
  await expect(page.getByTestId("tab-bar")).toBeVisible();
  await page.getByText(clientName).first().click();

  await expect(page).toHaveURL(/\/clients\/[0-9a-f-]+$/, { timeout: 15_000 });
  await expect(page.getByTestId("client-needs-delivery")).toBeChecked({ timeout: 15_000 });
});
