import { HelpTarget } from "../targets.ts";
import type { HelpScenario } from "../types.ts";

/**
 * Reporting a wrong reading — capture's "Report error"
 * (docs/superpowers/specs/2026-10-12-capture-report-error-design.md).
 *
 * Its own scenario rather than more sentences in `capture-receipt`:
 * that walk never reaches a draft (it would have to upload a file to
 * get one), while this one starts on the Drafts list, follows the
 * person into a draft they pick, and walks the sheet the button opens.
 * `capture-receipt`'s last step points here by title.
 *
 * Starts on `/drafts`, the `record-work` shape: a `navigate` step
 * spotlights the whole list and the person taps their own row. The
 * `click` on "Report error" only OPENS the sheet — no record, nothing
 * sent — which is what makes it a step the runner may perform. The walk
 * stops on Send and never presses it: sending would store a feedback
 * row and spend one of the day's reports.
 *
 * `expectedCiBranches: ["drafts-showing"]` because
 * `prepareHelpScenario` seeds one draft through the stub extractor when
 * the account has none pending (help-fixtures.ts,
 * `ensureAtLeastOneDraft`). The runner taps the first row, which is
 * SOME pending draft; every step after the navigate targets controls
 * that every loaded draft renders, so which one it is does not matter.
 *
 * The "no drafts" branch is the "No drafts waiting" box itself, not the
 * list's absence — the list is also absent while loading and when
 * offline (the positive-condition rule every branch here follows).
 */
export const reportCaptureError: HelpScenario = {
  id: "report-capture-error",
  title: "Report a wrong reading",
  description:
    "When capture reads a photo or email wrong, send the team the original, what it read and what you fixed — usually without typing a word.",
  category: "capture",
  startRoute: "/drafts",
  expectedCiBranches: ["drafts-showing"],
  steps: [
    {
      action: "branch",
      branches: [
        {
          id: "drafts-showing",
          when: { type: "target-visible", target: HelpTarget.DraftsList },
          steps: [
            {
              action: "navigate",
              target: HelpTarget.DraftsList,
              route: "/drafts/:id",
              title: "Open the draft it got wrong",
              description:
                "Every photo you capture and every booking email you forward waits here until you confirm or discard it. Tap the one that was read wrong. Opening a draft changes nothing.",
            },
            {
              action: "highlight",
              target: HelpTarget.DraftReportError,
              title: "Fix it first, then report it",
              description:
                "Correct the fields above the way you normally would — the client, the date, the amount, whatever it misread. Then tap Report error. Your fixes are the most useful part of the report, so make them before you tap, not after. Reporting doesn't confirm, save or discard the draft; you still finish it with Confirm, Later or Discard.",
            },
            {
              action: "click",
              target: HelpTarget.DraftReportError,
              title: "Open the report",
              description:
                "Tap Report error. A sheet opens showing exactly what will be sent; nothing goes anywhere until you press Send.",
            },
            {
              action: "highlight",
              target: HelpTarget.CaptureReportDiff,
              title: "What it read, and what you changed",
              description:
                "Each field you corrected is listed with what capture read beside what you changed it to. Fields you left alone aren't listed. If you haven't changed anything, it says so — then either close the sheet and fix the fields first, or say what was wrong in the box below.",
            },
            {
              action: "highlight",
              target: HelpTarget.CaptureReportMessage,
              title: "Say what was wrong — or don't",
              description:
                "Optional. If you corrected at least one field you can leave it empty, and the report says which fields were wrong for you. If nothing was corrected, write a line here — a wrong kind, a missed second date, a total that's really a deposit — or Send stays greyed out, because there would be nothing to report.",
            },
            {
              action: "highlight",
              target: HelpTarget.CaptureReportOriginal,
              title: "The original goes with it",
              description:
                "On by default: the team gets the photo or the forwarded email you captured, copied on the server rather than uploaded again from your phone. Turn it off if the original shows something you'd rather not send — the report still goes, just without it. Keep it on if you can: without the original nobody can see why it was misread.",
            },
            {
              action: "highlight",
              target: HelpTarget.CaptureReportSend,
              title: "Send",
              description:
                'Sends the report to the team and tells you once it\'s stored. It needs a connection, like capture itself, and counts toward the same daily limit as "Send feedback" in this help sheet. If a reading fails outright and no draft is made, the Capture screen offers "Report this" beside the error instead — it opens this same sheet with the file you chose. This walkthrough stops here without sending anything.',
              end: true,
            },
          ],
        },
        {
          id: "no-drafts",
          when: { type: "target-visible", target: HelpTarget.DraftsEmpty },
          steps: [
            {
              action: "highlight",
              target: HelpTarget.DraftsEmpty,
              title: "Nothing to report on yet",
              description:
                'Reports are made from a draft, and you have none waiting. Next time capture reads a photo or email wrong, open the draft here, correct the fields, and tap Report error at the bottom. The team gets the original, what was read and what you changed it to, with nothing to type unless you want to. If a reading fails outright and no draft is made, the Capture screen offers "Report this" beside the error instead.',
            },
          ],
        },
      ],
    },
  ],
};
