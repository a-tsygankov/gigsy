import { HelpTarget, dayStart, dayToggle } from "../targets.ts";
import type { HelpScenario } from "../types.ts";

/**
 * Working hours decide what an agency sees on a shared availability
 * page, so this is the scenario where "the tour must not click for you"
 * stops being theoretical.
 *
 * Sunday, deliberately: its label is three characters wide, which is how
 * the untappable-switch bug finally surfaced ("why can't I switch Sun").
 *
 * It branches because Sunday's state is not knowable in advance, and
 * both states are legitimate (§3.6). An earlier version assumed the day
 * started off and told everyone to tap the switch. For a returning user
 * whose Sunday was already on — or anyone running this straight after
 * the Playwright suite, which leaves it on — that tap turned the day
 * OFF, the row collapsed, and the `select` step's target left the page
 * for good. The tour asked the user to break the very state it was
 * about to describe.
 *
 * So the switch is only a *click* step when tapping it is the thing that
 * moves the scenario forward. When the day is already on, the same
 * switch is explained rather than operated: the point is to show how a
 * row works, and that is entirely demonstrable without turning
 * somebody's Sunday off on their behalf.
 */
export const configureWorkingHours: HelpScenario = {
  id: "configure-working-hours",
  title: "Set your working days and hours",
  description:
    "Free time outside these hours is your evening, not availability.",
  category: "settings",
  startRoute: "/settings",
  // help-fixtures.ts's `resetWorkingWeek` pins the shared dev user's
  // week back to the schema default before every run, and that default
  // has Sunday off — so CI always arrives with the day off and takes
  // that branch. Recorded here so that if the fixture, the schema
  // default, or the reset ever stops doing that, the suite fails instead
  // of quietly exercising the branch nobody meant to test.
  expectedCiBranches: ["day-off"],
  steps: [
    {
      action: "highlight",
      target: HelpTarget.AvailWorkingWeek,
      title: "Working hours",
      description:
        "One row per day. A day switched off is never offered, whatever your calendar says.",
    },
    {
      action: "branch",
      branches: [
        {
          // `start-day-0` exists only while Sunday is on, so its
          // presence is the state — no need to read the switch itself,
          // whose own checked-ness lives on a node the spotlight
          // deliberately never touches (targets.ts).
          id: "day-already-on",
          when: { type: "target-visible", target: dayStart(0) },
          steps: [
            {
              action: "highlight",
              target: dayToggle(0),
              title: "Sunday is already on",
              description:
                "The same switch turns a day back off. Leave it on for now — its hours are on the same row.",
            },
          ],
        },
        {
          id: "day-off",
          when: { type: "target-missing", target: dayStart(0) },
          steps: [
            {
              action: "click",
              target: dayToggle(0),
              title: "Switch a day on or off",
              description:
                "Tap the switch itself — Sunday here. The row expands to show start and end times when it is on.",
            },
          ],
        },
      ],
    },
    {
      // Common to both branches: whichever way the row got here, it is
      // open by the time this step runs.
      action: "select",
      target: dayStart(0),
      value: "540",
      title: "Set when the day starts",
      description: "Times snap to the half hour. 540 minutes is 09:00.",
    },
  ],
};
