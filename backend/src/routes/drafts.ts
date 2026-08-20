import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Bindings } from "../env.ts";
import { requireAuth, type AuthVars } from "../middleware/auth.ts";
import { DraftsRepo, type DraftRecord } from "../repos/drafts.ts";
import { PaymentsRepo } from "../repos/payments.ts";
import { GigsRepo } from "../repos/gigs.ts";
import { PaymentInput, entityId } from "../domain/schemas.ts";
import { confirmationKey } from "./payments.ts";
import { log } from "../logger.ts";

/** Wire shape: extracted_json goes out parsed, never as a string.
 * (Shared with the capture routes.) */
export function serializeDraft(draft: DraftRecord) {
  const { extractedJson, ...rest } = draft;
  return { ...rest, extracted: JSON.parse(extractedJson) as unknown };
}
const serialize = serializeDraft;

const StatusChange = z.object({ status: z.enum(["confirmed", "discarded"]) });
const ListQuery = z.object({
  status: z.enum(["pending", "confirmed", "discarded"]).optional(),
});
// The payment the client wants created, plus the id it generated for
// it — the same client-generated-UUID convention PUT /api/payments/:id
// uses, kept here instead of reusing that route because confirming a
// payment draft is one atomic server-side operation (close the draft,
// create the payment, copy the draft's photo to it) and splitting that
// across two requests reopens exactly the race this route exists to
// avoid: two concurrent confirms of the same draft each creating their
// own payment.
const ConfirmPayment = PaymentInput.extend({ id: entityId });

