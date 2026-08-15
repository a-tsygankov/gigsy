/**
 * The one path from a captured artifact (photo bytes / raw email) to
 * a pending draft: extract → fuzzy-match the client → store the
 * original in R2 → insert the draft. Photo and email capture share
 * it; only their inputs differ.
 */
import type { Bindings } from "../env.ts";
import { ClientsRepo } from "../repos/clients.ts";
import { DraftsRepo, type DraftRecord } from "../repos/drafts.ts";
import { matchClient } from "./client-match.ts";
import type {
  ExtractedDataT,
  ExtractionInput,
  ExtractionProvider,
} from "./extraction.ts";
import type { DraftSource } from "../db/schema.ts";

export interface CaptureRequest {
  source: DraftSource;
  rawBytes: Uint8Array;
  rawContentType: string;
  input: ExtractionInput;
  provider: ExtractionProvider;
  /** When set, a failed extraction still yields a draft with this
   * placeholder (email capture: never silently drop a user's mail).
   * Absent → the caller surfaces the failure (photo capture: 502). */
  fallbackExtracted?: ExtractedDataT;
}

export async function createDraftFromCapture(
  env: Bindings,
  userId: string,
  request: CaptureRequest,
): Promise<DraftRecord | "extraction-failed"> {
  let extracted = await request.provider.extract(request.input);
  if (extracted === null) {
    if (request.fallbackExtracted === undefined) return "extraction-failed";
    extracted = request.fallbackExtracted;
  }

  if (extracted.clientName != null) {
    const clients = await ClientsRepo.for(env.DB).list(userId);
    const match = matchClient(extracted.clientName, clients);
    if (match !== null) {
      extracted = {
        ...extracted,
        matchedClientId: match.clientId,
        matchConfidence: match.confidence,
      };
    }
  }

  const draftId = crypto.randomUUID();
  const rawR2Key = `u/${userId}/captures/${draftId}`;
  await env.RECEIPTS.put(rawR2Key, request.rawBytes, {
    httpMetadata: { contentType: request.rawContentType },
  });

  return DraftsRepo.for(env.DB).insert(userId, {
    id: draftId,
    source: request.source,
    rawR2Key,
    extractedJson: JSON.stringify(extracted),
    now: Date.now(),
  });
}
