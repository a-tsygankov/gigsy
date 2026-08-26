# `parent_gig_id` — split and follow-up jobs — design

Date: 2026-08-25
Branch: `feat/parent-gig-id`
Status: approved, ready for planning
Source: `Gigsy — Feature Suggestions`, §2

## Why

Two related situations have no representation today:

- **Follow-up.** A new job for the same client, worth tracking as
  connected to where it came from.
- **Split.** One engagement that turns into several independently
  tracked jobs — each with its own status, amounts and expenses — but
  which should still read as one job when reviewing the client's
  history.

One nullable self-referencing column covers both directions: a follow-up
links back to the gig it followed; a split's children link back to the
gig they came from.

## Decisions taken

| Question | Decision |
|---|---|
| Shape | One nullable column on `gigs`, not a new table. |
| Depth | **One level**, enforced from both sides — see rules 3 and 5. |
| Client | **Same client only**, including both being null. |
| Deleting a parent | `ON DELETE SET NULL` — children survive as ordinary gigs with the link cleared. |
| Self-parent | Refused. |
| UI | `GigDetail` only: a "Part of" line and a "Follow-up jobs" list, plus a parent picker on the gig form. |
| Reports | **Out of scope.** No rollup, no grouped CSV. |
| Client history | **Out of scope.** No nesting in `ClientEdit`. |
| Create-follow-up shortcut | **Out of scope.** |

The link is purely for grouping. Each linked gig keeps full
independence: its own status, its own money, its own expenses. Nothing
is shared or inherited.

## Why this ships after `delivered`

Widening the `gigs.status` CHECK constraint required rebuilding the
table (`0017`). A self-referencing foreign key on `gigs` would have
forced that rebuild to stage the table against itself. Sequencing
`delivered` first kept it simple, and that migration has now shipped.

## The migration

```sql
ALTER TABLE gigs ADD COLUMN parent_gig_id TEXT
  REFERENCES gigs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_gigs_parent ON gigs(parent_gig_id);
```

No rebuild. SQLite permits a `REFERENCES` clause on `ADD COLUMN`
provided the column's default is NULL, which it is. Nothing is
backfilled: every existing gig gets NULL, which is the correct value
for a gig that is part of nothing.

**One thing to verify, not assume.** That `ON DELETE SET NULL` is
*accepted* does not prove D1 *honours* it. `0015`'s header records that
this D1 instance accepts and silently ignores `PRAGMA foreign_keys=off`,
so the codebase's standard is to establish behaviour against the real
instance rather than infer it from the DDL. The plan tests a real parent
delete and asserts the child survives with a null link. If D1 does not
honour the action, the fallback is to clear children explicitly in
`GigsRepo.remove` — which the offline path needs regardless (below).

## Six invariants, one module, two doors

Every gig write reaches D1 through the CRUD route (`routes/gigs.ts`) or
the offline outbox (`services/sync.ts`). `services/payment-invariants.ts`
exists because duplicating such checks across both doors produced a bug
that had to be fixed twice; these follow that pattern and live in one
module both doors call.

1. The parent must exist and belong to the same user.
2. The parent must have the **same `clientId`** — including both null.
3. The parent must not itself have a parent.
4. A gig may not be its own parent.
5. A gig that already has children may not acquire a parent.
6. A gig may not change client while its children still point at it.

**Rules 3 and 5 are the same rule from opposite sides, and an earlier
draft of this spec had only one of them.** Rule 3 stops a gig pointing
*at* a parented gig, which bounds depth from above. It does not stop a
gig that already has children from becoming someone's child — and that
produces exactly the two-level chain "one level" forbids. Proved against
the live D1 instance during implementation: `C → B` accepted, then
`B → A` accepted, leaving a stored chain two deep and reachable through
the intended picker. Rule 5 closes it.

**Cycles are unreachable, and that survives the correction.** If A's
parent is B, then B has no parent, so B cannot later adopt A — the last
edge closing any cycle must target a node that already has one. No
traversal, no recursive query, no cycle detection at any length. The
single cycle this does not catch is a gig parenting itself, which is why
rule 4 is stated separately.

