import { HelpTarget } from "../targets.ts";
import type { HelpScenario } from "../types.ts";

/**
 * Connecting Google Calendar — half in the app, half in a Google window
 * no page can reach.
 *
 * EXECUTABLE, with `external` steps for the half that isn't. This is the
 * opposite call from `install-app`, and the difference is where the
 * scenario's own targets live. Installation has none: every step of it
 * happens in browser or OS chrome, so there is nothing for a runner to
 * resolve and `executable: false` plus `variants` is the only honest
 * shape. This scenario's first, and every step but the consent popup, is
 * a real element on the dashboard — `calendar-section`,
 * `calendar-action`, `calendar-disconnect` — so making it non-executable
 * would retire genuine coverage of three targets to say nothing more.
 * The one genuinely undrivable step is `requestCalendarCode`'s Google
 * consent popup (Dashboard.tsx's `connect` mutation), and the model
 * already has an action for exactly that. validate.ts allows the mix: it
 * only rejects an executable scenario whose steps are ALL external.
 *
 * It branches because Dashboard.tsx renders two different cards. The
 * copy differs ("Connected ✓ — confirmed gigs sync every 15 min" versus
 * "Put confirmed gigs on your calendar automatically"), the one button
 * says "Sync now" instead of "Connect", and `calendar-disconnect` only
 * exists while connected — which is what makes it a truthful condition
 * for "is this account linked", rather than merely "the card rendered".
 * The branch sits before any interaction, so the tour renderer and the
 * Playwright runner resolve it identically (docs/help/README.md §2).
 *
 * `expectedCiBranches: ["calendar-unlinked"]`: the hermetic local stack
 * has no Google credentials and the dev user has never connected — `GET
 * /api/calendar/status` returns `{"connected":false}` there, confirmed
 * against the running local worker and then by running `help:test`
 * three times in a row. If that ever changes, this assertion fails
 * rather than quietly testing the other branch.
 *
 * What it does NOT do is walk the calendar settings. `toggle-prefix`,
 * `select-reminder`, `create-dedicated` and `force-resync` are on
 * `/settings`, this scenario starts on `/`, and there is no navigate
 * step — HelpProvider cancels a running tour the moment the route
 * changes out from under it, deliberately, because a tour that outlives
 * navigation spotlights detached nodes. So those four are named in
 * prose, with their address, which is the most a single-route tour can
 * honestly do for them.
 *
 * The sync rules below are read off backend/src/calendar/sync-service.ts
 * and backend/wrangler.toml's `crons`, not off the UI copy.
 */
