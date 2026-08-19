import { HelpTarget } from "../targets.ts";
import type { HelpScenario } from "../types.ts";

/**
 * The whole gig form, field by field.
 *
 * Every step is a `highlight`, including the last one, and that is a
 * constraint rather than an oversight. This scenario runs in CI on every
 * PR against a shared dev database, so it may not leave a record behind
 * — and the only step that could create one is the save. Stopping at
 * `gig-save` with a highlight is also the honest version for a person:
 * the same rule TourRenderer.ts is built around (the USER performs the
 * click) matters more here than anywhere else, because what would be
 * written is their record, with this walkthrough's sample values in it.
 *
 * `input` and `select` steps would be safe in the app — GigEdit holds
 * the form in React state and writes nothing until `submit` — but they
 * are not safe in the runner's hands for no benefit: `performAction`
 * really does fill and select, and a half-filled form is not what the
 * next reader of this scenario should have to reason about. Nothing
 * here needs the form to change state to explain the next field, so
 * nothing here changes it.
 *
 * `/gigs/new` is `isNew` (GigEdit.tsx's `const isNew = id === "new"`),
 * which skips the gig query entirely; the delete button below is the one
 * `!isNew`-only block on the form, and it is deliberately not part of
 * this walkthrough.
 *
 * One conditional IS on screen here: the form shows Offered ($) or Rate
 * ($ per hour) depending on `form.payType` (GigEdit.tsx). That still
 * isn't a second state for this scenario to branch on, because the form
 * loads with `payType: "fixed"` (GigEdit.tsx's `BLANK`) and nothing in
 * this walkthrough touches Paid by — every `highlight` step here leaves
 * state untouched, per the paragraph above — so `payType` never leaves
 * "fixed" and Offered ($) is what's on screen for the entire run. A
 * `GigRate` target would only ever resolve if the tour itself switched
 * pay types, which the highlight-only rule above rules out.
 *
 * The services and payments sections ARE part of it. They used to be
 * `!isNew` too, which meant the first gig anybody made was the one gig
 * whose form never mentioned either feature — and a tour could not fill
 * the gap, because explaining them needed a saved gig and a saved gig
 * needs this scenario to press save. They now render on `/gigs/new` as
 * explanation with no control attached, so the two steps below have a
 * target that exists before the record does.
 *
 * The copy explains what a field is FOR. What it is called is already
 * on screen; what `lead` does to your availability page is not.
 */
