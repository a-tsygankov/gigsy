import { HelpTarget } from "../targets.ts";
import type { HelpScenario } from "../types.ts";

/**
 * The Work card, control by control — status, the clock, breaks, what
 * it's worth, and where actual payments live — on a gig the person
 * picks themselves.
 *
 * It did not always work that way. This scenario used to start on one
 * hard-coded gig id that `webapp/e2e/help/help-fixtures.ts` upserted
 * before every Playwright run. That passed CI and was broken for
 * everybody else: on a real account the gig does not exist,
 * `GigDetail.tsx` takes its `gig.isError` path, and all seven targets
 * below go unresolved and degrade to prose with no spotlight. The
 * fixture still pins a gig, but only so that "the first row" means
 * something fixed in CI — no scenario knows an id any more.
 *
 * So this opens where a person opens a gig, on `/gigs`, and hands the
 * choice back. `find-a-gig`'s header explains why no scenario can point
 * at a particular row — `CardLink`s carry no identifier a HelpTarget
 * can read, and a HelpTarget resolves one static selector with no
 * runtime parameter. A `navigate` step does not need to: it spotlights
 * the LIST, the person taps whichever row is theirs, and the tour
 * follows them onto that gig (types.ts's `NavigateStep`; the tap
 * bubbles to the container, so the tour never learns which row it was).
 *
 * It deliberately does not re-explain search and filters — "Find a gig
 * and open it" is a topic of its own, and the navigate step's copy
 * points at it. Two of the three list states have no row to tap at all,
 * so they end on a terminal step: help must never ask for a tap that
 * cannot happen, and the Work-card steps written after the branch must
 * not run on a screen those two never leave.
 *
 * Every step is a `highlight`, for the reason `create-gig.ts`'s header
 * gives at length: this runs in CI against a shared dev database, and
 * `performAction` really does fill, select and click. That file's form
 * is safe to leave half-filled because nothing writes until Save is
 * pressed; this card has no such backstop — WorkCard.tsx says so
 * plainly, "every control here writes... on change... on blur or
 * Enter", with no Save button at all. A `click` or `input` step here
 * would stamp a start time, change a status, or set an override on a
 * real record the instant the step ran. The navigate step does not
 * break that rule either: tapping a row is a read.
 *
 * Two of the card's controls are not on every gig, which is why the
 * last two branches exist rather than the steps simply being there:
 *
 *   - `gig-expected-pay` renders only when a figure can be computed —
 *     `expectedCents` (lib/gig-pay.ts) is null for a fixed-fee gig with
 *     no amount, and for an hourly one with no rate or no billable
 *     minutes.
 *   - `gig-override` renders only on an hourly gig (`WorkCard.tsx`'s
 *     `isHourly && <HourlyOverride ...>`).
 *
 * Both branches sit AFTER the navigate step, which is the thing the old
 * renderer could not do: `flatten()` resolved every branch against the
 * screen the tour started on, so a branch about a gig the user had not
 * opened yet always measured `/gigs`. TourRenderer now expands one
 * branch at a time as the tour reaches it, matching what
 * `help-runner.ts` always did. Do not move these branches ahead of the
 * navigate step to "be safe" — ahead of it they are wrong.
 *
 * Left out, on purpose:
 *
 *   - The Started/Finished `DateTimeField`s underneath Start and Stop
 *     (`gig-work-start`, `gig-work-end`). They exist to correct a stamp
 *     taken late, which the Start and Stop steps below already say —
 *     covering the same fact twice as two more highlights would be
 *     narrating the screen, not explaining it.
 *   - Additional services (`gig-services`). It is not part of the Work
 *     card — it is its own section between the card and Payments — and
 *     nothing about it is specific to recording work.
 *   - The Edit button onto the Job card's form as a step of its own.
 *     `create-gig` already walks that form field by field. It appears
 *     below only as where `pay-not-yet` sends you when no figure can be
 *     shown at all, because a missing rate or fee is something you
 *     change on the job, not here. `fixed-fee-gig` — the other
 *     "control isn't on this gig" alternative — points at the Job
 *     card's Pays row instead of the button: highlighting the same
 *     button two branch steps running would leave the spotlight
 *     sitting still, which reads as a stuck tour rather than a walk.
 *
 * The copy explains what a control is FOR and what it changes
 * elsewhere — same rule as every other scenario in this directory. Two
 * things worth saying that the screen itself doesn't: recording work
 * here never moves the planned date, time or duration on the Job card
 * (gig-pay.ts's own header calls that the whole reason its fields are
 * split the way they are), and an hourly gig's pay line prices actual
 * time worked once you've recorded it, quoting rate × the planned
 * duration until then.
 */
