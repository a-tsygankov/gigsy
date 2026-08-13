/**
 * The single discovery mechanism — the help menu, the Playwright suite
 * and any future generator all read this and nothing else.
 */
import { openSettings } from "./scenarios/open-settings.ts";
import type { HelpScenario, HelpScenarioId } from "./types.ts";

export const helpScenarios: HelpScenario[] = [openSettings];

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
