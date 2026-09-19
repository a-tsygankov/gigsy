import { HelpTarget } from "../targets.ts";
import type { HelpScenario } from "../types.ts";

/** The simplest thing that proves model, tour and runner agree. */
export const openSettings: HelpScenario = {
  id: "open-settings",
  title: "Open Settings",
  description: "Everything you can configure lives on one screen.",
  category: "settings",
  // Not "/settings": on that screen the gear is the same control in its
  // pressed state and CLOSES Settings (AppHeader.tsx's `closeSettings`),
  // so a tour starting there would tell you to open what you are
  // already looking at and the tap would take you away from it.
  startRoute: "/",
  steps: [
    {
      action: "click",
      target: HelpTarget.SettingsLink,
      title: "Open Settings",
      description: "Tap the gear, at the top right.",
    },
  ],
};