export const createGig: HelpScenario = {
  id: "create-gig",
  title: "Add a gig by hand",
  description:
    "What every field on the gig form is for, and which ones change how Gigsy behaves.",
  category: "gigs",
  startRoute: "/gigs/new",
  steps: [
    {
      action: "highlight",
      target: HelpTarget.GigTitle,
      title: "Title (optional)",
      description:
        "Optional, and usually worth leaving blank: a gig with no title is listed by the first line of its notes, or by the client's name when there are none. Type one when that isn't enough to tell two shifts for the same agency apart.",
    },
    {
      action: "highlight",
      target: HelpTarget.GigClient,
      title: "Client",
      description:
        "Who the work is for. Leaving it on \"No client\" is fine — the gig still saves — but a client is what groups this gig with the rest of their work in Reports, and what the list falls back to for a name.",
    },
    {
      action: "highlight",
      target: HelpTarget.GigStatus,
      title: "Status",
      description:
        "lead → confirmed → completed → paid, and it drives real behaviour. A lead never blocks time on your public availability page and never reaches Google Calendar — it is an offer, not a commitment. Confirmed does both. Completed is the one the dashboard reads as work waiting to be paid; paid closes it off.",
    },
    {
      action: "highlight",
      target: HelpTarget.GigDate,
      title: "Date & time — the day",
      description:
        "Pick the day here. A gig with no date at all still saves, it just can't block time or sync anywhere. Choosing a date before you've touched the time sets 09:00 rather than dropping the day you just picked — the box beside it is where you change that.",
    },
    {
      action: "highlight",
      target: HelpTarget.GigTime,
      title: "…and the time",
      description:
        "Any minute of the hour — 14:07 if that is when you start. The time is what the calendar event and your public availability page are built from, so it is worth getting right.",
    },
    {
      action: "highlight",
      target: HelpTarget.GigDurationHours,
      title: "Duration",
      description:
        "How long the job runs, in hours and minutes. It is what stops the calendar guessing four hours, what your public availability page subtracts from your free time, and — on an hourly gig — what the expected pay is calculated from until you record the time you actually worked.",
    },
    {
      action: "highlight",
      target: HelpTarget.GigLocation,
      title: "Location",
      description:
        "Where to actually turn up. \"Costco on 5th, booth 12\" beats a street address on the morning. It is free text, it shows on the gig's line in the list, and the search box on that list looks in here too.",
    },
    {
      action: "highlight",
      target: HelpTarget.GigUseCurrentLocation,
      title: "📍 Use current location",
      description:
        "Tap this while you are standing there: Gigsy asks your device for coordinates and has the server turn them into a place name. If that lookup fails you get the raw coordinates instead of nothing — still enough to find the loading bay again next time.",
    },
    {
      action: "highlight",
      target: HelpTarget.GigPayType,
      title: "Paid by",
      description:
        "A fixed fee pays what you agreed regardless of how long the job runs; an hourly rate prices it from rate × time instead, and swaps the Offered field below for a Rate ($ per hour) field, since a gig is never both at once. Switch it here whenever the deal changes.",
    },
    {
      action: "highlight",
      target: HelpTarget.GigOffered,
      title: "Offered ($)",
      description:
        "What a fixed-fee job pays — what was agreed, not what has arrived. While the gig is a lead or confirmed, this is what the dashboard adds up as Expected. Leave it blank if it hasn't been agreed yet; a zero is rejected, blank is the way to say \"not set\".",
    },
    {
      action: "highlight",
      target: HelpTarget.GigPaid,
      title: "Paid ($)",
      description:
        "What has actually landed. The gap between Offered and Paid on a completed gig is exactly what \"Unpaid — waiting on clients\" on the dashboard and \"Still owed\" in Reports are made of, so leaving this blank until the money is real is what keeps those numbers true.",
    },
    {
      action: "highlight",
      target: HelpTarget.GigWorkStart,
      title: "Started",
      description:
        "When the shift actually began — as opposed to the date and time near the top, which is what was agreed. On an hourly gig, once this and Finished are both filled in, Gigsy prices the shift on the real time worked instead of the booked duration.",
    },
    {
      action: "highlight",
      target: HelpTarget.GigWorkEnd,
      title: "Finished",
      description:
        "When it actually ended. Leave it blank while the shift is still in progress — a start with no finish yet is what open work looks like, not a mistake.",
    },
    {
      action: "highlight",
      target: HelpTarget.GigBreak,
      title: "Off-time breaks (minutes)",
      description:
        "Minutes not worked inside that span — a lunch break, a gap between two client visits. Subtracted before an hourly gig is priced; it has no effect on a fixed fee.",
    },
    {
      action: "highlight",
      target: HelpTarget.GigNotes,
      title: "Notes",
      description:
        "Anything you'll want on the day — parking, the contact's name, what the client asked for. Its first line doubles as the gig's name in the list whenever you left the title blank, so it's worth putting the useful bit first.",
    },
    {
      action: "highlight",
      target: HelpTarget.GigServices,
      title: "Additional services",
      description:
        "Work billed on top of the fee — the overtime hour, the second booth, the extra day. Each one is its own line with its own offered and paid amounts, which is why an unpaid extra still shows as owed after the gig's own fee has landed. Right now it only explains itself; a saved gig gets a \"+ Add service\" link here.",
    },
    {
      action: "highlight",
      target: HelpTarget.GigPayments,
      title: "Payments",
      description:
        "Money in the parts it actually arrives in — a deposit in March, the balance in May, each with its date and a photo of the proof. Paid ($) above is the total; this is the record of where that total came from, and what you show a client who says they already paid. It appears as a list you can add to once the gig is saved.",
    },
    {
      action: "highlight",
      // Deliberately a highlight and never a click — see this file's
      // header. The save is the user's to press.
      target: HelpTarget.GigSave,
      title: "Save it yourself",
      description:
        "Press \"Save gig\" when the form says what you mean. This walkthrough stops here on purpose and will not press it for you: nothing is written until you do. Saving takes you back to the gig list, with the new gig on it.",
    },
  ],
};
