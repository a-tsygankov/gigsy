# Gig picker — choosing a gig from hundreds — design

Date: 2026-09-18
Branch: `feat/gig-picker`
Status: approved; implemented on this branch

## Why

Three screens ask the user to pick a gig, and all three do it with a
native `<select>`:

| Screen | Control | Option shows | Candidates |
|---|---|---|---|
| Payment split rows (`PaymentEdit`) | `payment-gig-N` | title + date | the payment's client |
| Gig form "Part of" (`GigEdit`) | `gig-parent-select` | title only | same client, no parent of its own |
| Expense "Linked gig" (`ExpenseEdit`) | `expense-gig` | location + date | every gig |

Three label formats, three placeholders, no search anywhere. With two
hundred gigs a dropdown is unusable, and a recurring job ("Arrange a
tasting") appears many times for different clients and dates, so a
one-line option cannot be told apart from its neighbours.

The Gigs tab already solves the finding problem: search, status,
client, date range, hide-past and four sorts, all in pure helpers in
`lib/gig-filters.ts`. The picker reuses that machinery rather than
growing a second one.

## Decisions

| Question | Decision |
|---|---|
| Shape | One `GigPicker` component: a trigger styled like an input, opening a full-screen sheet with the Gigs-tab filter bar and a list of selectable rows. |
| Why a sheet, not a popover | The list needs the whole screen on a phone: a search box, the filter panel and enough rows to scan. A popover under the field would clip all three. |
| What the closed trigger shows | The chosen gig as the same two-line summary the Gigs tab row uses: heading (`gigDisplayTitle`), then client · date · location, plus its `StatusPill`. Nothing chosen shows the caller's placeholder. |
| Filter state | Local to the open sheet. Not the URL, not the saved gig-list view. Picking a gig is a moment, not a place. |
| Candidate rules | Stay with the caller, passed in as a `gigs` list already narrowed. The picker never decides which gigs are eligible. |
| Disabled | A `disabledReason` string renders the trigger disabled with that line under it, replacing GigEdit's `gig-parent-blocked` hint in place. |
| Row component | The Gigs-tab row is extracted to `GigRow` and used by both the list (as a link) and the picker (as a button). One row, no drift. |
| Sheet primitive | A design-system `Sheet` (`components/Sheet.tsx`): `role="dialog"`, `aria-modal`, Escape closes, focus moves to the heading on open and returns to the trigger on close, body scroll locked while open. HelpSheet is left as it is. |
| Help targets | `gig-parent-select`, `expense-gig`, `payment-gig-0` stay as the testids of the trigger buttons, so every scenario keeps resolving. Their comments in `targets.ts` are rewritten: they describe `<select>`s today. |
| Labels | One placeholder vocabulary: "Not linked" (expense), "Not part of anything" (parent), "Choose a gig…" (payment). Passed in; the picker has no default. |

## Component contract

```ts
interface GigPickerProps {
  /** Eligible gigs, already narrowed by the caller. */
  gigs: readonly Gig[];
  clients: readonly Client[];
  /** Selected gig id, "" for none. */
  value: string;
  onChange: (id: string) => void;
  /** Trigger testid. The sheet suffixes it: `-sheet`, `-search`,
   *  `-list`, `-row-<id>`, `-clear`, `-close`. */
  testId: string;
  /** Accessible name and the sheet's heading. */
  label: string;
  /** Shown on the trigger when nothing is chosen. */
  placeholder: string;
  /** Renders the trigger disabled and explains why beneath it. */
  disabledReason?: string | null;
  /** Whether the "none" choice is offered inside the sheet. Default
   *  true. */
  allowNone?: boolean;
}
```

Inside the sheet: `GigFilters` (existing component, unchanged) over
`applyGigFilters(gigs, filters, clientNames, now)`, a "none" row when
`allowNone`, then one `GigRow` per visible gig with `selected` marked
and `onSelect` closing the sheet. The empty states mirror the Gigs tab:
"No gigs match these filters" with a Clear button, and "No gigs to
choose from" when the caller passed none.

## Sites

- **ExpenseEdit**: `GigPicker` with every gig, placeholder "Not
  linked". The local `gigLabel` helper is deleted.
- **GigEdit**: `GigPicker` with `parentOptions`, placeholder "Not part
  of anything", `disabledReason` set when `hasChildren`. The
  client-change effect that clears an invalid parent is unchanged.
- **PaymentEdit**: one `GigPicker` per split row with `offeredGigs`,
  placeholder "Choose a gig…", `allowNone` false (a split row without a
  gig is removed, not blanked). Row `aria-label` "Gig N" kept.

## Testing

- `Sheet`: opens with focus on the heading, Escape calls `onClose`,
  focus returns to the trigger.
- `GigRow`: renders heading, sub-line and pill; link and button modes.
- `GigPicker`: trigger shows placeholder, then the chosen gig's
  heading, client and date; opening lists the candidates; search
  narrows; picking writes the id and closes; the none row clears;
  `disabledReason` disables and explains; `allowNone: false` offers no
  none row.
- Screens: GigEdit parent-picker tests rewritten against the picker
  (same cases, driven by opening the sheet and clicking rows); a new
  `ExpenseEdit.test.tsx`; PaymentEdit split rows pick through the
  sheet.
- Gigs tab tests unchanged in intent, still green after the row
  extraction.
- E2E: `money.spec.ts` "one payment covers two gigs" drives the sheet
  through a small `gigPicker(page, testId)` helper; a new test on the
  expense form picks a gig by search.

## Out of scope

- A gig filter on Reports.
- Multi-select.
- Creating a gig from inside the picker.
- Replacing HelpSheet with the new primitive.
