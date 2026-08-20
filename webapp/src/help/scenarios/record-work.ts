import { HelpTarget } from "../targets.ts";
import type { HelpScenario } from "../types.ts";

/**
 * A fixed, synthetic gig id this scenario always starts on.
 *
 * `find-a-gig`'s header explains why no scenario can point at "a row in
 * the list": `CardLink`s carry no identifier a HelpTarget can read, and
 * the list's order changes with the saved sort, the date filters and
 * every gig anyone has added. Walking the Work card needs the opposite
 * of that — a screen that is reliably THERE, not one somebody chose —
 * so this scenario does not open a gig at all. It owns one, by id, and
 * `startRoute` below points straight at it.
 *
 * `webapp/e2e/help/help-fixtures.ts` upserts this exact id as an hourly,
 * not-yet-started gig before every run — the same "make the precondition
 * true" move `resetWorkingWeek` and `ensureAtLeastOneGig` already make
 * for other scenarios in that file, not a scenario writing its own data.
 * Hourly, specifically, is what keeps `GigOverride` reachable: the
 * override control only renders on an hourly gig (`WorkCard.tsx`'s
 * `isHourly && <HourlyOverride ...>`), so a fixed-fee fixture would
 * leave that step's target permanently unresolved.
 */
export const RECORD_WORK_GIG_ID = "11111111-1111-4111-a111-111111111111";

/**
 * The Work card, control by control — status, the clock, breaks, what
 * it's worth, and where actual payments live.
 *
 * Every step is a `highlight`, for the reason `create-gig.ts`'s header
 * gives at length: this runs in CI against a shared dev database, and
 * `performAction` really does fill, select and click. That file's form
 * is safe to leave half-filled because nothing writes until Save is
 * pressed; this card has no such backstop — WorkCard.tsx says so
 * plainly, "every control here writes... on change... on blur or
 * Enter", with no Save button at all. A `click` or `input` step here
 * would stamp a start time, change a status, or set an override on a
 * real record the instant the step ran. Nothing below does that.
 *
 * No branch, unlike `find-a-gig`. That scenario branches because the
 * gig list has three legitimate states depending on what the account
 * owns. This scenario owns its own gig outright (see
 * `RECORD_WORK_GIG_ID` above) and the fixture pins it to one shape
 * every run, so there is exactly one state for every target here to
 * resolve against — a branch would be modelling a choice nothing on
 * this screen actually makes.
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
 *     nothing about it is specific to recording work; it is a walk of
 *     its own the way Payments would be if this scenario were about
 *     money rather than the clock.
 *   - The Edit button onto the Job card's form. `create-gig` already
 *     walks that form field by field; a step here would only repeat it.
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
  startRoute: `/gigs/${RECORD_WORK_GIG_ID}`,
  steps: [
    {
      action: "highlight",
      target: HelpTarget.GigStatus,
      title: "Status",
      description:
        "lead → confirmed → completed, and it drives real behaviour, not just a label. A lead never blocks time on your public availability page and never reaches Google Calendar — it's an offer, not a commitment; confirmed does both. Completed is what the dashboard reads as work waiting to be paid. Cancelled pulls the gig out of your calendar, your availability and your reports without deleting the record. Whether it's actually been paid is worked out from Paid ($) on the job form, not set here.",
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
        "Stamps the finish the same way Start stamps the beginning, and stays disabled until there's a start to close. The span between the two — minus whatever you log as a break below — becomes the time this gig actually took, and on an hourly gig that's what gets multiplied by the rate instead of the planned duration.",
    },
    {
      action: "highlight",
      target: HelpTarget.GigBreak,
      title: "Off-time breaks (minutes)",
      description:
        "Minutes to subtract from the span between Start and Stop before anything gets priced — lunch, a delay, anywhere you weren't working. It only changes the figure once both stamps exist; log it early and it's still there, waiting for a span to apply to.",
    },
    {
      action: "highlight",
      target: HelpTarget.GigExpectedPay,
      title: "What it's worth",
      description:
        "Updates the instant anything above it changes. A fixed-fee gig just shows the agreed amount. An hourly one prices the time you've actually recorded once Start and Stop have both landed — before that, it quotes rate × the planned duration from the Job card instead, so there's always a figure here, not a blank.",
    },
    {
      action: "highlight",
      target: HelpTarget.GigOverride,
      title: "Override ($)",
      description:
        "For the hourly gig that didn't bill exactly rate × time — a minimum charged even though it ran short, a discount you gave on the day. An amount typed here replaces the computed figure everywhere pay is read from; clearing it brings the computed figure straight back. It's a statement about what THIS gig earned, which is why it lives here and not on the job that only says how the work is priced.",
    },
    {
      action: "highlight",
      target: HelpTarget.GigPayments,
      title: "Payments",
      description:
        "Where money you actually receive gets its own record — an amount, a date, a photo of the proof if you have one. Paid ($) on the Job form is the running total these add up to, and it's what the paid badge above and Reports' \"still owed\" figure actually read; adding a payment here doesn't update that total for you, so the two are worth keeping in step by hand.",
    },
  ],
};