export const draftsRouter = new Hono<{ Bindings: Bindings; Variables: AuthVars }>()
  .use("*", requireAuth)
  .get("/", zValidator("query", ListQuery), async (c) => {
    const { status } = c.req.valid("query");
    const items = await DraftsRepo.for(c.env.DB).list(c.get("userId"), status);
    return c.json({ items: items.map(serialize) });
  })
  .get("/:id", async (c) => {
    const draft = await DraftsRepo.for(c.env.DB).get(
      c.get("userId"),
      c.req.param("id"),
    );
    return draft === null
      ? c.json({ error: "not found" }, 404)
      : c.json(serialize(draft));
  })
  .put("/:id", zValidator("json", StatusChange), async (c) => {
    const result = await DraftsRepo.for(c.env.DB).setStatus(
      c.get("userId"),
      c.req.param("id"),
      c.req.valid("json").status,
      Date.now(),
    );
    if (result === "not-found") return c.json({ error: "not found" }, 404);
    if (result === "conflict") {
      return c.json({ error: "draft already reviewed" }, 409);
    }
    return c.json(serialize(result));
  })
  // A receipt draft becomes a real payment here, in one request: the
  // gig/expense drafts create their record through the ordinary
  // offline-first path (data.putGig/putExpense) and only tell the
  // server the draft is reviewed, but a payment additionally needs its
  // confirmation photo — already sitting in R2 under the draft's
  // rawR2Key — copied into the payment's own key, and that copy needs
  // the payment to already exist server-side. Routing both through the
  // outbox would race: the draft could be marked confirmed before the
  // payment write ever reached the server. Doing it here keeps the
  // three steps (close, create, copy) in one server-side operation.
  .post("/:id/confirm-payment", zValidator("json", ConfirmPayment), async (c) => {
    const userId = c.get("userId");
    const draftId = c.req.param("id");
    const { id: paymentId, ...input } = c.req.valid("json");

    if (
      input.gigId != null &&
      (await GigsRepo.for(c.env.DB).get(userId, input.gigId)) === null
    ) {
      return c.json({ error: "gigId does not reference your gig" }, 400);
    }

    const paymentsRepo = PaymentsRepo.for(c.env.DB);
    // This route means CREATE, never update. `paymentId` is a
    // client-generated id that has no business already existing —
    // PaymentsRepo.upsert would silently overwrite an id collision's
    // amount/gigId/notes and, worse, let the copy below clobber that
    // payment's existing confirmation photo with this draft's. Refuse
    // before either happens rather than let "upsert" mean "upsert".
    if ((await paymentsRepo.get(userId, paymentId)) !== null) {
      return c.json({ error: "payment already exists" }, 409);
    }

    // Close the draft FIRST, atomically (DraftsRepo.setStatus), and
    // only create the payment if that succeeded. Creating the payment
    // before this check — the original shape of this route — let two
    // concurrent confirmations of the same draft both read "pending",
    // both create a payment, and only then race the close: proven with
    // two simultaneous requests against one draft, both 201, two
    // payments. setStatus's own WHERE clause is the compare-and-set
    // that makes "at most one caller proceeds past this point" true.
    const now = Date.now();
    const draftsRepo = DraftsRepo.for(c.env.DB);
    const confirmed = await draftsRepo.setStatus(userId, draftId, "confirmed", now);
    if (confirmed === "not-found") return c.json({ error: "not found" }, 404);
    if (confirmed === "conflict") {
      return c.json({ error: "draft already reviewed" }, 409);
    }
    const draft = confirmed;

    // From here on the draft says "confirmed". This is deliberately
    // NOT one transaction with the write below: D1's db.batch() (it
    // exists — drizzle-orm/d1 exposes it) runs every statement in the
    // batch unconditionally, with no way to make the payment INSERT
    // conditional on the draft UPDATE's WHERE clause having actually
    // matched a row, so batching the two would reopen exactly the
    // double-payment race the close-then-create ordering above exists
    // to close — a loser's UPDATE affecting zero rows wouldn't stop
    // its INSERT from still running. Making that conditional would
    // need raw SQL with no precedent in this codebase (a subquery
    // guard, or relying on SQLite's connection-scoped `changes()`
    // across statements in one batch) — judged not worth the risk for
    // what is already a narrow, mostly-theoretical window.
    //
    // What batching doesn't solve for still needs an answer: a failure
    // in payment creation past this point would otherwise strand the
    // draft — permanently "confirmed", absent from the pending list,
    // invisible to retry (setStatus's WHERE refuses a second close),
    // and with nothing in the app able to turn it back into a payment.
    // `reopen()` is the compensating action: put the draft back to
    // "pending" so the user simply sees it in Drafts again and can
    // retry, logging loudly enough (draftId, paymentId, userId) that
    // this is findable even before anyone reports it missing.
    const reopenAndLog = async (reason: string, extra: Record<string, unknown> = {}) => {
      await draftsRepo.reopen(userId, draftId, now);
      log.error("draft confirmed but payment creation failed — reopened for retry", {
        draftId,
        paymentId,
        userId,
        reason,
        ...extra,
      });
    };

    let upserted: Awaited<ReturnType<typeof paymentsRepo.upsert>>;
    try {
      upserted = await paymentsRepo.upsert(
        userId,
        paymentId,
        {
          gigId: input.gigId ?? null,
          amountCents: input.amountCents,
          paidAt: input.paidAt ?? null,
          notes: input.notes ?? null,
        },
        { now },
      );
    } catch (err) {
      await reopenAndLog("upsert threw", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "payment creation failed" }, 500);
    }
    if (upserted === "forbidden") {
      // Only reachable if `paymentId` belongs to a different user —
      // the same-user case was already refused above, before the
      // draft closed, which is exactly why this one still needs the
      // compensating reopen: that earlier check ran before the close,
      // this one is discovered after it.
      await reopenAndLog("payment id belongs to another user");
      return c.json({ error: "not found" }, 404);
    }
    let record = upserted.record;

    // The receipt IS the proof — copy it rather than asking the client
    // to re-upload bytes it already sent. Best-effort: a source object
    // that is missing or fails to copy must not stop the payment from
    // being recorded, or a storage hiccup would silently swallow real
    // money. A payment with no confirmation image is a payment the
    // user can still see and fix; a payment that never got created is
    // one they have to notice is missing and re-enter by hand. When
    // this best-effort copy does fail, DraftReview's own fallback
    // (getDraftRawBlob + uploadPaymentConfirmation) gets a second try
    // at attaching the same photo — the draft row and its rawR2Key
    // both survive this confirmation.
    if (draft.rawR2Key !== null) {
      try {
        const source = await c.env.RECEIPTS.get(draft.rawR2Key);
        if (source !== null) {
          const key = confirmationKey(userId, paymentId);
          await c.env.RECEIPTS.put(key, source.body, {
            httpMetadata: {
              contentType:
                source.httpMetadata?.contentType ?? "application/octet-stream",
            },
          });
          const stored = await paymentsRepo.setConfirmationKey(
            userId,
            paymentId,
            key,
            now,
          );
          // setConfirmationKey returns false when it matched no row —
          // shouldn't happen (we just created this payment under the
          // same userId/id) but the response must never claim a key
          // that was not actually recorded against the payment.
          if (stored) record = { ...record, confirmationR2Key: key };
        }
      } catch (err) {
        log.warn("draft→payment confirmation copy failed", {
          draftId,
          paymentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return c.json(record, 201);
  })
  .get("/:id/raw", async (c) => {
    const draft = await DraftsRepo.for(c.env.DB).get(
      c.get("userId"),
      c.req.param("id"),
    );
    if (draft?.rawR2Key == null) return c.json({ error: "not found" }, 404);
    const object = await c.env.RECEIPTS.get(draft.rawR2Key);
    if (object === null) return c.json({ error: "not found" }, 404);
    return new Response(object.body, {
      headers: {
        "content-type":
          object.httpMetadata?.contentType ?? "application/octet-stream",
        "cache-control": "private, max-age=300",
      },
    });
  });
