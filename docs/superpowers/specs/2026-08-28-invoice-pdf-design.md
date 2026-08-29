# Invoice PDF from Reports — design

Date: 2026-08-28
Branch: `feat/invoice-pdf`
Status: approved, ready for planning

## Why

Reports can already export what happened — income, expenses, a monthly
summary — as CSV. What it cannot do is produce the one document a
freelancer actually has to send: a bill, addressed to one agency, for
work that agency has not paid for yet.

That is a different artefact from an export. An export is for the user
and their bookkeeper; an invoice leaves the building. It needs a
counterparty, an identity to bill *from*, a number, and a total that
means "pay me this".

## Decisions taken

| Question | Decision |
|---|---|
| What is it | A real invoice — addressed, numbered, dated — not a statement or a PDF twin of the exports. |
| Persistence | **None.** A file, not a record. The next number lives in Settings. |
| How the PDF is made | A print stylesheet; the browser's own "Save as PDF". |
| Which gigs | Completed or delivered, in range, with something outstanding. |
| What else | Additional services, and reimbursable expenses as their own block. |
| Where | A new `/reports/invoice` route, reached from a section on `/reports`. |

### Why a print stylesheet, and not a PDF library

The deciding factor is text, not bundle size. PDF core fonts are
WinAnsi — Latin-1 and nothing else. Capture (docs/plan.md §8) writes
text lifted from forwarded emails and photographs straight into gig
titles, locations and client names, so a Cyrillic or CJK client name is
not hypothetical. A hand-rolled writer and jsPDF have the *same*
limitation, and both need an embedded, subsetted Unicode TTF
(~300KB+) to escape it.

The browser already has every font and every script. Rendering the
invoice as DOM and letting the print pipeline make the PDF gets correct
typography in any alphabet for zero bytes, works offline, and adds no
dependency to keep current.

Accepted costs, stated plainly: it is a two-step flow (Create invoice →
Print → Save as PDF), page margins vary between browsers, and the
filename is the browser's to choose, not ours.

### Why no stored invoice records

Storing invoices is the correct end state — you could re-download
exactly what you sent, and numbering could never collide. It is also a
subsystem: a table, a migration, sync, a local store, a list, statuses.
That is its own spec, roughly the size of the mid-tour-navigation work.
This one deliberately stops short of it, and the shape here does not
foreclose it: `buildInvoice` already returns a whole `InvoiceDocument`,
which is the thing a future table would persist.

## What an invoice contains

**Header** — the business block from Settings (name, address, contact,
tax id), the client's name, the invoice number, the issue date, and a
due date derived from `invoicePaymentTermsDays`.

**Work lines** — one per qualifying gig: date, title, and the amount
still owed on it, which is `outstandingCents(gig)` — `max(0, expected −
paid)`, not the whole fee. A gig qualifies when it is `completed` or
`delivered`, falls in range, belongs to the chosen client, and has
`outstandingCents > 0`. A gig already half-settled therefore bills for
the half that is left, and the invoice total is by construction what
the client still owes.

**Service lines** — a gig's additional services, listed under it, each
billed for its own remainder: `amountOfferedCents − amountPaidCents`,
matching how `incomeRows` already computes a service's outstanding.
`report-export.ts` treats services as income lines, so leaving them off
would under-bill.

A service is included when its parent gig is included, and only when it
has something outstanding. That leaves one case knowingly uncovered: a
fully-settled gig carrying an unpaid service is not billed, because the
gig itself does not qualify. Billing an orphaned service would mean an
invoice line with no work above it, which reads as a mistake to whoever
receives it. If it turns out to matter, the fix is a rule about gigs
whose services outstrip them — not a special case bolted onto this
one.

**Reimbursable expenses** — a separate block, listed after the work.
Reports already keeps `reimbursableCents` apart from net for exactly
this reason: they are costs the client agreed to cover, not earnings.

**Total**, and the payment details block from Settings.

## The pure core

`webapp/src/lib/invoice.ts` — no DOM, no React, no Playwright.

```ts
export interface InvoiceDocument {
  number: string;
  issuedAt: number;
  dueAt: number;
  business: BusinessDetails;
  client: { id: string; name: string };
  lines: InvoiceLine[];
  expenses: InvoiceLine[];
  totalCents: number;
}

export function buildInvoice(input: BuildInvoiceInput): InvoiceDocument;
export function formatInvoiceNumber(n: number): string; // 1 → "INV-0001"
```

It reuses `inRange` from `report-export.ts` and
`storedOrDerivedExpectedCents` from `gig-pay.ts` rather than
reimplementing either. That is not tidiness: `report-export.ts`'s own
header says filtering "deliberately reproduces the endpoint's SQL
semantics so a CSV can never disagree with the numbers it was exported
from", and an invoice is a third output that must agree with the other
two. A unit test pins that agreement directly — same client, same
range, same gigs.

## Screens

### `/reports` — a new Invoice section

A "Create invoice" button beside the existing Export section.

An invoice is addressed to somebody, so it needs one client. When the
client filter is on "All clients" the button is disabled and a hint
renders in its place, carrying its own test id
(`invoice-needs-client`). The hint is a real rendered element rather
than an inference from the button's `disabled` attribute — that is the
lesson the `no-gigs-yet` fix paid for: a help branch must read
something PRESENT, because an absence is also true while a screen is
loading or has failed.

