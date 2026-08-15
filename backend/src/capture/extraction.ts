/**
 * The structured output every extraction provider must produce
 * (docs/plan.md §8). Validated with zod so a hallucinating model can
 * never smuggle malformed data into a draft — parse failures surface
 * as "extraction failed", not as garbage records.
 */
import { z } from "zod";

export const ExtractedData = z.object({
  kind: z.enum(["gig", "expense", "unknown"]),
  clientName: z.string().min(1).nullish(),
  /** Filled by the fuzzy matcher, not the model. */
  matchedClientId: z.string().nullish(),
  matchConfidence: z.number().min(0).max(1).nullish(),
  location: z.string().nullish(),
  dateTimeMs: z.number().int().nullish(),
  amountOfferedCents: z.number().int().positive().nullish(),
  amountCents: z.number().int().positive().nullish(),
  category: z.string().nullish(),
  notes: z.string().nullish(),
});
export type ExtractedDataT = z.infer<typeof ExtractedData>;

/** One image handed to a model alongside the text. */
export interface ExtractionMedia {
  mimeType: string;
  dataBase64: string;
}

/**
 * What a provider is asked to read.
 *
 * Text and media travel together rather than as an either/or: a
 * forwarded booking email is a body AND, often, the flyer attached to
 * it, and reading only one of them is how a draft ends up confidently
 * wrong. There is no `kind` discriminator because it would be derivable
 * from `media` and therefore able to disagree with it.
 */
export interface ExtractionInput {
  /** Body text — subject + body for email, absent for a bare photo. */
  text?: string;
  /** Photo capture sends exactly one; email capture sends zero or more. */
  media?: ExtractionMedia[];
}

export interface ExtractionProvider {
  /** null = extraction failed (provider error, junk output) —
   * callers surface that, never fabricate a draft. */
  extract(input: ExtractionInput): Promise<ExtractedDataT | null>;
}

export const EXTRACTION_PROMPT = `You extract gig-work data from flyers, receipts, and forwarded emails for a personal gig tracker.
Reply with ONLY a JSON object (no prose, no markdown fences) with these fields:
- "kind": "gig" for offered work/shifts, "expense" for receipts/purchases, "unknown" if unclear
- "clientName": the agency/company offering the work, or the merchant for expenses (string or null)
- "location": venue/address if present (string or null)
- "dateTimeMs": event date-time as epoch milliseconds UTC (number or null)
- "amountOfferedCents": offered pay in integer cents, gigs only (number or null)
- "amountCents": receipt total in integer cents, expenses only (number or null)
- "category": short expense category like "parking", "supplies" (string or null)
- "notes": anything else useful, one short sentence (string or null)
Amounts must be positive integers in cents. Use null when unsure — never guess.`;

/** Models love markdown fences despite instructions — strip them
 * before parsing, then validate hard. */
export function parseExtractionText(text: string): ExtractedDataT | null {
  const unfenced = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    const parsed = ExtractedData.safeParse(JSON.parse(unfenced));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
