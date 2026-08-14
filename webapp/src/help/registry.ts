/**
 * The single discovery mechanism — the help menu, the Playwright suite
 * and any future generator all read this and nothing else.
 */
import { createGig } from "./scenarios/create-gig.ts";
import { setUpEmailCapture } from "./scenarios/email-capture.ts";
import { findAGig } from "./scenarios/find-a-gig.ts";
import { installApp } from "./scenarios/install-app.ts";
import { configureNotifications } from "./scenarios/notifications.ts";
import { openSettings } from "./scenarios/open-settings.ts";
import { configureWorkingHours } from "./scenarios/working-hours.ts";
import type { HelpScenario, HelpScenarioId } from "./types.ts";

export const helpScenarios: HelpScenario[] = [
  openSettings,
  // Registration order is what orders a category's own section in the
  // menu (HelpMenu.ts's `groupScenarios`), so creating comes before
  // finding: the form is what "Find a gig and open it" hands over to.
  createGig,
  findAGig,
  configureNotifications,
  configureWorkingHours,
  setUpEmailCapture,
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
