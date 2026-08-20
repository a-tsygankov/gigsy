/**
 * The only way a screen writes one field of a gig.
 *
 * `putGig` REPLACES the record (lib/gig-input.ts), so every partial
 * write has to send the whole gig — and WHICH whole gig it sends is the
 * entire question. Both gig screens used to answer it with `gig.data`,
 * the React Query cache, and that was wrong in the same way twice:
 *
 *   - Nothing in sync-engine.ts invalidates React Query, while
 *     `refreshFromServer` writes newer records straight into Dexie. With
 *     `staleTime: 30_000` (main.tsx) the cache can hold the pre-pull
 *     copy for half a minute after a pull has replaced it.
 *   - Merging onto that copy and calling `putGig` writes the OLD values
 *     back over the newer ones AND queues them for the server. From the
 *     work card that reverts the plan — `dateTime`, `durationMinutes` —
 *     which is the exact fault the job/work split exists to prevent.
 *     From the job form it reverts the work log, whose three fields that
 *     form does not even render, so nothing on screen shows it happen.
 *
 * The fix is not "remember to read the store": it is that this function
 * takes no base at all. A caller cannot supply a stale one, because a
 * caller cannot supply one. The read happens here, from the local store,
 * at the moment of the write.
 *
 * It also throws for a gig that is no longer there, which is what makes
 * it safe to call from an unmount flush (screens/gigs/useCommitOnLeave):
 * a flush racing the delete button rejects rather than resurrecting the
 * record.
 */
import { gigToInput } from "./gig-input.ts";
import type { Gig, GigInput } from "./types.ts";

/** Just the two methods this needs, so a test can stand in for the whole
 *  data service — the same narrowing as `Pick<Storage, "getItem">` in
 *  lib/theme.ts. */
export interface GigWriter {
  getGig(id: string): Promise<Gig>;
  putGig(id: string, input: GigInput): Promise<Gig>;
}

/**
 * A patch, or a way to build one from the record being merged onto.
 *
 * The function form exists for decisions that depend on what is STORED
 * rather than on what a screen last rendered — GigEdit's "was this gig
 * already hourly?" is one, and answering that from the cache would be
 * the same staleness bug in miniature.
 */
export type GigPatch = GigInput | ((current: Gig) => GigInput);

export async function commitGigPatch(
  writer: GigWriter,
  id: string,
  patch: GigPatch,
): Promise<Gig> {
  const current = await writer.getGig(id);
  const resolved = typeof patch === "function" ? patch(current) : patch;
  return writer.putGig(id, { ...gigToInput(current), ...resolved });
}
