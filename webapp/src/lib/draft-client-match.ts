/**
 * How the review screen reads the server's client match — three bands,
 * and what each one preselects.
 *
 * The capture matcher (backend/src/capture/client-match.ts) links a
 * draft to an existing client with a confidence: 1.0 for a name that
 * is the same once case and punctuation are ignored, 0.8 when one name
 * contains the other's words ("Acme" / "Acme Staffing LLC"), 0.75 for
 * initials ("FFA" / "Full Field Agency"), and a bigram score of at
 * least 0.6 for a spelling slip. The two middle tiers sit deliberately
 * BELOW the line drawn here, so that the screen ASKS about them rather
 * than guessing: a guessed link is worse than an extra tap
 * (docs/superpowers/specs/2026-09-19-client-create-and-match-design.md).
 *
 * Pure, so DraftReview.tsx can seed its state from it in one line and
 * a test can pin each band without rendering a screen.
 */
import { type ClientChoice } from "./client-choice.ts";
import type { DraftExtracted } from "./types.ts";

/** At or above this the match is preselected and merely announced. */
export const CONFIDENT_MATCH = 0.9;

export type MatchBand = "confident" | "unsure" | "none";

export type MatchEvidence = Pick<
  DraftExtracted,
  "matchedClientId" | "matchConfidence" | "clientName"
>;

/**
 * A match with no confidence recorded reads as UNSURE, not as
 * confident: the field is optional on the wire (`DraftExtracted`) and
 * a draft from before confidences were reliable is exactly the kind
 * that should be checked by a person.
 */
export function matchBand(extracted: MatchEvidence): MatchBand {
  if (extracted.matchedClientId == null) return "none";
  return (extracted.matchConfidence ?? 0) >= CONFIDENT_MATCH ? "confident" : "unsure";
}

/**
 * What the client select starts on, and whether the "is this X?"
 * question is open — the design's table, band by band:
 *
 *   confident   the match, no question
 *   unsure      nothing yet, question open; Confirm waits on it
 *   none        "New client" with the extracted name, or nothing when
 *               the document named no client
 */
export function seedDraftClient(extracted: MatchEvidence): {
  client: ClientChoice;
  questionOpen: boolean;
} {
  const band = matchBand(extracted);
  if (band === "confident") {
    return { client: { kind: "existing", id: extracted.matchedClientId! }, questionOpen: false };
  }
  if (band === "unsure") return { client: { kind: "none" }, questionOpen: true };
  const name = extracted.clientName?.trim() ?? "";
  return {
    client: name === "" ? { kind: "none" } : { kind: "new", name },
    questionOpen: false,
  };
}
