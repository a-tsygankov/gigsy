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
 *
 * CAPTURE ERRORS (migration 0022, docs/superpowers/specs/2026-10-12-
 * capture-report-error-design.md). A `kind` part says which form sent
 * the request: `general` (the help sheet; the default when the part is
 * absent) or `capture-error` (capture's "Report error"). Only the
 * latter may carry `draftId`, `corrected`, `stage` and `error`, and
 * every one of those is checked in step 1 with the rest — including
 * that `draftId` names one of the CALLER'S drafts (404 otherwise) — so
 * the store-nothing-on-refusal rule covers them too. Two things come
 * from the server, never the client: what was RECOGNISED (the draft
 * row's extracted_json — the phone's copy could say anything) and the
 * ORIGINAL (the draft's raw R2 object, copied in step 3 under this
 * feedback's own prefix so the report outlives the draft).
 */
import { Hono } from "hono";
import type { Bindings } from "../env.ts";
import { requireAuth, type AuthVars } from "../middleware/auth.ts";
import { parseAllowlist } from "../auth/allowlist.ts";
import { startOfUtcDayMs } from "../capture/limits.ts";
import { FeedbackRepo } from "../repos/feedback.ts";
import { DraftsRepo, type DraftRecord } from "../repos/drafts.ts";
import { UsersRepo } from "../repos/users.ts";
import {
  FEEDBACK_KINDS,
  type FeedbackContext,
  type FeedbackImage,
  type FeedbackKind,
} from "../db/schema.ts";
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

/** Where a capture-error report keeps its copy of the draft's original
 *  — beside the numbered screenshots, under a name that cannot collide
 *  with them. A copy, not a reference to the draft's own key: a
 *  discarded draft must not take the evidence with it. */
export function feedbackOriginalKey(userId: string, feedbackId: string): string {
  return `u/${userId}/feedback/${feedbackId}/original`;
}

/** The review form's values, as JSON. A form of seven fields is well
 *  under a kilobyte; 16 KB leaves room for long notes and a list of
 *  dates while keeping a row from becoming a dumping ground. */
export const MAX_CORRECTED_BYTES = 16 * 1024;

/** Parts only a capture-error report may carry. Refused on `general`
 *  rather than ignored: a help-sheet client sending one is broken, and
 *  silently dropping it is how that goes unnoticed. */
const CAPTURE_ONLY_PARTS = ["draftId", "corrected", "stage", "error"] as const;

/** The original's attachment name: `original.<subtype>`, `.eml` for an
 *  email (the subtype `rfc822` is not an extension any mail client
 *  opens), `.bin` for anything that would not make a clean extension. */
export function originalFilename(type: string): string {
  const mime = (type.split(";")[0] ?? "").trim().toLowerCase();
  if (mime === "message/rfc822") return "original.eml";
  const subtype = mime.split("/")[1] ?? "";
  return `original.${/^[a-z0-9]+$/.test(subtype) ? subtype : "bin"}`;
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

/** What the capture-error parts said, once they are known to be valid. */
interface CaptureParts {
  kind: FeedbackKind;
  draftId: string | null;
  corrected: Record<string, unknown> | null;
  stage: string | null;
  error: string | null;
}

function isFeedbackKind(value: string): value is FeedbackKind {
  return (FEEDBACK_KINDS as readonly string[]).includes(value);
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * `kind` and the parts that ride with it, decided before anything is
 * stored. An empty part counts as absent — a client that always sends
 * the field and leaves it blank means "not given", not "given, empty" —
 * but a FILE in any of these is refused: they are text, and a client
 * sending bytes there is broken.
 */
function readCaptureParts(form: FormData): CaptureParts | Refusal {
  const rawKind = form.get("kind");
  if (rawKind !== null && typeof rawKind !== "string") {
    return { status: 400, error: "kind must be text" };
  }
  const kindText = (rawKind ?? "").trim();
  const kind = kindText === "" ? "general" : kindText;
  if (!isFeedbackKind(kind)) {
    return { status: 400, error: `unknown kind "${kind.slice(0, 40)}"` };
  }

  const given: Partial<Record<(typeof CAPTURE_ONLY_PARTS)[number], string>> = {};
  for (const name of CAPTURE_ONLY_PARTS) {
    const value = form.get(name);
    if (value === null) continue;
    if (typeof value !== "string") return { status: 400, error: `${name} must be text` };
    const trimmed = value.trim();
    if (trimmed === "") continue;
    if (kind === "general") {
      return { status: 400, error: `${name} is only accepted with kind=capture-error` };
    }
    given[name] = trimmed;
  }

  let corrected: Record<string, unknown> | null = null;
  if (given.corrected !== undefined) {
    // Bytes, not characters: the cap bounds what is stored, and a
    // string of emoji is twice its .length in UTF-16 and up to four
    // times in UTF-8.
    if (new TextEncoder().encode(given.corrected).byteLength > MAX_CORRECTED_BYTES) {
      return { status: 400, error: "corrected is larger than 16 KB" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(given.corrected);
    } catch {
      return { status: 400, error: "corrected is not valid JSON" };
    }
    corrected = jsonObject(parsed);
    if (corrected === null) return { status: 400, error: "corrected must be a JSON object" };
  }

  return {
    kind,
    // Not cut: an id is looked up whole, and a cut one would only turn
    // a clear 404 into a confusing one.
    draftId: given.draftId ?? null,
    corrected,
    stage: given.stage?.slice(0, MAX_CONTEXT_CHARS) ?? null,
    error: given.error?.slice(0, MAX_CONTEXT_CHARS) ?? null,
  };
}

function isRefusal(value: CaptureParts | Refusal): value is Refusal {
  return "status" in value;
}

/** The draft's extracted_json as an object, or null if it somehow is
 *  not one. Defensive for the reason the mail builder is: an odd row
 *  must cost the report its diff, not the report itself. */
function recognizedFrom(draft: DraftRecord): Record<string, unknown> | null {
  try {
    return jsonObject(JSON.parse(draft.extractedJson));
  } catch {
    return null;
  }
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

      const capture = readCaptureParts(form);
      if (isRefusal(capture)) return c.json({ error: capture.error }, capture.status);

      // The draft is looked up here, with the rest of validation, so a
      // draft that is not the caller's stores nothing — not even the
      // screenshots that came with it. DraftsRepo.get is user-scoped:
      // another user's id and a made-up one are the same 404, which is
      // the point — the response must not confirm someone else's draft
      // exists.
      let draft: DraftRecord | null = null;
      if (capture.draftId !== null) {
        draft = await DraftsRepo.for(c.env.DB).get(userId, capture.draftId);
        if (draft === null) return c.json({ error: "draft not found" }, 404);
      }

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

      // The draft's original, copied server-side — the design's "never
      // re-uploaded from the phone". After the user's own images, so
      // the mail lists their screenshots first and the evidence last.
      // Listed in `images` only when it IS an image (the general
      // contract stays "images are images"); an email original is
      // reachable through context.originalKey, and attached either way.
      //
      // Best-effort, like confirm-payment's copy in routes/drafts.ts: an
      // original that is gone from R2, or a copy that fails, costs the
      // report its attachment, never the report — what the user wrote
      // and corrected is still worth having.
      let originalKey: string | null = null;
      let originalType: string | null = null;
      if (draft?.rawR2Key != null) {
        try {
          const source = await c.env.RECEIPTS.get(draft.rawR2Key);
          if (source !== null) {
            const type = source.httpMetadata?.contentType ?? "application/octet-stream";
            const content = await source.arrayBuffer();
            const key = feedbackOriginalKey(userId, feedbackId);
            await c.env.RECEIPTS.put(key, content, { httpMetadata: { contentType: type } });
            const name = originalFilename(type);
            if (type.startsWith("image/")) {
              images.push({ key, type, size: content.byteLength, name });
            }
            attachments.push({ filename: name, type, content });
            originalKey = key;
            originalType = type;
          }
        } catch (err) {
          log.warn("feedback original copy failed", {
            feedbackId,
            draftId: draft.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const context: FeedbackContext | null =
        capture.kind === "capture-error"
          ? {
              stage: capture.stage,
              draftId: draft?.id ?? null,
              source: draft?.source ?? null,
              originalKey,
              originalType,
              recognized: draft === null ? null : recognizedFrom(draft),
              corrected: capture.corrected,
              error: capture.error,
            }
          : null;

      const record = await repo.insert(userId, {
        id: feedbackId,
        userEmail: user.email,
        message,
        page: optionalText(form, "page"),
        clientVersion: optionalText(form, "clientVersion"),
        userAgent: (c.req.header("user-agent") ?? "").slice(0, MAX_CONTEXT_CHARS) || null,
        images,
        kind: capture.kind,
        context,
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
