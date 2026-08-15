import { HelpTarget } from "../targets.ts";
import type { HelpScenario } from "../types.ts";

/**
 * The expense form, field by field. Same shape and same rule as
 * `create-client` and `create-gig`: every step is a `highlight`, and the
 * last one stops AT the save button. This scenario runs in CI on every
 * PR against a shared dev database and may not leave a record behind —
 * and the only step that could is the save.
 *
 * No branch: `/expenses/new` is `isNew` (ExpenseEdit.tsx), which renders
 * every field unconditionally and skips the expense query. The delete
 * button is the one `!isNew`-only block and is not part of this
 * walkthrough.
 *
 * Two fields here do something the label cannot say, and both are read
 * off the reports service rather than guessed:
 *
 *   - "The client should cover this" (`reimbursable`) does NOT change
 *     net. `backend/src/services/reports.ts` computes `netCents =
 *     paidCents - expensesCents` regardless of the flag, and sums the
 *     ticked ones separately into `reimbursableCents`, which Reports
 *     shows as its own "Billable to client" tile. Its own comment says
 *     why: the flag records an expectation of reimbursement, not money
 *     received, so net stays the conservative figure. The step below
 *     says that instead of restating the checkbox.
 *   - "Linked gig" decides which MONTH an expense lands in — the report
 *     buckets expenses on `COALESCE(g.date_time, e.created_at)` — and
 *     whether it appears at all once a report is filtered to one client,
 *     since that filter turns the LEFT JOIN onto gigs into an inner one.
 */
export const addExpense: HelpScenario = {
  id: "add-expense",
  title: "Add an expense",
  description:
    "Parking, supplies, mileage — and the two fields that decide what an expense does to your reports.",
  category: "money",
  startRoute: "/expenses/new",
  steps: [
    {
      action: "highlight",
      target: HelpTarget.ExpenseAmount,
      title: "Amount ($)",
      description:
        "What it cost you, in dollars. This is the one field an expense can't do without: a blank, a zero or anything that isn't a number is refused, because an expense of nothing isn't a record of anything. Enter it as you'd say it — 23.50.",
    },
    {
      action: "highlight",
      target: HelpTarget.ExpenseCategory,
      title: "Category",
      description:
        "Free text, and it is what this expense is CALLED — the Expenses list shows the category as the row's headline, or \"Uncategorized\" when you leave it blank. There is no fixed list and nothing groups by it yet, so the value of keeping \"parking\" spelled the same way every time is entirely yours: it's what makes the exported CSV sortable at tax time.",
    },
    {
      action: "highlight",
      target: HelpTarget.ExpenseGig,
      title: "Linked gig",
      description:
        "Which job you were on when you spent it, and it changes two things in Reports. A linked expense is counted in its GIG's month — the day of the job, not the day you typed it in — so a receipt entered a fortnight late still lands against the work it belongs to; an unlinked one falls back to the day you added it. And when you filter a report to one client, only expenses that reach that client through a linked gig are counted at all: leave this on \"Not linked\" and the expense silently drops out of every per-client figure. Fine for a box of business cards. Not fine for the parking at their venue.",
    },
    {
      action: "highlight",
      target: HelpTarget.ExpenseNotes,
      title: "Notes",
      description:
        "Whatever the amount won't remember on its own — which lot, how many miles, what the supplies were for. Nothing else reads this; it is there for the version of you that gets asked about a charge four months from now.",
    },
    {
      action: "highlight",
      target: HelpTarget.ExpenseReimbursable,
      title: "The client should cover this",
      description:
        "Tick this and the amount is added up separately, as the \"Billable to client\" figure in Reports, and the row here gets a \"billable to client\" note. What it deliberately does NOT do is add the money back: your net is still everything paid minus everything spent, whether this is ticked or not. That is on purpose — the tick records that you EXPECT to be reimbursed, not that you have been, and Gigsy would rather understate what you've earned than count money that hasn't arrived. It also doesn't tell the client anything or raise an invoice: billing them is still yours to do. When they do pay it back, that's money in — record it against the gig, not by unticking this.",
    },
    {
      action: "highlight",
      // Deliberately a highlight and never a click — see this file's
      // header. The save is the user's to press.
      target: HelpTarget.ExpenseSave,
      title: "Save it yourself",
      description:
        "Press \"Save expense\" when the amount is right. This walkthrough stops here on purpose and will not press it for you: nothing is written until you do. Saving takes you back to the Expenses list, with this one on it — and opening it again lets you change anything here, or delete it.",
    },
  ],
};
