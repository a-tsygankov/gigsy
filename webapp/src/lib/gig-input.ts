/**
 * A stored gig as the write payload that would save it unchanged.
 *
 * `putGig` REPLACES; it does not patch. OfflineLocalStore.putGig builds
 * the whole record out of the input alone — `location: input.location ??
 * null` and so on for nearly every field — so anything left out of the
 * payload is stored as null rather than left as it was. (Four fields
 * fall back to the existing row instead — `payType`, `source`,
 * `calendarEventId`, `createdAt` — and three are set outright: `id`,
 * `modifiedAt`, and `expectedCents`, which is nulled on every local
 * write by design. Every remaining field nulls.) The
 * work card is nothing but partial writes — a status, a stamp, a break
 * — and each one has to send the entire gig with one field changed.
 * This is that entire gig, so no call site has to remember the list.
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

/**
 * Every writable field, present — not `GigInput`, whose fields are all
 * optional and would let a new one be forgotten here in silence.
 *
 * This repo has already paid for that exact mistake once: `OutboxPayload`
 * is `Required<...>` (lib/local-store.ts) because `durationMinutes` and
 * `reimbursable` were added to the record in Phase 9 and left out of the
 * payload — every gig saved for months reached the server with no
 * duration, and calendar sync drew them all at its four-hour fallback.
 * Nothing failed; the data just never arrived. This function is now
 * the single choke point for every work-card write and for the job
 * form's save, so it gets the same guard — add a field to `GigInput`
 * and this stops compiling.
 *
 * `source` is the one exclusion, and it is deliberate rather than an
 * omission — see the note above.
 */
export type FullGigInput = Required<Omit<GigInput, "source">>;

export function gigToInput(gig: Gig): FullGigInput {
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
