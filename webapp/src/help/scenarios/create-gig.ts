import { HelpTarget } from "../targets.ts";
import type { HelpScenario } from "../types.ts";

/**
 * The whole job form, field by field.
 *
 * What this walk covers shrank in Phase 3, and not by choice: the gig
 * screen split in two. `/gigs/new` and `/gigs/:id/edit` are now the JOB
 * — who it is for, when, where, how it pays — while the status, the
 * work log, the services, the payments and the delete button live on
 * the detail hub at `/gigs/:id` (GigDetail.tsx). None of those exists on
 * the empty form this scenario starts on, and every step here is a
 * highlight that cannot save a gig to reach them (see below), so they
 * are simply not walkable from here. `scenarios/record-work.ts` covers
 * them properly, starting on a gig of its own rather than one this
 * scenario would have to save.
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
 * which skips the gig query entirely. Since the split there is no
 * `!isNew`-only block left on the form at all — the delete button that
 * used to be the exception is on the hub now — so every target below
 * resolves on the empty form as well as on a saved one.
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
 * The services and payments sections USED to be part of it. They had
 * been given an explain-only state on `/gigs/new` precisely so this
 * walk could reach them, because explaining them needs a saved gig and
 * a saved gig needs this scenario to press save. That state is gone:
 * both sections moved to the hub with the rest of the "a gig that
 * exists" half, where they can carry the real list and its "+ Add …"
 * link instead of a paragraph about a control that is not there. The
 * two steps went with them, to `record-work`.
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
      target: HelpTarget.GigDateTime,
      title: "Date & time",
      description:
        "Tap this to open a calendar with a time box under it. A gig with no date at all still saves, it just can't block time or sync anywhere. Picking a day before you've touched the time sets 09:00 rather than dropping the day you just chose, and the time box takes any minute of the hour — 14:07 if that is when you start. Both are what the calendar event and your public availability page get built from, so they are worth getting right. \"Clear\" empties the whole thing; a time with no day is not a moment.",
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
      target: HelpTarget.GigNotes,
      title: "Notes",
      description:
        "Anything you'll want on the day — parking, the contact's name, what the client asked for. Its first line doubles as the gig's name in the list whenever you left the title blank, so it's worth putting the useful bit first.",
    },
    {
      action: "highlight",
      // Deliberately a highlight and never a click — see this file's
      // header. The save is the user's to press.
      target: HelpTarget.GigSave,
      title: "Save it yourself",
      description:
        "Press \"Save gig\" when the form says what you mean. This walkthrough stops here on purpose and will not press it for you: nothing is written until you do. Saving opens the gig's own screen, where its status, the hours you actually work, its extra services and its payments all live.",
    },
  ],
};
