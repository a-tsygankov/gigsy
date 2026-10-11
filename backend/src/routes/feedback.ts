/**
 * POST /api/feedback — what the help sheet's "Send feedback" form
 * submits (docs/superpowers/specs/2026-10-11-feedback-design.md).
 *
 * One multipart request: a `message`, optional `page` and
 * `clientVersion` parts, and up to five `image` parts. The order of
 * work is the point of this file:
 *
 *   1. validate everything, storing nothing — a refused request leaves
 *      no row and no R2 object, so a client retrying after a 400 cannot
 *      pile up half-records;
 *   2. the daily cap (429), counted from the table like the capture
 *      budget is counted from drafts;
 *   3. store: images to R2 under the user's own prefix, then the row,
 *      marked `unsent`;
 *   4. only then mail, and record what happened to it.
 *
 * Step 3 before step 4 is why a configuration gap — no binding, no
 * sender address, no admins — costs the operator a row that says
 * `unsent` rather than costing the user what they wrote. The sender is
 * DI'd (`makeFeedbackRouter(senderFactory)`), the capture router's
 * provider-factory pattern, so tests inject a recorder, a thrower, or a
 * null factory and never touch the binding.
 */
import { Hono } from "hono";
import type { Bindings } from "../env.ts";
import { requireAuth, type AuthVars } from "../middleware/auth.ts";
import { parseAllowlist } from "../auth/allowlist.ts";
import { startOfUtcDayMs } from "../capture/limits.ts";
import { FeedbackRepo } from "../repos/feedback.ts";
import { UsersRepo } from "../repos/users.ts";
import type { FeedbackImage } from "../db/schema.ts";
import { buildFeedbackMail } from "../feedback/mail.ts";
import {
  senderFromEnv,
  type OutgoingAttachment,
  type SenderFactory,
} from "../feedback/sender.ts";
import { log } from "../logger.ts";

/** The message, after trimming. The webapp enforces the same number
 *  client-side (help/runtime/FeedbackForm.tsx); the server's copy is
 *  the one that counts. */
export const MAX_MESSAGE_CHARS = 4000;
/** Screenshots per submission. */
export const MAX_IMAGES = 5;
/** Per image — a phone screenshot is well under 8 MB. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** All images together — bounds one request's R2 writes and the size
 *  of the mail that carries them. */
export const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
/** Submissions per user per UTC day. Fixed, not a var: unlike the AI
 *  cap there is no provider bill behind it, only inbox noise. */
export const FEEDBACK_DAILY_CAP = 20;

/** Context fields are stored as sent but bounded, so a client cannot
 *  turn `page` into a second message body. Cut, not refused: the
 *  message is what matters and these are only context. */
const MAX_CONTEXT_CHARS = 500;

/** Where a user's images live. User-scoped like captures
 *  (`u/<userId>/captures/<draftId>`): the prefix is the tenancy
 *  boundary in R2 the way `user_id` is in D1, and there is no read
 *  route at all — only the mail carries the bytes anywhere. */
export function feedbackImageKey(
  userId: string,
  feedbackId: string,
  index: number,
): string {
  return `u/${userId}/feedback/${feedbackId}/${index}`;
}

/** A multipart file part. `File` is what Workers' FormData yields for
 *  one; the duck-typed check guards against a runtime that hands back
 *  something else with the same methods. */
// `string | File` spelled out rather than the DOM lib's
// `FormDataEntryValue`, which @cloudflare/workers-types does not export.
function isFilePart(value: string | File | null): value is File {
  return (
    value !== null &&
    typeof value !== "string" &&
    typeof (value as File).arrayBuffer === "function"
  );
}

function optionalText(form: FormData, name: string): string | null {
  const value = form.get(name);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, MAX_CONTEXT_CHARS);
}

type Refusal = { status: 400 | 413; error: string };

/**
 * Everything that can be wrong with the images, decided before any
 * byte is stored. 413 for size, 400 for everything else — the webapp
 * shows the server's message either way, but a proxy or a log reader
 * can tell "too big" from "wrong shape".
 */
function checkImages(files: File[]): Refusal | null {
  if (files.length > MAX_IMAGES) {
    return { status: 400, error: `at most ${MAX_IMAGES} images` };
  }
  let total = 0;
  for (const file of files) {
    if (!file.type.startsWith("image/")) {
      return { status: 400, error: `"${file.name}" is not an image` };
    }
    if (file.size > MAX_IMAGE_BYTES) {
      return { status: 413, error: `"${file.name}" is larger than 8 MB` };
    }
    total += file.size;
  }
  if (total > MAX_TOTAL_IMAGE_BYTES) {
    return { status: 413, error: "images are larger than 20 MB together" };
  }
  return null;
}

/** The attachment's name in the mail: the file's own when the browser
 *  gave one, else a stable `image-<n>` with the subtype as extension. */
