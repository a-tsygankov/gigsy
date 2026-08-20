import { HelpTarget } from "../targets.ts";
import type { HelpScenario } from "../types.ts";

/**
 * Finding an existing gig and opening it — and stopping there.
 *
 * This is deliberately not "edit a gig". A tour cannot open one for
 * you: the rows are `CardLink`s carrying no identifier of their own
 * (Gigs.tsx), a HelpTarget resolves one static CSS selector with no
 * runtime parameter (targets.ts), and `GigEdit`'s save navigates back
 * to `/gigs`, so no gig id is ever exposed anywhere a scenario could
 * read one. The only way to point at a row would be a positional
 * selector — "the first card" — and the list's order changes with the
 * saved sort, the date filters and every gig added since. That is a
 * spotlight on a different person's shift each run, and a scenario that
 * says "tap this one" about a row nobody chose. So this scenario
 * explains how to narrow the list until the gig you want is on it, and
 * hands over at the point where a human can see which row is theirs.
 *
 * Every step is a `highlight`. `gig-search` in particular is described
 * rather than typed into: filling it narrows the list, and the first
 * `setFilters` call of a session also posts the saved view back to the
 * server (Gigs.tsx's `lastWritten` skips only the repeats). Nothing
 * here writes anything.
 *
 * It branches because the gig screen has three legitimate states and
 * two of them have no row to tap:
 *
 *   - `gig-list` is mounted only while at least one row is showing
 *     (Gigs.tsx wraps the rows in it under `visible.length > 0`), so
 *     its presence means "there is a gig here to open", not merely
 *     "the gig screen rendered".
 *   - `gig-filters` is mounted whenever the user owns any gig at all
 *     (`all.length > 0`), independently of what the filters currently
 *     hide.
 *
 * So filters-with-a-list is "gigs showing", filters-without-a-list is
 * "you have gigs, the filters are hiding them", and no filters at all
 * is "nothing here yet". Confirmed against Gigs.tsx rather than assumed.
 *
 * Branch conditions are checked before the user has done anything —
 * both adapters agree there (docs/help/README.md §2) — but they are
 * still racing the gig query on a cold open, since "no gig-filters yet"
 * looks identical to "no gigs at all" for as long as the list is
 * loading. Both adapters debounce a candidate before committing to it
 * (`settleBranch`, `resolveBranch`), which is what makes that
 * survivable, and it is the same shape `configure-working-hours`
 * already relies on for `start-day-0`. Worth knowing about rather than
 * worth a positional target.
 */
export const findAGig: HelpScenario = {
  id: "find-a-gig",
  title: "Find a gig and open it",
  description:
    "Search, filters, and the list itself — how to get to one gig among hundreds.",
  category: "gigs",
  startRoute: "/gigs",
  // Empirical, not assumed — run and observed, then made deterministic.
  // The shared dev user owns several hundred gigs, so the list has rows;
  // what it does NOT have on its own is a predictable *view*, because
  // the gig-list filters are persisted server-side for that same user
  // and `test:e2e`'s gig-list.spec.ts writes them. A left-behind date
  // range or status chip is enough to empty the list and send this
  // scenario down `gigs-hidden-by-filters` instead. So
  // `prepareHelpScenario` now pins the saved view back to defaults
  // before every run, the same way it already pins the working week —
  // and with that in place `gigs-showing` is the branch CI takes.
  // Recorded here so that if the fixture, the seed data or the default
  // view ever stops being true, the suite fails instead of quietly
  // exercising one of the empty branches.
  expectedCiBranches: ["gigs-showing"],
  steps: [
    {
      action: "branch",
      branches: [
        {
          id: "gigs-showing",
          when: { type: "target-visible", target: HelpTarget.GigList },
          steps: [
            {
              action: "highlight",
              target: HelpTarget.GigSearch,
              title: "Search",
              description:
                "The fastest way in. It matches the title, the location, the notes and the client's name, so half a venue or a phrase you remember typing is usually enough. Whatever you type stays put while you open a gig and come back.",
            },
            {
              action: "highlight",
              target: HelpTarget.GigFiltersToggle,
              title: "Filters",
              description:
                "For when you can't remember the words but do remember the shape of it: status, client, a date range, and \"hide past gigs\". While anything is narrowing the list, a \"Showing 3 of 40\" count appears beside this button and a Clear filters button appears inside it. Filters are saved, so the list looks the same next time and on your other devices.",
            },
            {
              action: "highlight",
              target: HelpTarget.GigList,
              title: "Tap the one you want",
              description:
                "Every row here opens that gig's own screen: what the job is — client, when, where, how it pays — as a card with an Edit button onto the form \"Add a gig by hand\" walks through, and under it the work half, where you set the status, start and stop the clock and see what it earned. Its services, its payments and the delete button are down there too. Nothing on this list changes a gig, so it is safe to browse. This walkthrough stops here: only you know which row is yours.",
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
                "You do have gigs — none of them matches what is set right now. Open this panel and widen it: a date range drops every undated gig, \"hide past gigs\" drops everything before today, and Clear filters puts all of it back at once.",
            },
            {
              action: "highlight",
              target: HelpTarget.GigSearch,
              title: "…and check the search box",
              description:
                "Search narrows the list too, and it survives leaving the screen and coming back, so it is easy to forget something is still in it. Empty it and the rows return — then tap the one you want to open it for editing.",
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
              title: "Nothing to find yet",
              description:
                "There are no gigs on this account, so there is no search box and no list. Add one with this button — \"Add a gig by hand\" walks through the form — and the search and filters appear here as soon as there is something to narrow.",
            },
          ],
        },
      ],
    },
  ],
};
