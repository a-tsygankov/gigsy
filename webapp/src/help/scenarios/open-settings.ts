import { HelpTarget } from "../targets.ts";
import type { HelpScenario } from "../types.ts";

/** The simplest thing that proves model, tour and runner agree. */
export const openSettings: HelpScenario = {
  id: "open-settings",
  title: "Open Settings",
  description: "Everything you can configure lives on one screen.",
  category: "settings",
  // Not "/settings": AppHeader hides the link on the screen it leads to,
  // so a tour starting there would point at nothing.
  startRoute: "/",
  steps: [
    {
      action: "click",
      target: HelpTarget.SettingsLink,
      title: "Open Settings",
      description: "Tap Settings, at the top right.",
    },
  ],
};
