/**
 * One description, N dates, N gigs — and the one id that says they were
 * made together.
 *
 * The design (docs/superpowers/specs/2026-09-18-gig-batches-design.md)
 * puts the minting of `batchId` on the device, in exactly one helper
 * that both the manual form (GigEdit.tsx) and the draft review
 * (DraftReview.tsx) call. The server stores what it is given
 * (`gigs.batch_id`, migration 0019); it never decides which gigs
 * belong together, so the decision cannot be made differently by two
 * screens.
 *
 * Every write goes through the ordinary `putGig`, one record at a time,
 * because that is what the outbox knows how to replay: a batch is not a
 * transaction, and a sibling that fails to sync is one gig with a
 * pending op, not a half-created batch. Nothing after creation is
 * shared — each gig keeps its own status, money and work log, and the
 * id is grouping only, exactly like `parentGigId`.
 */
import type { OfflineDataService } from "./data-service.ts";
import type { Gig, GigInput } from "./types.ts";

/** Just the one method this needs, so a test can stand in for the whole
 *  data service — the same narrowing `GigWriter` in lib/gig-write.ts
 *  draws. */
export type GigBatchWriter = Pick<OfflineDataService, "putGig">;

/**
 * Create one gig per entry in `dateTimes`, each a copy of `base` with
 * that date, in the order given.
 *
 * `base.dateTime` and `base.batchId` are overwritten: the dates are the
 * list, and the batch id is this function's to set. Everything else —
 * client, title, duration, location, pay, notes, source — is copied as
 * it stands, which is the "per-date fields" decision from the design:
 * only the moment differs between siblings.
 *
 * The batch id is a fresh UUID shared by every gig when there is more
 * than one, and NULL when there is exactly one. A batch of one is not a
 * batch: the column means "created with these others", and a gig with
 * no others carries nothing. Stamping a lone gig anyway would make the
 * ordinary single save indistinguishable from a batch on the server,
 * and every "show me the siblings" query would have to special-case
 * it. `null` for one is the decision table's row, and this is the one
 * place it is enforced.
 *
 * `newId` is injected for the reason `LocalStore` injects its own: a
 * test that cannot predict the ids cannot assert that all N records
 * share one batch id and none shares a gig id.
 */
export async function createGigBatch(
  data: GigBatchWriter,
  base: GigInput,
  dateTimes: (number | null)[],
  newId: () => string = () => crypto.randomUUID(),
): Promise<Gig[]> {
  const batchId = dateTimes.length > 1 ? newId() : null;
  const created: Gig[] = [];
  // Sequential, not `Promise.all`: `putGig` reads the existing row and
  // bumps the outbox, and the order the ops land in is the order the
  // gigs were named — which is also the order the list shows them in
  // when the dates are equal (they cannot be; collectGigDates refuses
  // that) or absent.
  for (const dateTime of dateTimes) {
    created.push(await data.putGig(newId(), { ...base, dateTime, batchId }));
  }
  return created;
}
