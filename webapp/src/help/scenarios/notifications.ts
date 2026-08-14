import { HelpTarget } from "../targets.ts";
import type { HelpScenario } from "../types.ts";

/**
 * The conditional case. Push is genuinely unavailable on plenty of real
 * devices — iOS before the app is installed, a blocked permission, a
 * deployment with no VAPID keys — and Settings.tsx renders either the
 * button or an explanation, never both. Telling someone to tap a control
 * that is deliberately absent is worse than saying nothing.
 */
export const configureNotifications: HelpScenario = {
  id: "configure-notifications",
  title: "Turn on notifications",
  description: "A nudge when a lead goes cold or an invoice stays unpaid.",
  category: "settings",
  startRoute: "/settings",
  // Headless Chromium cannot grant notification permission and the local
  // worker has no push config, so CI always takes the blocked branch.
  // Saying so here is the point: if that ever changes, the suite fails
  // instead of quietly testing something else.
  expectedCiBranches: ["push-blocked"],
  steps: [
    {
      action: "highlight",
      target: HelpTarget.SettingsNotifications,
      title: "Notifications",
      description:
        "Reminders live here. At most one a day, and only for work that needs chasing.",
    },
    {
      action: "branch",
      branches: [
        {
          id: "push-available",
          when: { type: "target-visible", target: HelpTarget.PushToggle },
          steps: [
            {
              action: "click",
              target: HelpTarget.PushToggle,
              title: "Turn them on",
              description:
                "Tap this, then allow notifications when your browser asks.",
            },
          ],
        },
        {
          id: "push-blocked",
          when: { type: "target-visible", target: HelpTarget.PushUnavailable },
          steps: [
            {
              action: "highlight",
              target: HelpTarget.PushUnavailable,
              title: "Not available here",
              description:
                "This message says why, and what to do about it — usually installing Gigsy to your home screen first.",
            },
          ],
        },
      ],
    },
  ],
};
