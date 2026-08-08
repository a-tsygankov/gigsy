/**
 * Fuzzy matching of an extracted client name against the user's
 * clients (docs/plan.md §8). The threshold pins the handoff's open
 * item: high enough that distinct clients never silently merge, low
 * enough that "Acme Staffing LLC" finds "Acme Staffing". Below the
 * threshold the draft carries a new-client stub instead.
 */

export const MATCH_THRESHOLD = 0.6;

export interface ClientCandidate {
  id: string;
  name: string;
}

export interface ClientMatch {
  clientId: string;
  matchedName: string;
  /** 1 = exact after normalization; otherwise Dice similarity. */
  confidence: number;
}

function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
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

export function matchClient(
  extractedName: string,
  clients: ClientCandidate[],
): ClientMatch | null {
  const target = normalize(extractedName);
  if (target === "") return null;

  let best: ClientMatch | null = null;
  for (const client of clients) {
    const candidate = normalize(client.name);
    const confidence =
      candidate === target ? 1 : diceSimilarity(target, candidate);
    if (confidence >= MATCH_THRESHOLD && confidence > (best?.confidence ?? 0)) {
      best = { clientId: client.id, matchedName: client.name, confidence };
    }
  }
  return best;
}
