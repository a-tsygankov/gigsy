/**
 * What a form means by "the client" before the gig is saved — and the
 * one place that turns it into an id.
 *
 * Two screens create gigs (GigEdit.tsx and DraftReview.tsx), and both
 * now let a client be named that does not exist yet: the client select
 * ends in "New client…" and takes the name right there
 * (components/ClientSelect.tsx; docs/superpowers/specs/
 * 2026-09-19-client-create-and-match-design.md). The decision that
 * shapes this file is WHEN the client row is written: on save of the
 * gig, not when "New client…" is picked. A client stub created for a
 * gig that is then cancelled would be an orphan on the Clients tab,
 * so the form holds the intent — `{ kind: "new", name }` — and only
 * the save resolves it.
 *
 * `ClientChoice` is a discriminated union rather than a nullable id
 * plus a "pending name" string because the three states are mutually
 * exclusive and a screen has to branch on all of them: the parent
 * picker in GigEdit reads an id off `existing` and nothing off the
 * others; the review screen's banner reads the name off `new`. Two
 * loosely-coupled fields would let a screen hold both an id and a
 * name and have to decide which wins.
 */
import type { OfflineDataService } from "./data-service.ts";

export type ClientChoice =
  | { kind: "none" }
  | { kind: "existing"; id: string }
  | { kind: "new"; name: string };

/** The message a screen shows when a `new` choice is saved with a
 *  blank name. Refused at save, not by the control: a name box that
 *  complains while you are still typing is a box you cannot use. */
export const NEW_CLIENT_NAME_REQUIRED = "Give the new client a name.";

/** Just the one method this needs, so a test can stand in for the whole
 *  data service — the same narrowing `GigBatchWriter` in lib/gig-batch.ts
 *  draws. */
export type ClientWriter = Pick<OfflineDataService, "putClient">;

/** Whether the choice is one this screen can use without writing anything. */
export function hasClientName(choice: ClientChoice): boolean {
  return choice.kind !== "new" || choice.name.trim() !== "";
}

/**
 * The id a choice already stands for, or null.
 *
 * `none` and `new` both read as null — for the parent-picker rules in
 * GigEdit (a brand-new client has no other gigs, so the "Part of" list
 * for it is the client-less list, which is empty of anything it could
 * legitimately join) — and NOT as "unknown": nothing should wait on
 * this to become an id. Only `resolveClientChoice` makes one.
 */
export function clientChoiceId(choice: ClientChoice): string | null {
  return choice.kind === "existing" ? choice.id : null;
}

/** The choice a stored gig's `clientId` seeds a form with. */
export function clientChoiceFromId(id: string | null | undefined): ClientChoice {
  return id == null ? { kind: "none" } : { kind: "existing", id };
}

/**
 * Turn a choice into the `clientId` a gig is written with — creating
 * the client first when the choice is `new`.
 *
 * Called from inside the save (GigEdit's `mutationFn`, DraftReview's
 * commit handler) rather than before it, so a failed `putClient`
 * surfaces the same way a failed `putGig` does: as the save's error,
 * on the same line under the same button. A blank `new` name throws
 * `NEW_CLIENT_NAME_REQUIRED` for the same reason — the screens check
 * it earlier where they can, and this is the guarantee that nothing
 * slips past into a client called "".
 *
 * The client is written whole through the ordinary `putClient`, which
 * is what the outbox knows how to replay: created offline, it queues
 * ahead of the gig that references it, and the server sees the client
 * before the foreign key. Contact and notes are the client's own form's
 * to set (the design's out-of-scope row).
 *
 * `newId` is injected for the reason `createGigBatch` injects its own:
 * a test that cannot predict the id cannot assert the gig was written
 * with the client it just made.
 */
export async function resolveClientChoice(
  data: ClientWriter,
  choice: ClientChoice,
  newId: () => string = () => crypto.randomUUID(),
): Promise<string | null> {
  switch (choice.kind) {
    case "none":
      return null;
    case "existing":
      return choice.id;
    case "new": {
      const name = choice.name.trim();
      if (name === "") throw new Error(NEW_CLIENT_NAME_REQUIRED);
      const created = await data.putClient(newId(), { name });
      return created.id;
    }
  }
}
