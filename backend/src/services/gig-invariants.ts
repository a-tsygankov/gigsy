/**
 * The rules that keep a gig's place in a parent/child pair coherent,
 * checked once here rather than at each door that happens to be
 * handling the request.
 *
 * Every gig write reaches D1 through the CRUD route (routes/gigs.ts)
 * or the offline outbox (services/sync.ts). `payment-invariants.ts`
 * exists because that same pair of doors each carried its own copy of
 * a check, both copies had the same bug, and fixing one did not fix
 * the other. This module follows it.
 *
 * THE LINK HAS TWO ENDS, and an early version of this file only looked
 * at one of them. Rules 1-4 all ask about the parent a write NAMES;
 * rules 5 and 6 ask about the children that already name THIS gig.
 * Both gaps that cost were downward-facing, and both were reachable
 * through the intended UI:
 *
 *   - Rule 3 alone does not bound depth. It stops a gig pointing AT a
 *     parented gig, which bounds the chain from above and leaves the
 *     bottom open: a gig that already has follow-ups could still
 *     acquire a parent of its own, producing the exact two-level chain
 *     "one level" forbids. Rule 5 is that same rule from below.
 *   - Rule 2 alone does not hold over time. It is checked when a link
 *     is made and never again, so moving a PARENT to another client
 *     falsified it in stored data through a write that named no parent
 *     at all. Rule 6 is that same rule, defended from below.
 *
 * Rule 3 still carries the weight it was given, and with rule 5 beside
 * it the claim is now true in both directions: cycles are UNREACHABLE
 * rather than merely detected. If A's parent is B then B has no
 * parent, so B cannot later adopt A — and B cannot acquire one behind
 * the check either, because rule 5 refuses that write. No traversal,
 * no recursive CTE, no depth limit. The single cycle neither closes is
 * a gig naming itself, which rule 4 handles.
 *
 * COST: one indexed read (idx_gigs_parent, migration 0018) for the two
 * downward rules, plus one point read for the upward ones — and that
 * second read only when the write actually names a parent. The common
 * case, a gig with no parent and no follow-ups, pays the single
 * indexed read and nothing more.
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
 * gig's links are acceptable — including when it names no parent, which
 * is NOT the same as having nothing to check: rules 5 and 6 are about
 * the follow-ups already pointing at this gig, and a write that drops
 * or never had a parent still has to answer for them.
 *
 * `clientId` and `parentGigId` are the values the gig will have AFTER
 * this write, not the ones it has now: a write can move a gig and set
 * its parent in the same operation, and the rules have to hold against
 * the result.
 */
export async function checkGigParent(
  d1: D1Database,
  userId: string,
  id: string,
  parentGigId: string | null,
  clientId: string | null,
): Promise<InvariantViolation | null> {
  const repo = GigsRepo.for(d1);

  // Rule 4, first because it needs no read at all — and because it has
  // to precede the parent lookup below. A gig naming itself before it
  // exists would otherwise come back as rule 1's "not your gig", which
  // is a true statement about the wrong problem.
  if (parentGigId !== null && parentGigId === id) {
    return violation("a gig cannot be its own parent");
  }

  // The one indexed read, serving both downward rules. Deliberately
  // ahead of the null-parent return: rule 6 has to hold for a write
  // that names no parent, which is precisely how it was breached.
  const children = await repo.listChildren(userId, id);

  // Rule 6, in the shape payment-invariants' I5 established: moving a
  // gig to a different client while its follow-ups still point at it
  // would leave those links naming a gig on somebody else's history.
  // Refused rather than cascaded — as with I5, the caller clears the
  // links first. Nothing is silently rewritten under a user.
  if (children.some((child) => (child.clientId ?? null) !== clientId)) {
    return violation("clientId does not match the follow-ups of this gig");
  }

  if (parentGigId === null) return null;

  // Rule 5 — rule 3 from the other side. See the header: checking only
  // the target's parent bounds depth from above but not below, and a
  // gig with follow-ups of its own becoming someone's child is exactly
  // the two-level chain "one level" forbids.
  if (children.length > 0) {
    return violation("a gig with follow-ups cannot have a parent of its own");
  }

  const parent = await repo.get(userId, parentGigId);
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
