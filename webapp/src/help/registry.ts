/**
 * The single discovery mechanism — the help menu, the Playwright suite
 * and any future generator all read this and nothing else.
 */
import { addExpense } from "./scenarios/add-expense.ts";
import { captureReceipt } from "./scenarios/capture-receipt.ts";
import { connectCalendar } from "./scenarios/connect-calendar.ts";
import { createClient } from "./scenarios/create-client.ts";
import { createGig } from "./scenarios/create-gig.ts";
import { createInvoice } from "./scenarios/create-invoice.ts";
import { setUpEmailCapture } from "./scenarios/email-capture.ts";
import { findAGig } from "./scenarios/find-a-gig.ts";
import { findAPayment } from "./scenarios/find-a-payment.ts";
import { installApp } from "./scenarios/install-app.ts";
import { configureNotifications } from "./scenarios/notifications.ts";
import { openSettings } from "./scenarios/open-settings.ts";
import { recordWork } from "./scenarios/record-work.ts";
import { configureWorkingHours } from "./scenarios/working-hours.ts";
import type { HelpScenario, HelpScenarioId } from "./types.ts";

export const helpScenarios: HelpScenario[] = [
  openSettings,
  // Registration order is what orders a category's own section in the
  // menu (HelpMenu.ts's `groupScenarios`), so creating comes before
  // finding: the form is what "Find a gig and open it" hands over to.
  // recordWork comes last of the three because it is what you do with a
  // gig once you've found it — its own fixed gig rather than one this
  // scenario found through the list, but the same "now that it exists"
  // relationship find-a-gig already has to create-gig.
  createGig,
  findAGig,
  recordWork,
  // "Clients & money": the client comes first because an expense can be
  // tied to a gig, and a gig to a client — the same order the data has.
  // Then money in before money out, which is the order the Money tab's
  // own segmented control puts them in (Money.tsx's OPTIONS) — reading
  // this section should not contradict the screen it describes.
  createClient,
  findAPayment,
  createInvoice,
  addExpense,
  // "Capture": the camera first, the email address second. The photo is
  // the route anyone can use immediately; forwarding needs a deployment
  // that has email capture switched on.
  captureReceipt,
  setUpEmailCapture,
  configureNotifications,
  configureWorkingHours,
  connectCalendar,
  installApp,
];

export function getHelpScenario(
  id: HelpScenarioId,
): HelpScenario | undefined {
  return helpScenarios.find((scenario) => scenario.id === id);
}

/** Installation lives in browser and OS chrome, so it is described but
 *  never executed. */
export const executableHelpScenarios: HelpScenario[] = helpScenarios.filter(
  (scenario) => scenario.executable !== false,
);