**Rule 6 exists because the invariant is two-directional while the check
is not.** Rule 2 is stated as a property of the link, but a write that
names no parent at all can falsify it: move a parent to another client
and its children are left pointing at a gig on somebody else's history.
Refused rather than cascaded, following `payment-invariants.ts`'s I5,
which takes the same stance when a payment's client change would strand
its allocations.

Each violation is refused with a distinct message, identical at both
doors — the route maps it to a 400, `sync.ts` to an `errored()` result.

## Sync — where the risk actually is

`parentGigId` joins `Gig`, `GigInput`, the Dexie record, and the outbox
payload.

The repo is well defended here, and deliberately so. `OutboxPayload<T> =
Required<T>` (`lib/local-store.ts`) and `FullGigInput =
Required<Omit<GigInput, "source" | "amountPaidCents">>`
(`lib/gig-input.ts`) both exist because of a real incident, recorded at
length in both files: `durationMinutes` and `reimbursable` were added to
the record in Phase 9 and left out of the payload, so *"every gig saved
for months reached the server with no duration, and calendar sync drew
them all at its four-hour fallback. Nothing failed; the data just never
arrived."*

Adding a field to `GigInput` therefore stops both files compiling until
it is handled. That guard is the reason this is a small change rather
than a dangerous one — but it must not be worked around, and a test that
the payload really carries the value is still worth having, because
`Required` proves the key is present, not that the right value reaches
the wire.

**Dexie needs a version bump.** `db.ts` is at `version(4)`; `gigs` is
indexed `"id, dateTime, modifiedAt"`. Finding a gig's children is a
query by `parentGigId`, which Dexie cannot serve unindexed. Version 5
adds it. Each version's `stores()` is a delta over the previous, as that
file's own comments explain.

## The part the source note does not cover

`ON DELETE SET NULL` is a **server** behaviour. The webapp holds its own
Dexie copy and deletes locally first, so `LocalStore.removeGig` must
clear its children's `parentGigId` locally too. Otherwise the local
record keeps a link to a gig that no longer exists — a dangling
reference the UI would try to resolve — until the next pull happens to
correct it. Offline, that could be days.

This is the same shape as the server rule, enforced in a second place
because the two stores are independent. It gets its own test.

## UI

`GigDetail` gains:

- a **"Part of"** line when `parentGigId` is set, linking to the parent
  gig by its display title;
- a **"Follow-up jobs"** list when the gig has children, each linking to
  that gig.

The gig form gains a **parent picker**, listing that client's other gigs
that do not already have a parent — the same-client and one-level rules
are what keep that list short enough to read. A gig with no client
offers only other client-less gigs.

**A gig that already has follow-ups cannot take a parent at all** (rule
5), so for that gig the picker is disabled rather than empty, with a
line saying why. An empty dropdown reads as "nothing matches"; this is
"this gig cannot be a child", which is a different fact and one the user
can act on by unlinking its follow-ups first.

Nothing appears in reports, in the CSV export, or in `ClientEdit`'s
history groups.

## Testing

**Backend**, mirroring `test/payment-invariants.test.ts`:

- each of the six invariants refused, at **both** doors, with identical
  messages
- a cross-client link refused, including the both-null case being
  *allowed*
- a parent delete leaves its children alive with `parent_gig_id` null —
  the assertion that establishes whether D1 honours the FK action
- a gig with a parent still round-trips through the CRUD route and the
  outbox unchanged

**Webapp:**

- the outbox payload carries `parentGigId` — the specific failure this
  repo has already paid for once
- `LocalStore.removeGig` clears children's `parentGigId` locally
- `GigDetail` renders the parent line and the children list, and renders
  neither when the gig is unlinked
- the parent picker excludes: the gig itself, gigs of other clients, and
  gigs that already have a parent

## What this design does not do

- No reports rollup and no grouped CSV export.
- No nesting in `ClientEdit`'s client history.
- No "create follow-up" shortcut that pre-fills a new gig.
- No chains deeper than one level.
- No cross-client links.
- No shared or inherited data between linked gigs — not status, not
  money, not expenses.
