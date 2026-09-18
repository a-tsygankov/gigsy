import { HelpTarget } from "../targets.ts";
import type { HelpScenario } from "../types.ts";

/**
 * The payment form, field by field — money IN, and which jobs it paid
 * for.
 *
 * Same shape and same rule as `add-expense` and `create-gig`: every
 * step is a `highlight`, and the last one stops AT the save button.
 * This scenario runs in CI on every PR against a shared dev database
 * and may not leave a record behind — and the only step that could is
 * the save.
 *
 * No branch: `/payments/new` is `isNew` (PaymentEdit.tsx), which
 * renders every field unconditionally and skips the payment query.
 * The delete button and the "queued photo" / "refused photo" lines are
 * the `!isNew`-or-stateful blocks and are not part of this walk.
 *
 * Three things on this form are read off the code rather than the
 * labels, because the labels cannot say them:
 *
 *   - The split rows (`payment-gig-0`, …) are each a GigPicker
 *     (components/GigPicker.tsx): a trigger opening a full-screen sheet
 *     with the Gigs tab's own search and filters over the client's
 *     gigs. The target is row 0's trigger, the one row always present;
 *     the sheet has no targets, for the reason targets.ts gives.
 *   - Auto-balance (lib/payment-split.ts's `applyAutoBalance`): while
 *     the split is untouched — one row, no amount typed, nothing added
 *     or removed — that row's amount simply IS the payment's. The
 *     figure is never asked for twice to record the ordinary one-gig
 *     payment, and it stops mirroring the moment the split is edited.
 *   - "Unallocated" is allowed to be positive (`unallocatedCents`): a
 *     transfer can be saved before you know which gigs it covers.
 *     Over-allocation is the one refused case, and the form says so
 *     as soon as the split does, not only on Save.
 *
 * The confirmation is a FilePicker (components/FilePicker.tsx) held
 * until Save, then handed to the offline queue (lib/local-store.ts's
 * `queueImage`) — so it can be attached on a job site with no signal
 * and goes up when there is one. The step says that rather than
 * "upload".
 */
export const recordAPayment: HelpScenario = {
  id: "record-a-payment",
  title: "Record a payment",
  description:
    "Money that arrived: how much, from whom, which jobs it paid for, and the proof.",
  category: "money",
  startRoute: "/payments/new",
  steps: [
    {
      action: "highlight",
      target: HelpTarget.PaymentAmount,
      title: "Amount ($)",
      description:
        "What actually landed, in dollars — the figure off the bank statement or the cash in hand. It is the one field a payment can't do without: blank, zero or not a number is refused. Enter it as you'd say it — 150.00. If it paid for one job, this is also the last time you type it: the row below takes the whole amount on its own until you start splitting.",
    },
    {
      action: "highlight",
      target: HelpTarget.PaymentClient,
      title: "From client",
      description:
        "Who sent it. Setting this does two things: it narrows the gig picker below to that client's jobs, which is what makes the list readable, and it locks the split to them — a payment from one client can't be put against another client's gig. \"Not set — every gig\" is allowed and offers everything; it is the escape hatch for a transfer you can't yet attribute. Change the client later and any row that no longer belongs is cleared, not silently kept.",
    },
    {
      action: "highlight",
      target: HelpTarget.PaymentGig,
      title: "Paid for",
      description:
        "Which job this money was for. Tap it to search your gigs by title, client or location, with the same filters and sort the Gigs tab has — the row you pick shows the gig's name on one line and its client, date, place and status beneath, so two \"Tasting\" shifts for two agencies can be told apart. Beside it is how much of the payment went to that job. Leave the amount alone and it mirrors the total for a one-job payment; type into it and you are splitting. The ✕ removes a row, and the last row is emptied rather than removed.",
    },
    {
      action: "highlight",
      target: HelpTarget.PaymentAddSplit,
      title: "+ Add gig",
      description:
        "One transfer that covered several jobs — an agency paying three shifts at once. Each press adds another row: pick the gig, type its share. The shares can't add up to more than the payment, every row needs both a gig and an amount, and every row must belong to the client above (or to any client, when none is set). What each job has been paid is added up from these rows, which is what turns a gig's status badge to \"paid\" — there is no field for that anywhere else.",
    },
    {
      action: "highlight",
      target: HelpTarget.PaymentUnallocated,
      title: "Fully allocated / Unallocated",
      description:
        "The payment measured against the rows above. \"Fully allocated\" means every dollar has a job; \"Unallocated $40.00\" means some hasn't been assigned yet — and that is fine to save. A transfer can be recorded the moment it lands and attributed later; the Money tab's \"Not yet allocated\" filter is how you find it again. What can't be saved is the other direction: rows adding up to more than arrived, which the form refuses as soon as the split says so.",
    },
    {
      action: "highlight",
      target: HelpTarget.PaymentPaidAt,
      title: "Received on",
      description:
        "When the money arrived. Tap this to open a calendar with a time box under it — the same control the gig form uses. It orders the Money tab (newest first) and it is the date Reports count the payment under, so a January transfer for December work counts in January. Leave it empty and the list falls back to when you recorded it.",
    },
    {
      action: "highlight",
      target: HelpTarget.PaymentNotes,
      title: "Notes",
      description:
        "How it arrived and anything the amount won't remember — Zelle, cash, the check number, a reference from the remittance. The Money tab's search box looks in here, so \"check 1042\" is findable later.",
    },
    {
      action: "highlight",
      target: HelpTarget.PaymentConfirmation,
      title: "Confirmation (photo or mail)",
      description:
        "The proof: a photo of the check or the cash, a screenshot of the transfer, or the .eml of the remittance email. \"Choose File\" opens your photo library, your files and — on a phone — the camera. Nothing is sent when you choose it; it is held until you save, then attached from this device. No signal? It waits here and goes up when there is one, with a note under it saying so. One file per payment: choosing another replaces it.",
    },
    {
      action: "highlight",
      // Deliberately a highlight and never a click — see this file's
      // header. The save is the user's to press.
      target: HelpTarget.PaymentSave,
      title: "Save it yourself",
      description:
        "Press \"Save payment\" when the amount and the split are right. This walkthrough stops here on purpose and will not press it for you: nothing is written until you do. Saving works offline — the record is on this device at once and reaches the server when it can — and opens the saved payment, where the proof's upload progress is shown against it. Cancel from there goes back to the job when the payment was for exactly one gig, or to the Money tab otherwise.",
    },
  ],
};
