/**
 * What a gig is called on screen (title → first line of notes → client).
 *
 * A gig often has no name of its own; what identifies it is who it is
 * for. The optional title is for when that is not enough — two shifts
 * for the same agency in one week — and the notes fallback exists
 * because people already write the useful line there first.
 */
const MAX_DERIVED = 80;

export interface TitledGig {
  title: string | null;
  notes: string | null;
}

export function gigDisplayTitle(gig: TitledGig, clientName: string | null): string {
  const title = gig.title?.trim();
  if (title !== undefined && title !== "") return title;

  const firstLine = gig.notes
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  if (firstLine !== undefined) {
    // Only the derived label is shortened. A title the user typed is
    // shown as typed; notes are prose that happens to start here.
    return firstLine.length > MAX_DERIVED
      ? `${firstLine.slice(0, MAX_DERIVED - 1)}…`
      : firstLine;
  }

  return clientName ?? "No client";
}
