# Capture "Report error" — design

Date: 2026-10-12
Branch: `feat/capture-report-error`
Status: implemented on this branch
Builds on: `2026-10-11-feedback-design.md` (feedback storage and mail)

## Why

When capture reads a flyer or receipt wrong, the user fixes the fields
on the review screen and moves on. The mistake — and the evidence that
would let someone improve the extraction — is lost. A one-tap report
that carries the original, what was recognised, and what the user
corrected it to turns every fix into a test case.

## Where the button is

1. **Draft review** (`/drafts/:id`): "Report error" (`draft-report-error`)
   under the form, for any draft whose extraction ran. Opens a `Sheet`.
2. **Capture screen, extraction failed** (the 502 path, where no draft
   exists): "Report this" (`capture-report-error`) beside the error line.
   Opens the same sheet with the file the user just chose.

## What a report carries — by default, nothing to type

| Part | Draft review | Extraction failed |
|---|---|---|
| Original | The draft's raw object (photo or `.eml`), copied **server-side** from the draft's R2 key — never re-uploaded from the phone | The chosen file, uploaded as an image part |
| Recognised | `draft.extracted`, read **by the server** from the draft row (the client's copy is not trusted) | — (nothing was recognised) |
| Corrected | The review form's current values, sent by the client | — |
| What was wrong | Optional text. Empty is allowed when at least one field was corrected; the message is then generated: "Capture read N field(s) wrong: …" | Optional; defaults to "Capture could not read this." |
| Include original | Checkbox, on by default | Checkbox, on by default |

The sheet shows the user exactly what will be sent: a field-by-field
table of recognised → corrected for the fields that differ (unchanged
fields omitted), the "what was wrong" box, the include-original switch,
and Send.

## Storage

Migration `0022_feedback_kind_context.sql`:

```sql
ALTER TABLE feedback ADD COLUMN kind TEXT NOT NULL DEFAULT 'general';
ALTER TABLE feedback ADD COLUMN context_json TEXT;
```

- `kind`: `general` (the help-sheet form) | `capture-error`.
- `context_json` for `capture-error`:

```json
{ "stage": "review" | "extraction-failed",
  "draftId": "…" | null,
  "source": "photo" | "email" | null,
  "originalKey": "u/<uid>/feedback/<id>/original" | null,
  "originalType": "image/jpeg" | "message/rfc822" | null,
  "recognized": { …ExtractedData… } | null,
  "corrected": { "kind": "gig", "clientName": "…", "location": "…",
                 "dateTimes": [ms…], "amountCents": 12500,
                 "category": null, "notes": "…" } | null,
  "error": "extraction failed — try again" | null }
```

The draft's original is **copied** to `u/<uid>/feedback/<id>/original`
so the report survives the draft being discarded. It is listed in
`images_json` only when it is an image (the `general` contract stays
"images are images"); an email original is reachable through
`originalKey`. Nothing is backfilled: existing rows are `general` with
a null context.

## API

`POST /api/feedback` gains optional multipart parts:

- `kind` — `general` (default) or `capture-error`; anything else is 400.
- `draftId` — only with `capture-error`; must be one of the caller's
  drafts (404 otherwise, nothing stored). The server reads its
  `extracted_json` and copies its raw object.
- `corrected` — JSON, ≤ 16 KB, only with `capture-error`; 400 if it does
  not parse.
- `stage`, `error` — short strings, only with `capture-error`.

Validation, the daily cap and the store-then-mail order are unchanged.

## Mail

Subject `[Gigsy capture error] <first 60 chars>`. Body adds a
"Recognised → Corrected" block, one line per differing field, plus the
draft id and source. The original is attached (image or `.eml`), after
any user images.

## Webapp

- `lib/capture-report.ts` (pure): `correctedFromForm(state)` and
  `captureCorrections(recognized, corrected)` →
  `{ field, label, recognized, corrected }[]` for differing fields
  (money in cents compared as numbers, dates as ms, strings trimmed and
  case-sensitive); `captureReportMessage(text, corrections)`.
- `components/CaptureReportSheet.tsx`: the sheet above, built on `Sheet`;
  props `{ open, onClose, mode: { draftId, recognized, corrected } |
  { file, error } }`; test ids `capture-report-sheet`,
  `capture-report-diff`, `capture-report-row-<field>`,
  `capture-report-message`, `capture-report-original`,
  `capture-report-send`, `capture-report-notice`.
- `api.sendFeedback` gains `kind`, `draftId`, `corrected`, `stage`,
  `error` (all optional).
- DraftReview and Capture render the buttons and the sheet.

## Help

A new scenario, `report-capture-error` ("Report a wrong reading", Capture
section), starts on `/drafts`, follows the person into a draft they tap
(a `navigate` step), points at "Report error" with "fix the fields
first", clicks it (opening the sheet creates nothing), and walks the
diff table, the optional message, the include-original switch, and
Send, stopping without sending. It also names Capture's "Report this"
for a reading that failed outright. With no drafts it takes `no-drafts`
and explains where reports come from. `Drafts.tsx` gains `drafts-list`
(rendered only with rows) and `drafts-empty` for the branch, and
help-fixtures.ts seeds one pending draft through the stub extractor when
the account has none, so CI takes `drafts-showing`.

`capture-receipt`'s last step adds one sentence pointing at it.

## Handoff

`docs/handoffs/2026-10-11-gigsy-analytics-feedback.md` gains the two
columns, the context shape, and a note that `capture-error` reports
should render the recognised → corrected table and the original.

## Tests

Backend: `capture-error` with a photo draft stores the row with kind
and context (recognised from the server's draft, corrected from the
client), copies the original to the feedback key and lists it as an
image, mails it as an attachment with the diff in the body; an email
draft copies the `.eml`, does not list it as an image, still attaches
it; another user's draft is 404 and stores nothing; bad `corrected`
JSON and unknown `kind` are 400; `general` is unchanged; the migration
defaults existing rows.

Webapp: `captureCorrections` (differing fields only, money/date/string
comparison, kind change), `captureReportMessage` (generated vs typed);
the sheet (diff rows, empty-text send allowed with corrections and
refused without, include-original off omits `draftId`, success and
error copy); DraftReview button opens the sheet with the current form
values; Capture's failure path offers "Report this" with the file.
