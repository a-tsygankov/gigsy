/**
 * Turning a forwarded email into a draft (docs/plan.md §8).
 *
 * Lives here rather than in the Worker entrypoint so the provider can
 * be injected: with `providerFromEnv` wired in directly, a test could
 * only ever see the stub's canned answer, and nothing could show
 * whether the message was actually read.
 */
import PostalMime from "postal-mime";
import type { Bindings } from "../env.ts";
import { log } from "../logger.ts";
import { UsersRepo } from "../repos/users.ts";
import { userIdFromAddress } from "./address.ts";
import { createDraftFromCapture } from "./capture-service.ts";
import type { ExtractionProvider } from "./extraction.ts";
import { hasCaptureBudget, MAX_EMAIL_BYTES } from "./limits.ts";
import { providerFromEnv } from "./providers.ts";

/** Just the parts of ForwardableEmailMessage this needs — so a test can
 * build one without the whole runtime type. */
export interface CapturedMessage {
  to: string;
  raw: ReadableStream;
  setReject(reason: string): void;
}

export async function handleCapturedEmail(
  message: CapturedMessage,
  env: Bindings,
  providerFactory: (env: Bindings) => ExtractionProvider = providerFromEnv,
): Promise<void> {
  const userId = userIdFromAddress(message.to);
  if (userId === null) {
    message.setReject("Unknown recipient");
    return;
  }
  const user = await UsersRepo.for(env.DB).get(userId);
  if (user === null) {
    message.setReject("Unknown recipient");
    return;
  }

  const rawBytes = new Uint8Array(await new Response(message.raw).arrayBuffer());

  // Too big to be a booking email. Rejected at the edge rather than
  // stored, because the point of the cap is to not pay to read it.
  if (rawBytes.length > MAX_EMAIL_BYTES) {
    message.setReject("Message too large");
    log.warn("email capture rejected: too large", {
      userId: user.id,
      bytes: rawBytes.length,
    });
    return;
  }

  const parsed = await PostalMime.parse(rawBytes);
  const text = [parsed.subject ?? "", parsed.text ?? ""].join("\n\n").trim();

  // Out of budget: still keep the mail, just do not pay to read it.
  // Rejecting here would lose someone's booking to a quota they
  // cannot see, which is the one outcome worse than an unparsed draft.
  const withinBudget = await hasCaptureBudget(env, user.id);
  const provider = withinBudget
    ? providerFactory(env)
    : { extract: async () => null };

  const result = await createDraftFromCapture(env, user.id, {
    source: "email",
    rawBytes,
    rawContentType: "message/rfc822",
    provider,
    input: { text },
    // Never silently drop a user's mail: a failed extraction still
    // yields a reviewable draft pointing at the original.
    fallbackExtracted: {
      kind: "unknown",
      notes: withinBudget
        ? "Extraction failed — open the original email below."
        : "Daily capture limit reached — this was saved unread. Open the original email below.",
    },
  });
  if (result === "extraction-failed") {
    log.warn("email capture failed", { userId: user.id });
  } else {
    log.info("email captured", { userId: user.id, draftId: result.id });
  }
}
