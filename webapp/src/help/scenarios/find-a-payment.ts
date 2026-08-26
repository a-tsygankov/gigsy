import { HelpTarget } from "../targets.ts";
import type { HelpScenario } from "../types.ts";

/**
 * The Money tab's payments half: the segmented control, the two things
 * that narrow the list, and the rows themselves.
 *
 * Deliberately the same shape as `find-a-gig`, for the same reason and
 * with the same stopping point. A `CardLink` row carries no identifier a
 * HelpTarget can read and a target resolves one static selector with no
 * runtime parameter (targets.ts), so no scenario can point at "this
 * payment"; the list's order changes with every payment recorded since
 * (newest first by `paidAt ?? createdAt`, `payment-filters.ts`). So this
 * explains how to narrow the list until the one you want is on it, and
 * hands over where a human can see which row is theirs.
 *
 * Every step is a `highlight`, and here that is not the usual
 * shared-database argument — `/payments` writes nothing at all. It is
 * that typing into `payment-search` would leave the filter in the query
 * string and the tour would end on a list narrowed by a word the user
 * did not choose. Nothing below changes what is on screen.
 *
 * It branches because the payments screen has the same three legitimate
 * states the gig list has, and Payments.tsx renders them off the same
 * pair of conditions:
 *
 *   - `payment-filters` is mounted whenever the account owns any
 *     payment at all (`all.length > 0`), independently of what the
 *     filter currently hides.
 *   - `payment-list` is mounted only while at least one row survives
 *     the filter (`rows.length > 0`), so its presence means "there is a
 *     payment here to open".
 *
 * One difference from `find-a-gig` worth knowing, because it is what
 * makes this scenario's CI branch deterministic without a fixture reset:
 * the gig list's filters are persisted server-side, which is why
 * `prepareHelpScenario` has to pin them back to defaults before every
 * run. These live in the query string (`useSearchParams`, Payments.tsx),
 * so `/payments` with no query IS the unfiltered list, every time,
 * whatever the last run left behind. `payments-hidden-by-filters` is
 * therefore unreachable from `startRoute` — it is here for the person
 * who narrowed the list themselves and reopened help, which is exactly
 * when they need it.
 */
export const findAPayment: HelpScenario = {
  id: "find-a-payment",
  title: "Find a payment",
  description:
    "Money in, on one list — searching it, filtering by what's still unassigned, and what a row is telling you.",
  category: "money",
  startRoute: "/payments",
  // `payments-showing` and nothing else: `/payments` opens unfiltered
  // (see the header), and `ensureAtLeastOnePayment` in help-fixtures.ts
  // guarantees the account owns a payment even on a freshly migrated
  // D1 — the same precondition `ensureAtLeastOneGig` makes for
  // `find-a-gig`, made by the fixture rather than hoped for from
  // whichever CI job happened to run first.
  expectedCiBranches: ["payments-showing"],
  steps: [
    {
      action: "branch",
      branches: [
        {
          id: "payments-showing",
          when: { type: "target-visible", target: HelpTarget.PaymentsList },
          steps: [
            {
              action: "highlight",
              target: HelpTarget.MoneySegment,
              title: "Money is two lists",
              description:
                "Payments is money that came IN; Expenses is money that went OUT. These are real pages, not a toggle — the back button works between them and a link to either one opens where you left it. Everything below is about the Payments half.",
            },
            {
              action: "highlight",
              target: HelpTarget.PaymentsSearch,
              title: "Search",
              description:
                "Matches the client's name, whatever you put in the payment's notes, and the amount as you would write it — typing 150 finds a $150.00 payment, and typing 1.50 does not, because the number you remember is the one off the bank statement, not the cents. It searches nothing else: there is no date here to type at.",
            },
            {
              action: "highlight",
              target: HelpTarget.PaymentsState,
              title: "Not yet allocated / Partly / Fully",
              description:
                "The one filter worth having, because it answers \"what money have I not accounted for yet\". A payment is allocated when you have said which job it paid for, and one payment can be split across several. Nothing stores this — it is the amount measured against the split you have entered so far — so a payment moves between these three on its own as you assign it. \"Not yet allocated\" is the pile that needs you.",
            },
            {
              action: "highlight",
              target: HelpTarget.PaymentsList,
              title: "Tap the one you want",
              description:
                "Newest first. Each row is the client — or \"No client yet\" — the date it arrived, how much, and where it stands on that allocation scale. An amber \"Not synced yet\" mark means the payment is safely saved on this device and still queued for the server. Tapping a row opens it for editing, including the split across jobs. Nothing on this list changes anything, so it is safe to browse. This walkthrough stops here: only you know which row is yours.",
            },
          ],
        },
        {
          id: "payments-hidden-by-filters",
          // The filter bar without the row wrapper — Payments.tsx
          // renders "No payment matches this filter" in exactly that
          // combination, and only ever when a filter is really on.
          when: { type: "target-visible", target: HelpTarget.PaymentsFilters },
          steps: [
            {
              action: "highlight",
              target: HelpTarget.PaymentsState,
              title: "Your filter is hiding everything",
              description:
                "You do have payments — none of them is in the state this is set to. Put it back to \"All payments\", or use the Clear button that appears beside it whenever anything is narrowing the list.",
            },
            {
              action: "highlight",
              target: HelpTarget.PaymentsSearch,
              title: "…and check the search box",
              description:
                "A word left in here narrows the list too, and it is easy to miss because it lives in the page address rather than on the row. Empty it and they come back.",
            },
          ],
        },
        {
          id: "no-payments-yet",
          // No filter bar at all means the account owns no payment —
          // the bar is unconditional on `all.length > 0`, so there is
          // nothing to search and no row to tap.
          when: { type: "target-missing", target: HelpTarget.PaymentsFilters },
          steps: [
            {
              action: "highlight",
              target: HelpTarget.PaymentsAdd,
              title: "Nothing recorded yet",
              description:
                "No money has been recorded as arriving, so there is no search box and no list. This button records one — and you can do it the moment the money lands, without deciding yet which job it was for. Saying that later is what the allocation filter above is about.",
            },
          ],
        },
      ],
    },
  ],
};