export const connectCalendar: HelpScenario = {
  id: "connect-calendar",
  title: "Connect Google Calendar",
  description:
    "Put confirmed gigs on your calendar automatically — what syncs, what never does, and how to disconnect.",
  category: "settings",
  // The card lives at the bottom of the dashboard; the Connect button is
  // nowhere else in the app.
  startRoute: "/",
  expectedCiBranches: ["calendar-unlinked"],
  steps: [
    {
      action: "highlight",
      target: HelpTarget.CalendarSection,
      title: "What actually syncs",
      description:
        "Only CONFIRMED gigs that have a date ever become calendar events. A lead never does — it's an offer, not a commitment, and your calendar shouldn't fence off an afternoon for it. Completed and paid gigs keep the events they already had, as history. Demote a gig back to lead, or clear its date, and Gigsy removes the event it made. Connecting here asks Google for one thing only — permission to manage events — so this traffic is one-way. Letting Gigsy READ when you're already busy is a separate decision, asked for separately, under Settings → Availability.",
    },
    {
      action: "highlight",
      target: HelpTarget.CalendarSection,
      title: "…and for how long",
      description:
        "An event runs from the gig's time for as long as its Duration says. A gig with no duration set is assumed to take four hours, so a ninety-minute tasting fences off an afternoon until you tell it otherwise — the same four hours your public availability page blocks out, deliberately, so the two can never disagree. The event's title is the client and the location; its description is your notes.",
    },
    {
      action: "branch",
      branches: [
        {
          // `calendar-disconnect` is rendered only under
          // `status.data.connected` (Dashboard.tsx), so its presence is
          // the connection state — no need to read a button's label.
          id: "calendar-linked",
          when: { type: "target-visible", target: HelpTarget.CalendarDisconnect },
          steps: [
            {
              action: "highlight",
              target: HelpTarget.CalendarAction,
              title: "Already connected — this is Sync now",
              description:
                "Gigsy syncs by itself every fifteen minutes, so you rarely need this. It's for the moment after you've confirmed a gig and want it on your phone's calendar before you put the phone down. It tells you what it did — how many events it added, updated or removed — and if the answer is \"nothing\", it says that too, because \"nothing appeared in my calendar\" is usually a gig that is still a lead rather than anything broken.",
            },
            {
              action: "highlight",
              target: HelpTarget.CalendarDisconnect,
              title: "Disconnecting",
              description:
                "This hands back Gigsy's permission to write to your calendar. Events it already created STAY where they are — disconnecting is not an undo, and if you want them gone you delete them in Google. Reconnecting later is this same card again. It's also the cure for one specific failure: if syncing starts reporting that Google refused the changes, the connection has lost permission, and disconnect-then-reconnect is what fixes it.",
            },
            {
              action: "highlight",
              target: HelpTarget.CalendarSection,
              title: "The rest lives in Settings",
              description:
                "Four things shape what this writes, all under Settings → Calendar. \"Prefix event titles\" puts \"Gigsy:\" in front of each one so your work stands out among personal entries, at the cost of title width on a phone. \"Remind me\" attaches your own reminder to every gig — gigs mean travel — or you can leave your calendar's own defaults alone instead. \"Separate Gigsy calendar\" creates a dedicated calendar and moves existing events onto it, so you can hide or share work on its own. And \"Re-sync everything\" reconsiders every gig you have on the next pass, for when the calendar looks wrong rather than merely out of date.",
            },
          ],
        },
        {
          id: "calendar-unlinked",
          when: { type: "target-missing", target: HelpTarget.CalendarDisconnect },
          steps: [
            {
              action: "highlight",
              target: HelpTarget.CalendarAction,
              title: "Connect",
              description:
                "Pressing this opens a Google window and asks for one permission: to manage events on your calendar. Gigsy needs it to create, move and remove the events for your confirmed gigs. This walkthrough won't press it for you — nothing is granted until you do.",
            },
            {
              action: "external",
              externalType: "browser-ui",
              title: "Google's window takes over",
              description:
                "What opens next is Google's, not Gigsy's — no part of this app can highlight it, fill it in, or read it. Pick the account whose calendar you want your gigs on (it does not have to be the one you sign into Gigsy with), read what is being asked for, and choose Allow. The window closes itself when you're done.",
            },
            {
              action: "external",
              externalType: "browser-ui",
              title: "If nothing happens",
              description:
                "That window is a popup, so a popup blocker can swallow it — look for a blocked-popup icon near the address bar and allow it for this site. Closing the window, or choosing Cancel, connects nothing and changes nothing: press Connect again whenever you like.",
            },
            {
              action: "highlight",
              target: HelpTarget.CalendarSection,
              title: "Afterwards",
              description:
                "Once it's connected this card says so, tells you when it last synced, and grows a Disconnect link; the button becomes \"Sync now\". Your confirmed gigs go over within fifteen minutes without you doing anything. Then, under Settings → Calendar, four options shape what gets written: a \"Gigsy:\" title prefix, your own reminder time (or your calendar's existing defaults), a separate Gigsy calendar you can hide or share on its own, and a re-sync that reconsiders every gig if the result ever looks wrong.",
            },
          ],
        },
      ],
    },
  ],
};
