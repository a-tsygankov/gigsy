/**
 * Fuzzy matching of an extracted client name against the user's
 * clients (docs/plan.md §8, extended by
 * docs/superpowers/specs/2026-09-19-client-create-and-match-design.md).
 *
 * A flyer spells a client the way the flyer likes: `ACME`, `Acme
 * Staffing LLC`, `F.F.A.`, `full field agency`. The matcher scores
 * each candidate through four tiers, in this order, and the first
 * tier that fires decides the confidence:
 *
 *   1. exact after normalisation          1.0
 *   2. initials (`FFA` ↔ Full Field Agency) INITIALS_CONFIDENCE
 *   3. word containment (`Acme` ↔ Acme Staffing) CONTAINMENT_CONFIDENCE
 *   4. Sørensen–Dice bigram similarity     its own score, ≥ MATCH_THRESHOLD
 *
 * The review screen reads the confidence in bands: ≥ 0.9 links the
 * client and says so; anything below asks "Is this X?". Tiers 2 and 3
 * are pinned below 0.9 on purpose so the screen ASKS about an
 * initials or longer/shorter-form hit rather than guessing, and they
 * pre-empt Dice even where Dice would score higher (a longer form can
 * reach ~0.97 on bigrams alone): a longer-or-shorter form is exactly
 * the case the design wants a human to confirm. Below every tier the
 * draft carries a new-client stub instead.
 */

/** Dice floor: high enough that distinct clients never silently merge. */
export const MATCH_THRESHOLD = 0.6;

/**
 * `FFA` / `F.F.A.` against "Full Field Agency" (either direction).
 * Deliberately below the review screen's 0.9 "confident" band so the
 * user is asked; initials are a strong hint, not proof.
 */
export const INITIALS_CONFIDENCE = 0.75;

/**
 * One name's words inside the other's (`Acme` ↔ "Acme Staffing",
 * "Acme Staffing LLC" ↔ "Acme Staffing"). Also below 0.9 on purpose:
 * "Acme" could be a different Acme, so the screen asks.
 */
export const CONTAINMENT_CONFIDENCE = 0.8;

export interface ClientCandidate {
  id: string;
  name: string;
}

export interface ClientMatch {
  clientId: string;
  matchedName: string;
  /**
   * 1 = exact after normalisation; INITIALS_CONFIDENCE or
   * CONTAINMENT_CONFIDENCE for those tiers; otherwise Dice similarity.
   */
  confidence: number;
}

/**
 * Lower-case, every run of non-letter/digit characters becomes one
 * space. Note the side effect the initials tier relies on: `F.F.A.`
 * becomes `f f a`, three one-letter words, while `FFA` becomes `ffa`.
 */
function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function words(normalised: string): string[] {
  return normalised === "" ? [] : normalised.split(" ");
}

/** First letter of each word: "full field agency" → "ffa". */
function initials(normalised: string): string {
  return words(normalised)
    .map((word) => word.charAt(0))
    .join("");
}

/**
 * The string a name stands for when it IS a set of initials, or null
 * when it cannot be one. `ffa` is a single word and stands for itself;
 * `f f a` (what `normalize` makes of `F.F.A.`) is a run of one-letter
 * words and stands for `ffa`. A multi-word name with a longer word in
 * it ("full field") is a name, not initials, so it never gets read as
 * the initials of something else.
 */
function asInitials(normalised: string): string | null {
  const parts = words(normalised);
  const [first] = parts;
  if (parts.length === 1 && first !== undefined) return first;
  if (parts.length > 1 && parts.every((word) => word.length === 1)) {
    return parts.join("");
  }
  return null;
}

/**
 * True when one side is written as initials and equals the other
 * side's initials. A one-letter initials string ("A" vs "Acme") is
 * refused: it would match every client starting with that letter.
 */
function initialsMatch(a: string, b: string): boolean {
  return matchesInitialsOf(a, b) || matchesInitialsOf(b, a);
}

function matchesInitialsOf(short: string, long: string): boolean {
  const asWritten = asInitials(short);
  if (asWritten === null || asWritten.length < 2) return false;
  return asWritten === initials(long);
}

/**
 * True when the shorter word list sits wholly inside the longer one:
 * every word of the shorter appears in the longer, the shorter has at
 * least one word and is strictly shorter. A contiguous prefix ("Acme
 * Staffing" in "Acme Staffing LLC") is the common case and is covered
 * by the subset rule; the subset rule also catches "Roadshow Team" in
 * "Costco Roadshow Team". Equal-length lists are left to the exact
 * check and to Dice.
 */
function containmentMatch(a: string, b: string): boolean {
  const wordsA = words(a);
  const wordsB = words(b);
  const [shorter, longer] =
    wordsA.length <= wordsB.length ? [wordsA, wordsB] : [wordsB, wordsA];
  if (shorter.length === 0 || shorter.length >= longer.length) return false;
  const longerSet = new Set(longer);
  return shorter.every((word) => longerSet.has(word));
}

function bigrams(value: string): Map<string, number> {
  const grams = new Map<string, number>();
  const compact = value.replace(/\s+/g, "");
  for (let i = 0; i < compact.length - 1; i++) {
    const gram = compact.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

/** Sørensen–Dice coefficient over character bigrams. */
function diceSimilarity(a: string, b: string): number {
  const gramsA = bigrams(a);
  const gramsB = bigrams(b);
  let overlap = 0;
  let totalA = 0;
  let totalB = 0;
  for (const count of gramsA.values()) totalA += count;
  for (const count of gramsB.values()) totalB += count;
  if (totalA === 0 || totalB === 0) return 0;
  for (const [gram, count] of gramsA) {
    overlap += Math.min(count, gramsB.get(gram) ?? 0);
  }
  return (2 * overlap) / (totalA + totalB);
}

/**
 * Confidence for one candidate, or 0 when no tier fires. Tiers run in
 * the order the file header lists; the Dice tier alone is gated by
 * MATCH_THRESHOLD, the fixed-confidence tiers are already above it.
 */
function scoreCandidate(target: string, candidate: string): number {
  if (candidate === target) return 1;
  if (initialsMatch(target, candidate)) return INITIALS_CONFIDENCE;
  if (containmentMatch(target, candidate)) return CONTAINMENT_CONFIDENCE;
  const dice = diceSimilarity(target, candidate);
  return dice >= MATCH_THRESHOLD ? dice : 0;
}

export function matchClient(
  extractedName: string,
  clients: ClientCandidate[],
): ClientMatch | null {
  const target = normalize(extractedName);
  if (target === "") return null;

  let best: ClientMatch | null = null;
  for (const client of clients) {
    const confidence = scoreCandidate(target, normalize(client.name));
    if (confidence > 0 && confidence > (best?.confidence ?? 0)) {
      best = { clientId: client.id, matchedName: client.name, confidence };
    }
  }
  return best;
}