export const recordWork: HelpScenario = {
  id: "record-work",
  title: "Record work on a gig",
  description:
    "Status, the clock, breaks and what it's worth — the half of a gig that changes on the day, one thumb at a time.",
  category: "gigs",
  startRoute: "/gigs",
  // Empirical, not assumed — run and observed. `gigs-showing` holds
  // because `prepareHelpScenario` pins the saved gig-list view back to
  // defaults and upserts one gig unconditionally, so the list always
  // has a row (help-fixtures.ts). `pay-shown` and `hourly-gig` hold
  // because that same fixture gig is hourly, rated and has a duration,
  // and sorts to the top of the default `newest` view — which is the
  // row help-runner.ts's navigate step clicks. If any of those three
  // stops being true, this assertion fails instead of the suite quietly
  // exercising the other alternative.
  expectedCiBranches: ["gigs-showing", "pay-shown", "hourly-gig"],
  steps: [
    {
      action: "branch",
      branches: [
        {
          id: "gigs-showing",
          when: { type: "target-visible", target: HelpTarget.GigList },
          steps: [
            {
              action: "navigate",
              target: HelpTarget.GigList,
              route: "/gigs/:id",
              title: "Open the gig you worked",
              description:
                "Tap whichever row is the job you want to record time against — only you know which one that is. If the list is long, \"Find a gig and open it\" covers the search box and the filters that narrow it. Opening a gig changes nothing; the rest of this walkthrough happens on the screen that opens.",
            },
            {
              action: "highlight",
              target: HelpTarget.GigStatus,
              title: "Status",
              description:
                "lead → confirmed → completed → delivered, and it drives real behaviour, not just a label. A lead never blocks time on your public availability page and never reaches Google Calendar — it's an offer, not a commitment; confirmed does both. Completed is what the dashboard reads as work waiting to be paid. Delivered means the work has been handed over — it's still counted as owed and still blocks the time, exactly like completed, just one step further along. Cancelled pulls the gig out of your calendar, your availability and your reports without deleting the record. Whether it's actually been paid is worked out from the payments recorded below, not set here.",
            },
            {
              action: "highlight",
              target: HelpTarget.GigWorkStartButton,
              title: "Start",
              description:
                "Tap this the moment you actually begin, not before it. It stamps the clock to now, to the minute, and writes only to this gig's actuals — the planned date, time and duration on the Job card above never move, on this tap or anything else on this card. That split is the whole reason the two cards exist: what was agreed stays put, and what happened gets recorded separately.",
            },
            {
              action: "highlight",
              target: HelpTarget.GigWorkStopButton,
              title: "Stop",
              description:
                "Stamps the finish the same way Start stamps the beginning. It stays disabled until there's a start to close, and disables again once a finish is already stamped — so if it's grey, either nothing has started yet or this shift is already closed out. The span between the two — minus whatever you log as a break below — becomes the time this gig actually took, and on an hourly gig that's what gets multiplied by the rate instead of the planned duration.",
            },
            {
              action: "highlight",
              target: HelpTarget.GigBreak,
              title: "Off-time breaks (minutes)",
              description:
                "Minutes to subtract from the span between Start and Stop before anything gets priced — lunch, a delay, anywhere you weren't working. It only changes the figure once both stamps exist; log it early and it's still there, waiting for a span to apply to.",
            },
          ],
        },
        {
          id: "gigs-hidden-by-filters",
          // Reached only when the row wrapper is absent but the filter
          // bar is not — Gigs.tsx renders the "No gigs match these
          // filters" empty state in exactly that combination.
          when: { type: "target-visible", target: HelpTarget.GigFilters },
          steps: [
            {
              action: "highlight",
              target: HelpTarget.GigFiltersToggle,
              title: "Your filters are hiding everything",
              description:
                "You do have gigs — none of them matches what is set right now, so there is no row here to open. Open this panel and widen it: a date range drops every undated gig, \"hide past gigs\" drops everything before today, and Clear filters puts all of it back at once.",
            },
            {
              action: "highlight",
              target: HelpTarget.GigSearch,
              title: "…and check the search box",
              description:
                "Search narrows the list too, and it survives leaving the screen and coming back, so it is easy to forget something is still in it. Empty it, and once a row appears, start this walkthrough again and tap the gig you want.",
              // Every step below this branch is on a gig's own screen,
              // which this path never reaches.
              end: true,
            },
          ],
        },
        {
          id: "no-gigs-yet",
          // No filter bar at all means the user owns no gigs — the bar
          // is unconditional on `all.length > 0`, so there is nothing to
          // search and no row to tap.
          when: { type: "target-missing", target: HelpTarget.GigFilters },
          steps: [
            {
              action: "highlight",
              target: HelpTarget.GigAdd,
              title: "Nothing to record work against yet",
              description:
                "There are no gigs on this account, so there is nothing here to open. Add one with this button — \"Add a gig by hand\" walks through the form — and everything this walkthrough covers lives on the screen that gig opens on.",
              end: true,
            },
          ],
        },
      ],
    },
    // From here down: reached only by `gigs-showing`, the one
    // alternative above that does not end, and therefore always on a
    // gig's own screen.
    {
      action: "branch",
      branches: [
        {
          id: "pay-shown",
          when: { type: "target-visible", target: HelpTarget.GigExpectedPay },
          steps: [
            {
              action: "highlight",
              target: HelpTarget.GigExpectedPay,
              title: "What it's worth",
              description:
                "Updates the instant any of the times or amounts above it change. A fixed-fee gig just shows the agreed amount. An hourly one prices the time you've actually recorded once Start and Stop have both landed — before that, it quotes rate × the planned duration from the Job card instead, so there's always a figure here, not a blank.",
            },
          ],
        },
        {
          id: "pay-not-yet",
          when: { type: "target-missing", target: HelpTarget.GigExpectedPay },
          steps: [
            {
              action: "highlight",
              target: HelpTarget.GigEditButton,
              title: "No figure on this one yet",
              description:
                "A line showing what the gig is worth appears in the Work card below, once there's something to work it out from — an agreed amount on a fixed-fee gig, or a rate and a duration on an hourly one. Both live on the job, not here: this button opens the form where you set them, and the figure appears as soon as one of them is there.",
            },
          ],
        },
      ],
    },
    {
      action: "branch",
      branches: [
        {
          id: "hourly-gig",
          when: { type: "target-visible", target: HelpTarget.GigOverride },
          steps: [
            {
              action: "highlight",
              target: HelpTarget.GigOverride,
              title: "Override ($)",
              description:
                "For the hourly gig that didn't bill exactly rate × time — a minimum charged even though it ran short, a discount you gave on the day. An amount typed here replaces the computed figure everywhere pay is read from; clearing it brings the computed figure straight back. It's a statement about what THIS gig earned, which is why it lives here and not on the job that only says how the work is priced.",
            },
          ],
        },
        {
          id: "fixed-fee-gig",
          when: { type: "target-missing", target: HelpTarget.GigOverride },
          steps: [
            {
              action: "highlight",
              target: HelpTarget.JobPay,
              title: "This one is a fixed fee",
              description:
                "This gig is priced as a fixed fee, which is why the Work card below has no Override box. An hourly gig gets one, for the shift that didn't bill exactly rate × time — a minimum charged even though it ran short, a discount given on the day. A fixed fee needs none: the amount on this line is the answer, and Edit above is where you change it.",
            },
          ],
        },
      ],
    },
    {
      action: "highlight",
      target: HelpTarget.GigPayments,
      title: "Payments",
      description:
        "Where money you actually receive against this gig gets its own record — an amount, a date, a photo of the proof if you have one. One payment can cover several gigs at once, so what shows on each entry here is this gig's share of it, not necessarily the whole transfer. If you or a client ever need to check exactly what arrived and when, this is where to look.",
    },
  ],
};
