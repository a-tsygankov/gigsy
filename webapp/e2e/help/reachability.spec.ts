/**
 * Help is reachable, and starting a topic really starts a tour.
 *
 * scenarios.spec.ts drives every scenario through help-runner.ts, which
 * is Playwright acting out the *model*: it resolves targets and clicks
 * them itself. Nothing in it opens Settings, sees the help menu, or
 * loads Driver.js. `HelpSection` could be deleted from `Settings.tsx`
 * and that suite — and therefore CI — would stay green with help
 * completely absent from the product.
 *
 * So this spec covers the half the runner structurally cannot: the
 * entry point (Settings → Help → a topic list), and the in-app tour
 * runtime (`TourRenderer.ts` + Driver.js + `styles/help.css`), which the
 * runner never touches. It is deliberately ONE test against ONE
 * scenario — `open-settings`, the simplest — because its job is
 * "the wiring exists and works", not "the scenarios are correct". That
 * second job already has a suite; duplicating it here would double the
 * cost of every scenario for no extra signal.
 */
import { expect, test } from "@playwright/test";
import { openSettings } from "../../src/help/scenarios/open-settings.ts";
import { HelpTarget } from "../../src/help/targets.ts";
import { prepareHelpScenario, requireLocalTarget } from "./help-fixtures.ts";

requireLocalTarget();

test("help is reachable from Settings and starts a real tour", async ({
  page,
  request,
  baseURL,
}) => {
  // The fixture signs in and navigates to a scenario's `startRoute`.
  // This test starts where help *lives* rather than where the scenario
  // runs, because the tour's own hop to `/` is part of what's under
  // test here — `openSettings.startRoute` is `/` precisely so that
  // `settings-link`, which AppHeader hides on `/settings`, is on screen
  // by the time the tour looks for it.
  await prepareHelpScenario(page, request, baseURL!, {
    ...openSettings,
    startRoute: "/settings",
  });

  // 1. The entry point exists on Settings, with its topic list.
  await expect(page.getByTestId(HelpTarget.SettingsHelp.id)).toBeVisible();
  await expect(page.getByTestId("help-search")).toBeVisible();
  const startOpenSettings = page.getByTestId(`help-start-${openSettings.id}`);
  await expect(startOpenSettings).toBeVisible();

  // 2. Picking a topic starts the tour, which first routes to the
  //    scenario's own startRoute.
  await startOpenSettings.click();
  await expect(page).toHaveURL(new URL(openSettings.startRoute!, baseURL!).href);

  // 3. A Driver.js popover is up, and it is *ours*: `popoverClass`
  //    (TourRenderer.ts) is the only thing that puts `gigsy-help-popover`
  //    on it, and that class is the sole hook every rule in
  //    styles/help.css hangs off. A popover without it is Driver's stock
  //    white box wearing another product's look on a Gigsy screen.
  const popover = page.locator(".driver-popover.gigsy-help-popover");
  await expect(popover).toBeVisible();
  // Derived from the registry, not retyped: TourRenderer falls back to
  // the scenario title when a step has none, so this holds for either.
  await expect(popover).toContainText(openSettings.title);

  // …and the class is actually load-bearing, not just present. Driver's
  // own `.driver-popover` caps width at 300px; `styles/help.css` raises
  // it to 20rem. Reading the computed value proves the stylesheet
  // reached the page and beat Driver's base rule — which a class-name
  // assertion alone cannot tell apart from help.css never being
  // imported at all.
  await expect
    .poll(async () =>
      popover.evaluate((el) => getComputedStyle(el).maxWidth),
    )
    .toBe("320px");

  // 4. The spotlight is on the REAL control the scenario names. This is
  //    the whole promise of an executable tour: not "a popover appeared"
  //    but "it is pointing at the thing you must tap".
  await expect(page.getByTestId(HelpTarget.SettingsLink.id)).toHaveClass(
    /driver-active-element/,
  );

  // 5. And the click step is genuinely wired to the user's own tap —
  //    the tour never performs it (TourRenderer.ts's opening comment),
  //    so doing what the popover says has to be what advances it. One
  //    step, so completing it ends the tour and takes the popover with
  //    it.
  await page.getByTestId(HelpTarget.SettingsLink.id).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(popover).toBeHidden();
});

test("help is reachable from the header on a screen that is not Settings", async ({
  page,
  request,
  baseURL,
}) => {
  // The header's "?" button is the whole point of this test: it has to
  // open the same menu from a screen that has nothing to do with
  // Settings, proving help isn't only reachable through HelpSection.
  await prepareHelpScenario(page, request, baseURL!, {
    ...openSettings,
    startRoute: "/gigs",
  });

  // 1. The header entry point exists here, and the topic list opens.
  const helpLink = page.getByTestId("help-link");
  await expect(helpLink).toBeVisible();
  await helpLink.click();

  const sheet = page.getByTestId("help-sheet");
  await expect(sheet).toBeVisible();
  const startOpenSettings = sheet.getByTestId(`help-start-${openSettings.id}`);
  await expect(startOpenSettings).toBeVisible();

  // 2. Picking a topic closes the sheet and starts the real tour, which
  //    routes to the scenario's own startRoute ("/", not "/gigs").
  await startOpenSettings.click();
  await expect(sheet).toBeHidden();
  await expect(page).toHaveURL(new URL(openSettings.startRoute!, baseURL!).href);

  const popover = page.locator(".driver-popover.gigsy-help-popover");
  await expect(popover).toBeVisible();
  await expect(popover).toContainText(openSettings.title);
});
