# The Money tab — payments and expenses in one place — design

Date: 2026-08-23
Branch: `feat/money-tab`
Status: approved, ready for planning

## Why

**A payment can exist and be unreachable.** Payments are opened from a
gig's detail screen (`GigDetail.tsx:257`) or from a confirmed draft, and
nowhere else. Phase 4 (migration `0016`) made an *unallocated* payment a
legitimate state — money received before anyone has said what it paid
for — and there is no screen that lists one. It is recorded, it is
counted in no gig's total, and the app offers no route to it.

**A payment can only be born attached to a gig.** The only creation
entry is `/payments/new?gigId=…`. An agency settling a week in one
transfer therefore has to be entered against one arbitrary gig and then
re-split — the exact workflow `0016` was written to remove.

**Money-out has a tab; money-in does not.** Expenses is a top-level
destination. Payments, the other half of the same question, is reachable
only by drilling into the work that happened to earn it.

## Decisions taken

| Question | Decision |
|---|---|
| Tab budget | The tab bar stays at **five**. `TabBar.tsx` documents that five fit at 375px over the 44px tap minimum; a sixth is not taken on for this. |
| How Payments gets in | The Expenses tab becomes **Money**, holding both lists behind a segmented control. |
| Tab label | **Money**. Matches the plain-noun style of Home / Gigs / Clients / Reports, and covers both directions. |
| Screen structure | Segmented control, one list at a time. Not a merged ledger, not stacked sections. |
| Routing | Two real routes, `/payments` and `/expenses`, sharing one shell. Not `/money?kind=`. |
| Payment filters | Allocation state, and free-text search. **No** client or date-range filter. |
| Search scope | Notes **+ client name + amount**. |
| Editing | Rows open the existing `PaymentEdit`. No inline allocate, no delete-from-list. |
| Creating | A `+` that creates a payment with **no gig attached**. |

## Structure

### Navigation

The Money tab points at `/payments`. Both `/payments` and `/expenses`
render one `Money` shell — header, segmented control, active list.

Two routes rather than one with a query parameter, for two reasons:
`/expenses` already exists and has callers — the `add-expense` help
scenario starts at `/expenses/new`, and `HelpProvider.test.tsx` asserts
navigation to `/expenses` — so keeping it costs nothing and breaking it
costs a sweep; and a segmented control is navigation, which belongs in
the path.

### Files

| File | Purpose |
|---|---|
| `screens/Money.tsx` | Shell: header, segmented control, renders the active list |
| `screens/money/Payments.tsx` | The payments list |
| `screens/money/PaymentFilters.tsx` | Filter UI, mirroring `screens/gigs/GigFilters.tsx` |
| `lib/payment-filters.ts` | Pure parse / apply / serialise — the testable core, mirroring `lib/gig-filters.ts` |
| `screens/Expenses.tsx` | Moves under the shell; otherwise unchanged |
| `components/TabBar.tsx` | Expenses → Money, `/expenses` → `/payments` |
| `components/Segmented.tsx` | New. No segmented control exists today; `TabBar` is bottom-fixed app nav and `Toggle` is a switch, so neither fits. |

`PaymentEdit.tsx` is **not** touched. It is 694 lines and already owns
amount, date, client, split and photo, behind invariants the server also
enforces (`services/payment-invariants.ts`). A second editing path would
duplicate split logic that has real money rules behind it.

## Allocation state

A payment's state is derived, not stored:

| State | Condition |
|---|---|
| `unallocated` | no allocations, or they sum to 0 |
| `partly` | allocations sum to more than 0 and less than the payment |
| `fully` | allocations sum to the payment |

The server refuses a split that exceeds its payment ("allocations exceed
the payment"), so a fourth over-allocated state is not reachable through
either door and is not modelled. A local sum that exceeds the amount is
treated as `fully` rather than crashing — Dexie can briefly hold a
half-synced pair, and a list is not the place to raise that.

### Reading it without N+1

`LocalStore` gains a bulk `listAllocations()`. `listAllocationsByPayment`
takes one payment id and would mean a query per row. `db.allocations` is
a Dexie table, so one `toArray()` grouped by `paymentId` serves the whole
list.

## Filters

Both live in the URL, the way `gig-filters.ts` does, so a filtered view
survives opening a payment and coming back.

- **Allocation state** — `all | unallocated | partly | fully`.
- **Search** — matches, case-insensitively, any of: notes, the client's
  name, or the amount. Amount matching is on the formatted decimal
  string, so `150` finds `150.00` and `1.50` does not.

Deliberately absent: client and date-range filters. The gig list has
them because a year of gigs is unnavigable without them; the payment
list is expected to be short, and search covers the client case.

`applyPaymentFilters(payments, allocationsByPayment, filters)` is a pure
function. It is the unit under test; the screen is a thin caller.

## Creating a payment

The `+` routes to `PaymentEdit` with **no** `gigId`, producing a payment
with no allocations — `unallocated`, and immediately visible under that
filter. Splitting it across gigs is `PaymentEdit`'s existing job.

This is the only new capability in the design. Everything else is a
route to something the app could already do.

## Error and empty states

| Situation | Behaviour |
|---|---|
| No payments at all | `EmptyState`, as the gig and client lists use, pointing at `+` |
| Filter matches nothing | A distinct message naming the filter, with a clear action — not the same copy as "you have no payments" |
| Allocations still loading | `ListSkeleton`, matching the gig list |
| Offline | Reads are local-first; the list renders from Dexie, and pending rows carry `SyncBadge` as elsewhere |

## Testing

- **`lib/payment-filters.test.ts`** — the substance. Allocation-state
  boundaries (zero, partial, exact, over), search across all three
  fields, a payment with null notes and null client, URL round-tripping.
- **`screens/money/Payments.test.tsx`** — renders a filtered list,
  empty-vs-no-match copy, `+` targets `PaymentEdit` without a `gigId`.
- **E2E** — one known breakage, already located.
  `webapp/e2e/signed-in.spec.ts:375` reaches the expense flow by
  clicking the tab **by its label**:

  ```ts
  await page.getByRole("link", { name: "Expenses" }).click();
  ```

  Renaming the tab to Money breaks that line. The fix is two clicks —
  the Money tab, then the Expenses segment — which is also the first
  real exercise of the segmented control, so it is worth doing that way
  rather than deep-linking to `/expenses` and skipping the nav.

  `webapp/e2e/help/help-fixtures.ts` also mentions expenses; it is
  route-based, not label-based, so it is expected to survive. Verify,
  do not assume.

  **Collision warning:** `signed-in.spec.ts` currently has uncommitted
  staged changes in the `test/e2e-real-regressions` worktree. Settle
  those before editing this file, or the two edits will fight.

An executable help scenario is **out of scope** unless asked for
separately. Adding one means a new `HelpTarget`, a registry entry, and a
CI-covered branch — a decision about documentation, not about this
screen.

## What this design does not do

- No inline allocation from a row.
- No delete from the list.
- No merged payments-and-expenses ledger.
- No change to `PaymentEdit`, the allocation model, or any server route.
- No sixth tab.
