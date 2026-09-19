# New client from the gig form, and a smarter capture match — design

Date: 2026-09-19
Branch: `feat/client-create-and-match`
Status: implemented on this branch

## Why

Two gaps, one control:

1. **Adding a gig for a client that does not exist yet** means leaving
   the gig form, adding the client, coming back and starting over. The
   client field should offer "New client…" and take the name there.
2. **A gig captured from a photo or email** names a client the way the
   flyer spells it: `ACME`, `Acme Staffing LLC`, `F.F.A.`, `full field
   agency`. Today the server's bigram matcher either links it or offers
   a new client, and the review screen shows the outcome as a banner
   the user cannot act on except by retyping. It must recognise
   initials and spelling-only differences, and when it is not sure it
   must ask rather than guess.

## Decisions

| Question | Decision |
|---|---|
| Where the new client is typed | Inside the client field itself: a `ClientSelect` component whose select carries a "New client…" option that reveals a name box. Used by the gig form and the draft review. |
| When the client row is written | On save of the gig, not when "New client…" is picked. A client stub created for a gig that is then cancelled would be an orphan on the Clients tab. |
| Value shape | `ClientChoice`: `{ kind: "none" }`, `{ kind: "existing", id }`, or `{ kind: "new", name }`. The screen resolves `new` to an id at save time through one helper. |
| Matching tiers | The server matcher returns a confidence and the review screen reads it in three bands: **confident** (≥ 0.9): preselect, say so; **unsure** (match below 0.9): ask "Is this X?" with one-tap Yes / No; **none**: preselect "New client" with the extracted name filled in. |
| What "smart" covers | Case and punctuation (already); **initials** — `FFA`/`F.F.A.` against "Full Field Agency" and the reverse, both directions; **word containment** — `Acme` against "Acme Staffing", "Acme Staffing LLC" against "Acme Staffing"; bigram similarity as before for spelling slips. |
| Confidences | exact-after-normalisation 1.0; initials 0.75; containment 0.8; Dice ≥ 0.6 its own score. Initials and containment are deliberately below 0.9 so they ASK. |
| Confirm gate | While an "Is this X?" question is unanswered, the Confirm button is disabled with a line saying so. A guessed link is worse than an extra tap. |
| Client-side re-match | None. The server matched at capture time against the same client list the device pulls; a client added since is one tap away in the select. |

## Backend

`backend/src/capture/client-match.ts` gains two tests before the Dice
fallback, in this order after the exact check:

- `initials(name)`: the first letter of each word. A match when the
  normalised target equals the candidate's initials, or the candidate
  equals the target's initials, and the initials are at least two
  letters (a one-letter "match" is noise). Confidence 0.75.
- containment: one normalised name's word list is a prefix-or-subset of
  the other's, with the shorter at least one whole word. Confidence 0.8.

`MATCH_THRESHOLD` stays 0.6 for Dice. The best confidence wins across
candidates as today. `matchedName` is unchanged.

Tests: initials both directions, punctuated initials (`F.F.A.`),
one-letter initials refused, containment both directions, containment
beats a weaker Dice on another candidate, case-only difference is 1.0,
the existing five still pass.

## Webapp

### `components/ClientSelect.tsx`

```ts
type ClientChoice =
  | { kind: "none" }
  | { kind: "existing"; id: string }
  | { kind: "new"; name: string };

interface ClientSelectProps {
  clients: readonly Client[];
  value: ClientChoice;
  onChange: (next: ClientChoice) => void;
  testId: string;            // the <select>; the name box is `${testId}-new-name`
  label?: string;
  noneLabel?: string;        // default "No client"
  disabled?: boolean;
}
```

The select lists "No client", every client, then "＋ New client…"
(value `__new__`). Choosing it emits `{ kind: "new", name: "" }` and
the name box appears under the select, focused, with a hint "Saved
with the gig". Typing emits `new` with the name. Choosing anything
else collapses the box. A `new` value with a blank name is refused by
the screen at save ("Give the new client a name."), not by the control.

### `lib/client-choice.ts`

`resolveClientChoice(data, choice): Promise<string | null>` — `none` →
null, `existing` → id, `new` → `putClient(randomUUID, { name })` then
its id. One place, both screens.

### GigEdit

`FormState.clientId: string` becomes `client: ClientChoice`. The
parent-picker rules keep reading a client id: `existing` → id, `none`
and `new` → null (a brand-new client has no other gigs, so the "Part
of" list is empty for it, which is correct). `submit` resolves the
choice before building `fields`, on both the create and edit paths.

### DraftReview

The gig kind's "Client" input (disabled when matched) becomes
`ClientSelect` plus a match banner above it:

- confident: banner "Matched existing client: **X** (97%)", select
  preset to X.
- unsure: banner "Looks like **X** — is that right?" with buttons
  **Yes, it's X** and **No, new client "Name"** (`draft-match-yes`,
  `draft-match-no`). Select preset to none until answered; Confirm
  disabled with "Answer the client question first." Either button sets
  the select and clears the question; changing the select by hand also
  clears it.
- none, name extracted: select preset to `new` with the name.
- none, no name: select at none.

The gig commit handler calls `resolveClientChoice` and passes the id.

### Help

- `create-gig` "Client" step: says the list ends in "New client…",
  that the name is typed right there and the client is created when
  the gig is saved.
- `capture-receipt` last step: says the review screen either names the
  client it matched, asks "is this X?" when it is only close (initials,
  a longer or shorter form of the name), or offers a new client with
  the name it read; and that Confirm waits for the answer.
- No new targets: the name box and the banners only exist after a
  choice, and both walks are highlight-only.

## Testing

Backend: the matcher cases above. Webapp: `ClientSelect` (options,
new-client box appears/collapses, emits each shape, disabled);
`resolveClientChoice` (three shapes, creates once); GigEdit (new client
typed → `putClient` then `putGig` with that id; blank new name
refused; "Part of" list empty for a new client); DraftReview (three
bands render as designed; unsure gates Confirm; Yes links, No creates;
confident confirms without a question; none creates from the extracted
name). E2E: on `/gigs/new` pick "New client…", type a name, save, and
the gig's screen shows that client.

## Out of scope

- Contact/notes for the new client (the client's own form has them).
- Re-matching on the device against clients added after capture.
- Merging two existing clients.
