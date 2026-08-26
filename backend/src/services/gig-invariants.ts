/**
 * The rules a gig's `parentGigId` must satisfy, checked once here
 * rather than at each door that happens to be handling the request.
 *
 * Every gig write reaches D1 through the CRUD route (routes/gigs.ts)
 * or the offline outbox (services/sync.ts). `payment-invariants.ts`
 * exists because that same pair of doors each carried its own copy of
 * a check, both copies had the same bug, and fixing one did not fix
 * the other. This module follows it.
 *
 * Rule 3 carries the weight. A parent may not itself have a parent,
 * which makes cycles UNREACHABLE rather than merely detected: if A's
 * parent is B, then B has no parent, so B cannot later adopt A. No
 * traversal, no recursive CTE, no depth limit. The single cycle it
 * does not close is a gig naming itself, which rule 4 handles.
 */
import { GigsRepo } from "../repos/gigs.ts";

export interface InvariantViolation {
  ok: false;
  message: string;
}

function violation(message: string): InvariantViolation {
  return { ok: false, message };
}

/**
 * Returns the violation that should stop this write, or null when the
 * parent link is acceptable — including when there is no link at all.
 *
 * `clientId` is the client the gig will have AFTER this write, not the
 * one it has now: a write can move a gig and set its parent in the
 * same operation, and the rule has to hold against the result.
 */
export async function checkGigParent(
  d1: D1Database,
  userId: string,
  id: string,
  parentGigId: string | null,
  clientId: string | null,
): Promise<InvariantViolation | null> {
  if (parentGigId === null) return null;

  if (parentGigId === id) {
    return violation("a gig cannot be its own parent");
  }

  const parent = await GigsRepo.for(d1).get(userId, parentGigId);
  if (parent === null) {
    return violation("parentGigId does not reference your gig");
  }

  // Both null IS the same client: the rule exists so a client's history
  // reads coherently, and two unattributed gigs share that answer.
  if ((parent.clientId ?? null) !== clientId) {
    return violation("parentGigId does not reference the same client");
  }

  // One level. This is what makes cycles unreachable — see the header.
  if (parent.parentGigId !== null) {
    return violation("parentGigId already has a parent of its own");
  }

  return null;
}