function attachmentName(file: File, index: number): string {
  const own = file.name.trim();
  if (own !== "" && own !== "blob") return own;
  const ext = file.type.split("/")[1] ?? "bin";
  return `image-${index + 1}.${ext}`;
}

export function makeFeedbackRouter(senderFactory: SenderFactory = senderFromEnv) {
  return new Hono<{ Bindings: Bindings; Variables: AuthVars }>()
    .use("*", requireAuth)
    .post("/", async (c) => {
      const userId = c.get("userId");

      let form: FormData;
      try {
        form = await c.req.formData();
      } catch {
        return c.json({ error: "expected multipart/form-data" }, 400);
      }

      // --- 1. validate, storing nothing ---------------------------------
      const rawMessage = form.get("message");
      const message = typeof rawMessage === "string" ? rawMessage.trim() : "";
      if (message === "") return c.json({ error: "message is required" }, 400);
      if (message.length > MAX_MESSAGE_CHARS) {
        return c.json(
          { error: `message is longer than ${MAX_MESSAGE_CHARS} characters` },
          400,
        );
      }

      // getAll keeps the client's order, which is the order the
      // thumbnails were shown in and the order the keys are numbered.
      // A non-file `image` part is refused rather than skipped: a client
      // that sends one is broken, and silently losing a screenshot is
      // the worst way to find out.
      const parts = form.getAll("image");
      if (parts.some((p) => !isFilePart(p))) {
        return c.json({ error: "image parts must be files" }, 400);
      }
      const files = parts.filter(isFilePart);
      const refusal = checkImages(files);
      if (refusal !== null) return c.json({ error: refusal.error }, refusal.status);

      // --- 2. the daily cap ----------------------------------------------
      const repo = FeedbackRepo.for(c.env.DB);
      const now = Date.now();
      if ((await repo.countSince(userId, startOfUtcDayMs(now))) >= FEEDBACK_DAILY_CAP) {
        return c.json({ error: "daily feedback limit reached" }, 429);
      }

      // The token names a user; the row needs their address. A token
      // that outlives its user is the only way to get here with none.
      const user = await UsersRepo.for(c.env.DB).get(userId);
      if (user === null) return c.json({ error: "unauthorized" }, 401);

      // --- 3. store ------------------------------------------------------
      const feedbackId = crypto.randomUUID();
      const images: FeedbackImage[] = [];
      const attachments: OutgoingAttachment[] = [];
      for (const [index, file] of files.entries()) {
        const key = feedbackImageKey(userId, feedbackId, index);
        const content = await file.arrayBuffer();
        await c.env.RECEIPTS.put(key, content, {
          httpMetadata: { contentType: file.type },
        });
        const name = attachmentName(file, index);
        images.push({ key, type: file.type, size: file.size, name });
        attachments.push({ filename: name, type: file.type, content });
      }

      const record = await repo.insert(userId, {
        id: feedbackId,
        userEmail: user.email,
        message,
        page: optionalText(form, "page"),
        clientVersion: optionalText(form, "clientVersion"),
        userAgent: (c.req.header("user-agent") ?? "").slice(0, MAX_CONTEXT_CHARS) || null,
        images,
        emailStatus: "unsent",
        now,
      });

      // --- 4. mail -------------------------------------------------------
      // Three ways to have nobody to mail, one status for all of them;
      // the log line names which, because an operator reading `unsent`
      // rows wants to know what to configure.
      const sender = senderFactory(c.env);
      const from = (c.env.FEEDBACK_FROM ?? "").trim();
      const admins = parseAllowlist(c.env.ADMIN_EMAILS);
      const gap =
        sender === null
          ? "no EMAIL binding"
          : from === ""
            ? "FEEDBACK_FROM is empty"
            : admins.length === 0
              ? "ADMIN_EMAILS is empty"
              : null;
      if (gap !== null) {
        log.warn("feedback stored but not mailed", { feedbackId, reason: gap });
        return c.json({ id: feedbackId, emailStatus: "unsent" });
      }

      try {
        const { messageId } = await sender!.send(
          buildFeedbackMail(record, attachments, from, admins),
        );
        await repo.setEmailStatus(feedbackId, "sent");
        log.info("feedback mailed", { feedbackId, messageId, admins: admins.length });
        return c.json({ id: feedbackId, emailStatus: "sent" });
      } catch (err) {
        // The row is already there; this only records why the mail is
        // not. Still a 200 to the client: their part succeeded, and
        // "saved, the team will see it" is true — the table is the
        // record whatever happened to the mail.
        const reason = err instanceof Error ? err.message : String(err);
        await repo.setEmailStatus(feedbackId, "failed", reason);
        log.error("feedback mail failed", { feedbackId, reason });
        return c.json({ id: feedbackId, emailStatus: "failed" });
      }
    });
}
