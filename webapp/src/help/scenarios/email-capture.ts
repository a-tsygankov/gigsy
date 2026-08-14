import { HelpTarget } from "../targets.ts";
import type { HelpScenario } from "../types.ts";

/**
 * A working inbox nobody can find is not a feature (CaptureSection.tsx).
 * The screen renders either the forwarding address or a line saying
 * capture isn't switched on for this deployment — never both — so this
 * scenario branches the same way `configure-notifications` does.
 *
 * `expectedCiBranches` is `["capture-unconfigured"]`: the local dev
 * backend has no `CAPTURE_EMAIL_DOMAIN` configured
 * (backend/wrangler.toml sets it to `""`, and neither `.dev.vars` nor
 * `.dev.vars.example` sets one), so `captureAddressFor` always returns
 * null there and the screen always renders `capture-unconfigured`. Not
 * just read off the config — confirmed by running the suite against the
 * local stack three times in a row, all three taking this branch.
 */
export const setUpEmailCapture: HelpScenario = {
  id: "set-up-email-capture",
  title: "Forward a booking email",
  description: "Forward it and it becomes a draft to review, nothing more.",
  category: "settings",
  startRoute: "/settings",
  expectedCiBranches: ["capture-unconfigured"],
  steps: [
    {
      action: "highlight",
      target: HelpTarget.SettingsCapture,
      title: "Capture by email",
      description:
        "Forward a booking email here and Gigsy reads it into a draft — nothing is created until you confirm it.",
    },
    {
      action: "branch",
      branches: [
        {
          id: "capture-configured",
          when: { type: "target-visible", target: HelpTarget.CaptureAddress },
          steps: [
            {
              action: "highlight",
              target: HelpTarget.CaptureAddressValue,
              title: "Your forwarding address",
              description:
                "Forward or BCC a booking email to this address. It's unguessable, not secret — treat it the way you'd treat any inbox address.",
            },
          ],
        },
        {
          id: "capture-unconfigured",
          when: { type: "target-visible", target: HelpTarget.CaptureUnconfigured },
          steps: [
            {
              action: "highlight",
              target: HelpTarget.CaptureUnconfigured,
              title: "Not switched on here",
              description:
                "This deployment hasn't set up email capture yet, so there's no address to forward to.",
            },
          ],
        },
      ],
    },
  ],
};
