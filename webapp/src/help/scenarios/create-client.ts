import { HelpTarget } from "../targets.ts";
import type { HelpScenario } from "../types.ts";

/**
 * The client form, field by field — modelled directly on `create-gig`,
 * including the rule that matters most: every step is a `highlight`,
 * and the last one stops AT the save button without pressing it.
 *
 * This runs in CI on every PR against a shared dev database, so it may
 * not leave a record behind, and the only step that could is the save.
 * Stopping there is also the honest version for a person — what would
 * be written is their client, with a walkthrough's sample values in it.
 *
 * `/clients/new` is `isNew` (ClientEdit.tsx's `const isNew = id ===
 * "new"`), which renders the three fields and the two buttons
 * unconditionally and skips the client query entirely, so there is no
 * second legitimate state to branch on. `client-jobs` and
 * `client-delete` are the `!isNew`-only blocks and are deliberately not
 * part of this walkthrough: unlike `gig-services`/`gig-payments`, which
 * were changed to render an explanation on `/gigs/new`, neither has any
 * presence on the new-client form at all. They are described in prose on
 * the save step instead, which is the most a tour can honestly do about
 * a section that does not exist yet.
 *
 * The copy explains what a field is FOR. What it is called is already on
 * screen; what a client's name does to the gig list, Reports and your
 * calendar is not.
 */
export const createClient: HelpScenario = {
  id: "create-client",
  title: "Add a client",
  description:
    "Who you work for, and what recording them changes across the rest of Gigsy.",
  category: "money",
  startRoute: "/clients/new",
  steps: [
    {
      action: "highlight",
      target: HelpTarget.ClientName,
      title: "Name",
      description:
        "The only field a client actually needs — save with it blank and the form says so. It is what the gig form's Client dropdown lists, what Reports groups a year of work under, and what a gig with no title falls back to for a name in the list. It also goes into the title of every calendar event that gig creates, so write it the way you'd want to read it at 6am: \"Acme Staffing\", not \"acme (the new one)\".",
    },
    {
      action: "highlight",
      target: HelpTarget.ClientContact,
      title: "Contact",
      description:
        "One line, free text — a booker's email, a phone number, or both. It shows under the name on the Clients list, which is the whole point: it is there so you can reach them from the list without opening anything. Gigsy never sends anything to it; nothing here emails a client on your behalf.",
    },
    {
      action: "highlight",
      target: HelpTarget.ClientNotes,
      title: "Notes",
      description:
        "The things you only learn by working for someone twice — the rate they agreed, the invoice address, who to ask for at the loading dock, that they pay 60 days late. This one is private to this screen: it isn't searched, it isn't shown on the list, and it never reaches a calendar event.",
    },
    {
      action: "highlight",
      // Deliberately a highlight and never a click — see this file's
      // header. The save is the user's to press.
      target: HelpTarget.ClientSave,
      title: "Save it yourself",
      description:
        "Press \"Save client\" when the name says what you mean. This walkthrough stops here on purpose and will not press it for you: nothing is written until you do. Saving takes you back to the Clients list — and reopening the client from there gives you two things this blank form doesn't have yet: every job you've done for them, grouped into upcoming, completed-but-unpaid and paid, and a Delete button that leaves those gigs and their history intact.",
    },
  ],
};
