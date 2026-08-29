import { HelpTarget } from "../targets.ts";
import type { HelpScenario } from "../types.ts";

/**
 * Billing one client for the work they have not paid for.
 *
 * The tour cannot pick the client — that is the one decision only the
 * user can make, and the same shape `record-work` has with the gig
 * list. So it explains the two filters, then branches on whether a
 * client has actually been chosen, and only walks the document on the
 * branch where one has.
 *
 * The branch reads `invoice-needs-client`, a hint that is RENDERED when
 * no client is selected, rather than the Create invoice button's
 * disabled state. A help condition must read something present: an
 * absence is also true while a screen is loading, which is the bug
 * `no-gigs-yet` was fixed for.
 *
 * Every step is a `highlight` except the hop. Nothing here writes —
 * the report filters are component state, and the invoice number is
 * only spent when the user presses Create invoice themselves.
 *
 * ── A gap this scenario ships with ──
 *
 * CI always takes `invoice-needs-client`. `help-runner.ts` performs
 * highlight steps without choosing anything, and a `select` step cannot
 * name a client id statically — they are per-account UUIDs. So the
 * navigate step, `invoice-document` and `invoice-print` are PROSE in
 * CI: rename one of those test ids and the suite stays green. That is
 * docs/help/README.md §6's category, and it is recorded there too.
 * `expectedCiBranches` is pinned so that the day CI starts taking the
 * other branch, the assertion fails and someone looks at why.
 *
 * ── Why there is no step for the total ──
 *
 * `invoice-total` (Invoice.tsx) is absent whenever the document is
 * empty — not just when the client has no unpaid work at all, but also
 * when their only completed work in the period is unpriced. That
 * second case is real and reachable from this very branch: it does not
 * fail the button-side check in Reports.tsx (which only refuses to
 * navigate when lines, expenses AND unpriced gigs are all empty), so
 * it opens exactly this document with no total to spotlight. A step
 * aiming at `invoice-total` would end that person's tour with "This
 * help step is currently unavailable" — CI would never see it, because
 * CI never reaches this branch at all. So the document step below
 * carries what the total means as well as what the lines are, and
 * there is no separate `invoice-total` target in targets.ts.
 */
export const createInvoice: HelpScenario = {
  id: "create-invoice",
  title: "Invoice a client",
  description:
    "Turn one client's unpaid work into a numbered invoice you can save as a PDF and send.",
  category: "money",
  startRoute: "/reports",
  // Empirical: the runner never selects a client, so the hint is always
  // the branch that holds. See the gap described above.
  expectedCiBranches: ["invoice-needs-client"],
  steps: [
    {
      action: "highlight",
      target: HelpTarget.ReportRange,
      title: "Pick the period",
      description:
        "An invoice covers the work in whatever range is set here — a month, a quarter, or a custom span. Only unpaid work inside it ends up on the bill, so this is what decides which shifts you are asking to be paid for.",
    },
    {
      action: "highlight",
      target: HelpTarget.ReportClient,
      title: "Choose who you are billing",
      description:
        "An invoice is addressed to one client, so \"All clients\" will not do. Pick the agency you are billing and the Invoice section below turns into a button.",
    },
    {
      action: "branch",
      branches: [
        {
          id: "invoice-needs-client",
          when: { type: "target-visible", target: HelpTarget.InvoiceNeedsClient },
          steps: [
            {
              action: "highlight",
              target: HelpTarget.InvoiceNeedsClient,
              title: "Pick a client first",
              description:
                "No client is selected yet, so there is nobody to address an invoice to. Choose one in the Client box above — then start this walkthrough again and it will carry on to the document itself.",
              end: true,
            },
          ],
        },
        {
          id: "invoice-ready",
          when: { type: "target-visible", target: HelpTarget.InvoiceCreate },
          steps: [
            {
              action: "navigate",
              target: HelpTarget.InvoiceCreate,
              route: "/reports/invoice",
              title: "Create the invoice",
              description:
                "This takes the next number in your sequence and opens the finished document. If the client truly has nothing to bill in the period, it says so here instead of opening anything, and the number is left unspent.",
            },
            {
              action: "highlight",
              target: HelpTarget.InvoiceDocument,
              title: "What the client will see",
              description:
                "Your business details at the top, the client's beneath, then a line for every unpaid gig — each billed for what is still owed on it, not the whole fee — with any extra services under their gig and reimbursable expenses after the work. The total at the bottom is exactly what this client still owes for the period, so a part-paid gig contributes only its remainder and you never ask twice for money you have already had. Anything blank up there comes from Settings, under Business details.",
            },
            {
              action: "highlight",
              target: HelpTarget.InvoicePrint,
              title: "Save it as a PDF",
              description:
                "This opens your browser's own print dialog; choose \"Save as PDF\" as the destination and you have a file to send. Printing uses the browser's fonts, so any alphabet comes out right — and the app's header, tabs and this button are all left off the page.",
            },
          ],
        },
      ],
    },
  ],
};
