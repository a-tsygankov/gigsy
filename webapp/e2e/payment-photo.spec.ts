import {
  test,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { devAccessToken, requireTestAuth } from "./helpers/test-auth.ts";

/**
 * Proof of payment, through an outage.
 *
 * The money survives a dead zone because it is a record and records go
 * to the outbox. A photograph cannot: an R2 upload needs a connection,
 * and until this test's feature existed the screen said so — "save the
 * payment first, then attach the proof", and then "uploads need a
 * connection". Both true, and both useless at the moment that matters,
 * which is standing in front of a client with the confirmation screen
 * on their phone and no signal on yours.
 *
 * Everything below is asserted against the SERVER, never against the
 * queue. An implementation that dropped the row without uploading
 * anything would empty the queue exactly as convincingly as one that
 * worked — the same reason lib/sync-engine.test.ts reads bytes back out
 * of its fake bucket. Here the bytes come back out of R2 itself,
 * through the same authed endpoint the app uses.
 *
 * Note the shape of the offline half: the app is navigated to the form
 * BEFORE the link is cut. `vite dev` serves no service worker, so a
 * document load with no connectivity fails for reasons that have
 * nothing to do with this feature (e2e/offline-shell.spec.ts is where
 * the real worker is exercised, against a production build).
 */

/** A real 1×1 PNG. Not a text blob with an image mime type: R2 stores
 *  what it is given, and a test whose "photo" is not a photo cannot
 *  notice a path that transcodes, re-encodes or mangles it. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");

/**
 * The app-wide sync chip, as opposed to the one beside the photo.
 *
 * There are two on this screen and that is deliberate: the payment's
 * "waiting" row renders the SAME `SyncBadge` component, because reusing
 * the app's existing way of saying "the server has not got this yet"
 * was the point of Step 3 rather than inventing a second vocabulary.
 * The cost is that a bare `getByTestId("sync-pending")` is ambiguous
 * here, so every assertion about the DEVICE's state says so.
 */
function headerBadge(page: Page, testId: string): Locator {
  return page.getByRole("banner").getByTestId(testId);
}

async function serverPayment(
  request: APIRequestContext,
  baseURL: string,
  token: string,
  id: string,
): Promise<{ confirmationR2Key: string | null }> {
  const res = await request.get(`${baseURL}/api/payments/${id}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.ok(), `GET /api/payments/${id} → ${res.status()}`).toBe(true);
  return (await res.json()) as { confirmationR2Key: string | null };
}

test.beforeEach(async ({ page, request, baseURL }) => {
  await requireTestAuth(request, baseURL!);
  await page.goto("/login");
  await page.getByTestId("test-signin").click();
  await expect(page.getByTestId("tab-bar")).toBeVisible();
});

test("a payment recorded offline carries its photo to the server", async ({
  page,
  context,
  request,
  baseURL,
}) => {
  const token = await devAccessToken(request, baseURL!);

  // Load the form while there is still a connection — see the note
  // above about the dev server having no service worker.
  await page.goto("/payments/new");
  await expect(page.getByTestId("payment-amount")).toBeVisible();

  await context.setOffline(true);
  await expect(headerBadge(page, "sync-offline")).toBeVisible({ timeout: 20_000 });

  // The file input is on the form, above Save, on a payment that does
  // not exist yet. That is Step 1 of the task in one assertion: the
  // old screen showed "Save the payment first, then attach the proof"
  // here and no input at all.
  await page.getByTestId("payment-amount").fill("42.50");
  await page.getByTestId("payment-confirmation-file").setInputFiles({
    name: "confirmation.png",
    mimeType: "image/png",
    buffer: PNG_BYTES,
  });
  await expect(page.getByTestId("payment-photo-chosen")).toBeVisible();

  await page.getByTestId("payment-save").click();
  // The URL change, not the click. A save is several awaited Dexie
  // writes and the click returns before any of them; asserting on
  // anything else here races the writes it depends on.
  await expect(page).toHaveURL(/\/payments\/(?!new$)[\w-]+/, { timeout: 15_000 });
  const paymentId = /\/payments\/([\w-]+)/.exec(page.url())?.[1];
  expect(paymentId, `no payment id in ${page.url()}`).toBeTruthy();

  // Step 3: the payment admits its photo is waiting. The badge in that
  // row is SyncBadge — the app's existing way of saying "this device is
  // holding something the server has not got" — showing its offline
  // face because that is what is true.
  const pending = page.getByTestId("payment-photo-pending");
  await expect(pending).toBeVisible({ timeout: 15_000 });
  await expect(pending.getByTestId("sync-offline")).toBeVisible();
  // And the chosen photo is on screen, from the bytes on the device —
  // there is nothing on the server to fetch one from.
  await expect(page.getByAltText("Payment confirmation")).toBeVisible();

  // Nothing reached the server: not the payment, and certainly not the
  // photo. Proving the "before" is what makes the "after" mean
  // something.
  const early = await request.get(`${baseURL}/api/payments/${paymentId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(early.status()).toBe(404);

  await context.setOffline(false);

  // Everything drained — and with photos counted in it, this badge
  // clearing now means the image went too, not just the record.
  await expect(headerBadge(page, "sync-pending")).toBeHidden({ timeout: 30_000 });
  await expect(headerBadge(page, "sync-offline")).toBeHidden({ timeout: 30_000 });

  // THE assertion. Not "the queue is empty" — the server holds a
  // confirmation key for this payment…
  await expect
    .poll(
      async () =>
        (await serverPayment(request, baseURL!, token, paymentId!)).confirmationR2Key,
      { timeout: 30_000 },
    )
    .not.toBeNull();

  // …and the object under it is byte-for-byte the PNG that was chosen,
  // fetched back through the app's own authed endpoint.
  const object = await request.get(
    `${baseURL}/api/payments/${paymentId}/confirmation`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  expect(object.ok(), `GET confirmation → ${object.status()}`).toBe(true);
  expect(object.headers()["content-type"]).toContain("image/png");
  expect(Buffer.compare(await object.body(), PNG_BYTES)).toBe(0);

  // Back on the screen: the "waiting" line is gone, because the wait is
  // over. A fresh document load, because a pull writes into Dexie
  // without telling React Query and an in-app navigation inside the
  // 30-second staleTime would re-render the copy this tab already had.
  await page.goto(`/payments/${paymentId}`);
  await expect(page.getByAltText("Payment confirmation")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("payment-photo-pending")).toBeHidden();
  await expect(page.getByTestId("payment-photo-failed")).toBeHidden();

  // Tidy up after a shared dev user.
  await request.delete(`${baseURL}/api/payments/${paymentId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
});

test("a photo attached with a connection still lands, without a second screen", async ({
  page,
  request,
  baseURL,
}) => {
  // The online case takes the identical road — chosen on the form,
  // queued on save, drained by the engine — so this is not a second
  // code path so much as proof that there is only one. It matters
  // because the old flow made the online case the ONLY case, and the
  // temptation when adding a queue is to keep a direct-upload branch
  // beside it "for speed" and then maintain two.
  const token = await devAccessToken(request, baseURL!);

  await page.goto("/payments/new");
  await page.getByTestId("payment-amount").fill("17.00");
  await page.getByTestId("payment-confirmation-file").setInputFiles({
    name: "confirmation.png",
    mimeType: "image/png",
    buffer: PNG_BYTES,
  });
  await page.getByTestId("payment-save").click();
  await expect(page).toHaveURL(/\/payments\/(?!new$)[\w-]+/, { timeout: 15_000 });
  const paymentId = /\/payments\/([\w-]+)/.exec(page.url())?.[1];
  expect(paymentId).toBeTruthy();

  await expect(headerBadge(page, "sync-pending")).toBeHidden({ timeout: 30_000 });

  await expect
    .poll(
      async () =>
        (await serverPayment(request, baseURL!, token, paymentId!)).confirmationR2Key,
      { timeout: 30_000 },
    )
    .not.toBeNull();

  const object = await request.get(
    `${baseURL}/api/payments/${paymentId}/confirmation`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  expect(object.ok()).toBe(true);
  expect(Buffer.compare(await object.body(), PNG_BYTES)).toBe(0);

  await request.delete(`${baseURL}/api/payments/${paymentId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
});
