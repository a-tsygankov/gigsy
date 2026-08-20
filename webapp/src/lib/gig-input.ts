/**
 * A stored gig as the write payload that would save it unchanged.
 *
 * `putGig` REPLACES; it does not patch. OfflineLocalStore.putGig builds
 * the whole record out of the input alone — `location: input.location ??
 * null` and so on for every field — so anything left out of the payload
 * is stored as null rather than left as it was. The Work card is nothing
 * but partial writes (a status, a stamp, a break), and each one has to
 * send the entire gig with one field changed. This is that entire gig,
 * so no call site has to remember the list.
 *
 * Two fields are deliberately absent:
 *
 *   - `expectedCents` is server-owned and derived (migration 0014).
 *     `GigInput` has no such key, and GigsRepo.upsert recomputes it on
 *     every write.
 *   - `source` records where a gig came from. local-store carries the
 *     existing row's value forward when the input omits it
 *     (`input.source ?? existing?.source ?? "manual"`), so omitting it
 *     preserves it — whereas sending `gig.source` would need a cast
 *     (`Gig.source` is a loose `string | null`, `GigInput.source` is a
 *     three-value union) and could relabel an email-captured gig as
 *     "manual".
 */
import type { Gig, GigInput } from "./types.ts";

export function gigToInput(gig: Gig): GigInput {
  return {
    clientId: gig.clientId,
    title: gig.title,
    status: gig.status,
    location: gig.location,
    dateTime: gig.dateTime,
    durationMinutes: gig.durationMinutes,
    payType: gig.payType,
    hourlyRateCents: gig.hourlyRateCents,
    workStartedAt: gig.workStartedAt,
    workEndedAt: gig.workEndedAt,
    breakMinutes: gig.breakMinutes,
    amountOfferedCents: gig.amountOfferedCents,
    amountPaidCents: gig.amountPaidCents,
    notes: gig.notes,
  };
}
