# Gig batches — capture from any file, several gigs at once — design

Date: 2026-09-18
Branch: `feat/gig-batches`
Status: approved by the request itself; implemented on this branch

## Why

Three asks, one feature:

1. **Capture from an existing picture or file.** The capture screen
   forced the camera (`capture="environment"` on a hidden input). On
   many phones that means no way to pick a flyer already in the photo
   library or a PDF booking sheet. Money → Payments already has the
   right control: a visible native file chooser that the OS turns into
   "camera / library / files".
2. **One capture, several gigs.** A booking sheet or a forwarded email
   often lists several shifts — same client, same venue, same fee,
   different dates. Extraction returned one date and the review screen
   created one gig.
3. **Add a gig by hand on several dates.** Same shape from the manual
   side: one description, N dates, N gigs.

And a constraint added mid-brief: **every gig created together must
share a correlation id in the database.**

## Decisions

| Question | Decision |
|---|---|
| Correlation | One nullable column, `gigs.batch_id TEXT`, indexed with `user_id`. Client-generated UUID, like every other id. |
| A batch of one | `batch_id` stays NULL. A single gig is not a batch; the column means "created with these others". |
| What is shared in a batch | Nothing after creation. Each gig is independent: own status, money, work log. The id is grouping only, exactly like `parent_gig_id`. |
| Where the id is minted | The webapp, in one helper (`lib/gig-batch.ts`) both the manual form and the draft review call. The server stores what it is given. |
| Per-date fields | Only the date-time differs between siblings. Duration, client, fee, location, notes are copied. Per-row duration is out of scope. |
| Extraction shape | `ExtractedData` gains `dateTimesMs: number[] | null`, every date the document names. `dateTimeMs` stays as the first one so older drafts and the stub still read. |
| File types for capture | Images and PDF. The Anthropic provider sends a PDF as a `document` block; Gemini takes it as `inline_data` already. Email attachments are unchanged (still images only). |
| Camera | Kept, as its own "Take a photo" button on a hidden `capture="environment"` input. The visible chooser has no `capture` attribute so the OS offers the library and files too. |
| Duplicate dates | Refused with a message. Two gigs at the same moment is a data-entry slip, and the form is the place to catch it. |
| Empty extra rows | Ignored on save. |
| After creating N > 1 | Navigate to the gig list. There is no single "the gig" to open. |
| Editing an existing gig | Single date, unchanged. Batches are made at creation only. |

## The migration

```sql
ALTER TABLE gigs ADD COLUMN batch_id TEXT;
CREATE INDEX IF NOT EXISTS idx_gigs_user_batch ON gigs(user_id, batch_id);
```

No rebuild, nothing backfilled, same two-statement shape and the same
operator caveat as 0018 (an ALTER cannot be `IF NOT EXISTS`; a retry
after a partial run needs the index statement alone).

## Both doors

`batchId` enters `GigInput` (zod, `entityId.nullish()`), `GigData`,
`GigsRepo.upsert`, the CRUD route and the `/api/sync` gig case. On the
webapp it is on `Gig`, `GigInput`, `gigToInput` (so `Required<>` keeps
it in the outbox payload) and `putGig`. An edit through
`commitGigPatch` carries it forward untouched.

## Components

- `FilePicker` (design-system, `components/FilePicker.tsx`): the visible
  native file input Payments had inline, made reusable: `accept`,
  `testId`, `onFile`, `disabled`. Payments and Capture both use it.
- `ExtraDatesField` (`components/ExtraDatesField.tsx`): a list of
  `DateTimeField` rows with remove buttons and an "+ Add another date"
  button. GigEdit (new only) and DraftReview both render it under the
  primary date.
- `lib/gig-dates.ts`: `collectGigDates(primary, extras)` → the
  de-duplicated list of moments, or a refusal message. Pure.
- `lib/gig-batch.ts`: `createGigBatch(data, base, dates)` → one
  `putGig` per date, a shared `batchId` when there is more than one.

## Testing

Backend: the column round-trips through both doors; a batch of three
posted through `/api/sync` reads back with one id; `dateTimesMs` parses
and rejects a non-integer; the Anthropic provider sends a PDF as a
document block and an image as an image block.

Webapp: `collectGigDates` (order, dedupe, blanks, refusal);
`createGigBatch` (N gigs, same batchId, null for one); the outbox
payload carries `batchId`; `FilePicker` hands the file up;
`ExtraDatesField` adds and removes rows; GigEdit saves three gigs from
one form; DraftReview seeds rows from `dateTimesMs` and confirms N
gigs; Capture accepts a chosen file and a camera shot.

Help: `create-gig` gains a step for the add-date button;
`capture-receipt` gains a step for the file chooser and its copy no
longer says the input is hidden. `pnpm help:validate` stays green.

## Out of scope

- Per-sibling duration or fee.
- Showing siblings on `GigDetail`, or any batch UI after creation.
- PDF attachments on email capture.
- Editing a batch as a unit.
