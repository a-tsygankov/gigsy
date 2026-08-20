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
// payment draft is one atomic server-side operation (create the
// payment, copy the draft's photo to it, close the draft) and splitting
// that across two requests reopens exactly the race this route exists
// to avoid: the payment not existing yet when the photo copy runs.
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
  // three steps (create, copy, close) in one server-side operation.
  .post("/:id/confirm-payment", zValidator("json", ConfirmPayment), async (c) => {
    const userId = c.get("userId");
    const draftId = c.req.param("id");
    const { id: paymentId, ...input } = c.req.valid("json");

    const draftsRepo = DraftsRepo.for(c.env.DB);
    const draft = await draftsRepo.get(userId, draftId);
    if (draft === null) return c.json({ error: "not found" }, 404);
    if (draft.status !== "pending") {
      return c.json({ error: "draft already reviewed" }, 409);
    }

    if (
      input.gigId != null &&
      (await GigsRepo.for(c.env.DB).get(userId, input.gigId)) === null
    ) {
      return c.json({ error: "gigId does not reference your gig" }, 400);
    }

    const now = Date.now();
    const paymentsRepo = PaymentsRepo.for(c.env.DB);
    const upserted = await paymentsRepo.upsert(
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
    if (upserted === "forbidden") return c.json({ error: "not found" }, 404);
    let record = upserted.record;

    // The receipt IS the proof — copy it rather than asking the client
    // to re-upload bytes it already sent. Best-effort: a source object
    // that is missing or fails to copy must not stop the payment from
    // being recorded, or a storage hiccup would silently swallow real
    // money. A payment with no confirmation image is a payment the
    // user can still see and fix; a payment that never got created is
    // one they have to notice is missing and re-enter by hand.
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
          await paymentsRepo.setConfirmationKey(userId, paymentId, key, now);
          record = { ...record, confirmationR2Key: key };
        }
      } catch (err) {
        log.warn("draft→payment confirmation copy failed", {
          draftId,
          paymentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const confirmed = await draftsRepo.setStatus(userId, draftId, "confirmed", now);
    if (confirmed === "not-found" || confirmed === "conflict") {
      // Lost a race with another confirmation of the same draft. The
      // payment above is already real and stays real — only the
      // draft's own transition is refused.
      return c.json({ error: "draft already reviewed" }, 409);
    }

    return c.json(record, upserted.created ? 201 : 200);
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
