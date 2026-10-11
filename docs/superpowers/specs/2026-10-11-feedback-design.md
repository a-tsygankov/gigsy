# Send feedback — design

Date: 2026-10-11
Branch: `feat/feedback`
Status: implemented on this branch

## Why

There is no way to tell the people running Gigsy that something is
wrong, from inside the app, with a screenshot. The help sheet is where
someone goes when they are stuck, so it is where the button lives.

## Decisions

| Question | Decision |
|---|---|
| Where | A "Send feedback" button in the help sheet (HelpSheet.tsx), beside the menu. It swaps the menu for a form inside the same sheet; "Back" returns. |
| What is sent | Free text (required, max 4000 chars), up to 5 images (each ≤ 8 MB — `MAX_IMAGE_BYTES` — and ≤ 20 MB together), and context the user does not type: the route they were on, the client version, the user agent. |
| Transport | One `multipart/form-data` POST to `/api/feedback`: `message`, `page`, and `image` parts. Not the outbox: feedback is online-only, like capture — the server is where the mail is sent from. |
| Storage | Always, before any mail: a `feedback` row in D1 and each image in R2 under `u/<userId>/feedback/<feedbackId>/<n>`. The images list (key, type, size, name) is one JSON column on the row — append-only records nobody queries by image. |
| Mail | Cloudflare Email Sending through a `send_email` binding (`EMAIL`), one message to every admin, images attached. Behind an `EmailSender` interface (the `ExtractionProvider` pattern), so tests inject a recorder and the route never touches the binding directly. |
| When mail cannot be sent | The feedback is still stored, the row records `email_status` = `unsent` (no binding / no sender address / no admins) or `failed` (the binding threw, with the message), and the client is told "saved, the team will see it" either way. Nothing a user wrote is lost to a configuration gap. |
| Admins | `ADMIN_EMAILS`, a **secret** (comma-separated), parsed by the same `parseAllowlist` the sign-in allowlist uses. A secret for the reason `ALLOWED_EMAILS` is one: addresses are personal data and this repository is public. Current list, set by the operator: `tsygankov@gmail.com`, `gigsy.test@gmail.com`. |
| Sender address | `FEEDBACK_FROM`, a var; empty means unconfigured. It must be on a domain onboarded for Email Sending. |
| The binding | NOT added to wrangler.toml yet: `[[send_email]]` on an account with no Email Sending domain is a deploy-time refusal this repository cannot afford on every merge. `EMAIL` is optional in `Bindings`; the operator adds the binding when the domain is onboarded (Task "Turn it on"). |
| Rate | 20 submissions per user per UTC day, counted from the table (the capture-budget pattern). |
| Admin UI | None. The mail is the admin UI; the table is the record. |

## Backend

- Migration `0021_feedback.sql`:
  ```sql
  CREATE TABLE feedback (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    user_email TEXT NOT NULL,
    message TEXT NOT NULL,
    page TEXT,
    client_version TEXT,
    user_agent TEXT,
    images_json TEXT NOT NULL DEFAULT '[]',
    email_status TEXT NOT NULL,
    email_error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_feedback_user_created ON feedback(user_id, created_at);
  ```
- `src/feedback/sender.ts`: `EmailSender { send(message: OutgoingEmail): Promise<{ messageId: string }> }`, `OutgoingEmail { from, to: string[], subject, text, attachments: { filename, type, content: ArrayBuffer }[] }`, `cloudflareSender(binding)`, and `senderFromEnv(env): EmailSender | null` (null without `env.EMAIL`).
- `src/feedback/mail.ts`: `buildFeedbackMail(record, images, from, to)` — subject `[Gigsy feedback] <first 60 chars>`, text body with who/when/page/version/agent and the message, images as attachments.
- `src/repos/feedback.ts`: `insert`, `countSince(userId, sinceMs)`, `setEmailStatus`.
- `src/routes/feedback.ts`: `makeFeedbackRouter(senderFactory = senderFromEnv)`, `POST /` behind `requireAuth`, parses multipart, validates (message 1–4000 chars after trim; ≤ 5 images; each `image/*`, ≤ 8 MB, ≤ 20 MB total; 413/400 with a message), checks the daily cap (429), stores, then mails; responds `{ id, emailStatus }`.
- `env.ts`: `EMAIL?: SendEmail` (typed locally — the binding's `send(message)` shape), `ADMIN_EMAILS?: string` (secret), `FEEDBACK_FROM?: string` (var, default `""` in wrangler.toml with a comment).
- Mounted at `/api/feedback`.

## Webapp

- `components/FilePicker.tsx`: `multiple?: boolean` and `onFiles?: (files: File[]) => void` (all chosen files); `onFile` keeps its meaning.
- `help/runtime/FeedbackForm.tsx`: textarea (`feedback-message`), `FilePicker` (`feedback-images`, `accept="image/*"`, multiple), thumbnails with a remove button each (`feedback-image-<i>`, `feedback-image-remove-<i>`), client-side limits with the same numbers as the server, offline notice (needs a connection), Send (`feedback-send`), Back (`feedback-back`). On success: "Thanks — it's on its way to the team." (and, when `emailStatus !== "sent"`, "Saved; the team will see it.") then Back. Sends `page` = current pathname.
- `HelpSheet.tsx`: `help-feedback` button opens the form; the heading reads "Send feedback" while it is open.
- `api.ts`: `sendFeedback(input: { message, page, images: File[] }): Promise<{ id, emailStatus }>` as multipart with the bearer token; `data-service.ts` pass-through.

## Tests

Backend: multipart POST stores the row and the images, mails every admin with attachments through the injected sender, records `sent`; no sender → stored, `unsent`; sender throws → stored, `failed` with the message; no admins → `unsent`; validation (empty message, too many images, oversize, non-image part) refused with nothing stored; the daily cap; 401 unauthenticated; another user cannot read the R2 key (there is no read route — assert the key is user-scoped).
Webapp: FilePicker multiple; FeedbackForm (typing, adding and removing images, limits, send → `sendFeedback` called with the parts, success copy, error copy, offline disables Send); HelpSheet shows the form and returns.
Help validation stays green (no new scenario: the button lives inside the sheet a tour closes).

## Turn it on (operator steps, not code)

1. Onboard a sending domain in Cloudflare → Compute → Email Service → Email Sending (gigsy.app once its DNS is on Cloudflare, or a subdomain).
2. `wrangler secret put ADMIN_EMAILS` → `tsygankov@gmail.com,gigsy.test@gmail.com`.
3. Add to `backend/wrangler.toml`: `[[send_email]]` `name = "EMAIL"`, and set `FEEDBACK_FROM = "feedback@<domain>"`.
4. Deploy; send one feedback with an image; confirm both inboxes receive it with the attachment.

Until then every feedback is stored with `email_status = unsent`.
