/**
 * Which gigs have a delivery stage at all (docs/superpowers/specs/
 * 2026-09-20-optional-delivery-design.md).
 *
 * `delivered` is a real stage for some work — a photo shoot is not
 * finished until the files are handed over — and a stage that does not
 * exist for the rest. The app used to assume every completed gig was
 * waiting for it: the status control offered `delivered` on all of them,
 * and the dashboard's "To deliver" tile counted all of them. The user
 * does not want to answer "does this one get delivered?" on every gig
 * form, so the answer is read off the CLIENT, with a setting behind it
 * for the gigs that have none.
 *
 * Pure functions over the narrowest slices of the records they need, so
 * a screen can call them with whatever it already holds and a test can
 * call them with a literal. Nothing here is cached and nothing is copied
 * onto gigs: flipping a client's switch changes the answer for every one
 * of that client's gigs on the next render, which is exactly what someone
 * wants after realising it was set wrong.
 *
 * The server applies the SAME rule to `awaitingDeliveryCount`
 * (backend/src/services/dashboard.ts). Keep the two in step; the
 * dashboard tile and the status control must agree about which gigs are
 * waiting.
 */
import type { Settings } from "./settings-schema.ts";
import type { Client, Gig, GigStatus } from "./types.ts";
import { GIG_STATUSES } from "./types.ts";

/**
 * Does this gig's finished work still have to be handed over?
 *
 * - A gig WITH a client answers with that client's `needsDelivery`.
 * - A gig with NO client answers with the `clientsExpectDelivery`
 *   setting — the only thing that can speak for it.
 * - A client id that matches nothing in `clients` is treated like no
 *   client: the list may simply not have loaded yet, and the setting is
 *   the honest fallback until it does. Treating it as "no" would hide
 *   `delivered` on a deliverable gig for the frames before the query
 *   resolved.
 * - `settings` undefined (still loading, or failed) answers false, which
 *   is the setting's own server default — so a cold start reads the same
 *   as a user who never touched the switch.
 */
export function isDeliverable(
  gig: Pick<Gig, "clientId">,
  clients: readonly Pick<Client, "id" | "needsDelivery">[],
  settings: Pick<Settings, "clientsExpectDelivery"> | undefined,
): boolean {
  const fallback = settings?.clientsExpectDelivery ?? false;
  if (gig.clientId === null) return fallback;
  const client = clients.find((c) => c.id === gig.clientId);
  return client === undefined ? fallback : client.needsDelivery;
}

/**
 * The statuses the status control lists for a gig.
 *
 * All five when the gig is deliverable. Otherwise `delivered` is left
 * out — the control stops at `completed` — with one exception: a gig
 * ALREADY marked `delivered` keeps it, because a stored value is never
 * hidden. A `<select>` whose current value is not among its options
 * renders the first option instead and lies about the record; and the
 * record may legitimately say `delivered` from before the client's
 * switch was turned off.
 *
 * Takes the current status rather than the gig so the caller decides
 * what "current" is (the saved record, on WorkCard) and the function
 * stays a pure list.
 */
export function offeredStatuses(current: GigStatus, deliverable: boolean): GigStatus[] {
  if (deliverable || current === "delivered") return [...GIG_STATUSES];
  return GIG_STATUSES.filter((s) => s !== "delivered");
}

/**
 * Whether `status` is the LAST step this gig will take — what the
 * status pill reads as "finished" (components/StatusPill.tsx's `final`).
 *
 * `completed` is final exactly when the gig is not deliverable: there is
 * nothing left to hand over, so the work is done, and a pill that still
 * reads amber — "something to do" — on it is wrong everywhere it
 * appears. On deliverable work `completed` is the penultimate step and
 * stays amber; `delivered` is a stage of its own with its own hue and
 * is not what this function is about. One rule here rather than the
 * expression `!deliverable && status === "completed"` repeated in every
 * row, trigger and hub that draws a pill.
 */
export function isFinal(status: GigStatus, deliverable: boolean): boolean {
  return status === "completed" && !deliverable;
}