### `/reports/invoice` — the document

Filters travel in the URL (`?client=…&from=…&to=…`) so the document is
refreshable and linkable, and so the route works as a `navigate` step's
destination — `matchesRoute` compares pathnames and ignores the query,
which is exactly the subset that module documents.

An `@media print` block hides the app header, the tab bar and the Print
button, leaving only the document. Its own route rather than a modal
because the stylesheet has to suppress everything that is not the
invoice, and a route makes that both simpler and testable.

## Settings — a "Business details" section

Settings are one JSON blob (`0009_user_settings.sql`) validated by a
zod schema on the SERVER, and `webapp/src/lib/settings-schema.ts`'s own
header says it is "a hand-kept mirror of backend/src/domain/settings.ts
… the server is the authority — it fills defaults on every read and
rejects anything it does not recognise". So new fields are a two-sided
change:

- `backend/src/domain/settings.ts` — add them to `SettingsSchema` with
  defaults, which is what makes them appear for existing users.
- `webapp/src/lib/settings-schema.ts` — mirror the interface.

No migration: the blob column already exists. A **worker patch bump**
is required, because `Version bump check` fails a PR that changes
`backend/**` without one.

`webapp/src/screens/settings/BusinessSection.tsx` renders them:

| Field | Type | Default |
|---|---|---|
| `businessName` | `string \| null` | `null` |
| `businessAddress` | `string \| null` | `null` |
| `businessContact` | `string \| null` | `null` |
| `businessTaxId` | `string \| null` | `null` |
| `businessPaymentDetails` | `string \| null` | `null` |
| `invoiceNextNumber` | `number` | `1` |
| `invoicePaymentTermsDays` | `number` | `14` |

### Two rules about the number

**Allocated when the document opens, not when it prints.** A number on
screen must be the one that gets sent; allocating at print time means
the displayed number and the stored counter can diverge — trivially, if
the user prints twice. The cost is that abandoning an invoice burns a
number. Gaps in an invoice sequence are ordinary; repeats are not.

**An invoice with no lines allocates nothing.** It renders "nothing to
invoice for this client and period" and leaves the counter alone.

Missing business details never block generation. The document renders
with a prompt to fill them in, linking to Settings — a half-filled
invoice a user can see is more useful than a refusal.

## The help topic

A new scenario `create-invoice`, category `money`, `startRoute:
"/reports"`, registered after `find-a-payment`.

1. Highlight the date range.
2. Highlight the client select — an invoice is addressed to one client.
3. A **branch**, resolved lazily, after the user has had the chance to
   pick one:
   - `invoice-needs-client` visible → one step explaining that a client
     must be chosen, ending on a **terminal step**.
   - otherwise → a **navigate step** onto `/reports/invoice`, then the
     document, then the Print button.

Both alternatives read a present element. The branch sits after a step
the user may act on, which is only correct because `runTour` now
expands branches as it reaches them — before that change this scenario
could not have been written.

### A gap this scenario ships with

**CI will take `invoice-needs-client`.** `help-runner.ts` performs
highlight steps without choosing anything, and a `select` step cannot
name a client id statically — ids are UUIDs generated per account. So
the navigate step, the invoice document and the Print button are
**prose in CI**: exactly the §6 category README already warns about,
where a renamed test id would not fail the suite.

This is recorded in the scenario's header and in README §6 rather than
papered over. The manual walkthrough is what covers it, and
`expectedCiBranches` is `["invoice-needs-client"]` so the day CI starts
taking the other branch, the assertion fails and someone looks.

## Testing

| Layer | What it proves |
|---|---|
| `invoice.test.ts` | Line selection (status, range, client, outstanding), partly-paid gigs billing the remainder, services attaching to their gig, reimbursable-only expense filtering, totals, number formatting, empty result. Plus agreement with `report-export.ts` on the same inputs. |
| `Invoice.test.tsx` | Renders lines and total; the empty state; the missing-business-details prompt; the number shown is the one allocated. |
| `Reports.test.tsx` | The button is disabled and the hint renders with no client; enabled with one; the URL it navigates to carries the filters. |
| `BusinessSection.test.tsx` | Fields round-trip through settings. |
| e2e | Generating an invoice from `/reports` produces a document with the expected lines, and the print stylesheet actually applies — asserted by reading a computed style, the way `reachability.spec.ts` proves `help.css` reached the page rather than trusting a class name. |
| `help:validate` + `help:test` | The scenario is structurally valid and takes `invoice-needs-client`. |

Printing itself is not assertable — no browser automation can drive the
native print dialog. What is assertable is that the document is right
and that the print rules are in force.

## What this design does not do

- **No stored invoices.** See above; it is the next spec, not this one.
- **No emailing.** The user saves a PDF and sends it however they send
  things.
- **No tax or VAT calculation.** `businessTaxId` is a string printed on
  the document. Rates, jurisdictions and reverse charge are a domain of
  their own.
- **No per-line editing.** The lines are what the ledger says. Changing
  them means changing the gig.
- **No multi-currency.** The existing `currency` setting formats the
  total, as everywhere else in the app.
