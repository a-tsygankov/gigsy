# Optional delivery — design

Date: 2026-09-20
Branch: `feat/optional-delivery`
Status: implemented on this branch

## Why

`delivered` (spec 2026-08-23) is a real stage for some work — a photo
shoot is not finished until the files are handed over — and a stage
that does not exist for the rest: a tasting shift is over when it is
over. Nothing forces the status, but the app assumes every completed
gig is waiting for it: the dashboard's "To deliver" tile counts every
completed job, and the status control offers `delivered` as the next
step on all of them. The user does not want to answer "does this one
get delivered?" on every gig form.

## Decision

Delivery is a property of the kind of work, and a client is almost
always one kind of work. So:

- **Per client:** `clients.needs_delivery`, a boolean on the client
  form ("Work for this client needs delivering"). A gig is
  *deliverable* when its client says so.
- **Global default:** a setting, "My clients expect delivery
  afterwards", off by default. It is the default value of the client
  flag on a NEW client, and the answer for a gig with no client.
- **Read live, not copied onto gigs.** Flipping a client's switch
  corrects that client's older jobs on the dashboard at once, which is
  what someone wants after realising it was set wrong. The gigs table
  does not change.
- **No per-gig override** in this cut. Add it only if a mixed client
  appears.

## What "deliverable" decides

- **Dashboard `awaitingDeliveryCount`** and its drill-down count only
  completed gigs that are deliverable: the gig's client has
  `needs_delivery`, or the gig has no client and the setting is on.
  Computed server-side, where the count already is.
- **The status control** (WorkCard) on a non-deliverable gig stops at
  `completed`; `delivered` is not offered. A gig already marked
  `delivered` still shows it (a stored value is never hidden).
- **Nothing about money or time moves.** Unpaid totals, invoices, the
  paid badge, busy time and nudges already treat completed and
  delivered alike.

## Backend

- Migration `0020_client_needs_delivery.sql`:
  `ALTER TABLE clients ADD COLUMN needs_delivery INTEGER NOT NULL DEFAULT 0;`
  No rebuild, nothing backfilled (every existing client is "no",
  matching the setting's default), same operator note as 0018/0019.
- `schema.ts` clients: `needsDelivery` boolean, default false.
- `ClientInput`: `needsDelivery: z.boolean().default(false)`; carried
  through `ClientsRepo.upsert`, `routes/clients.ts` and the sync
  `client` case.
- `domain/settings.ts`: `clientsExpectDelivery: z.boolean().default(false)`.
- `services/dashboard.ts`: `awaitingDeliveryCount` joins clients and
  applies the rule above; the settings value is read once per call.

## Webapp

- `types.ts`: `Client.needsDelivery`, `ClientInput.needsDelivery`;
  `local-store.putClient` stores and sends it (the `Required<>` outbox
  guard forces it).
- `settings-schema.ts`: `clientsExpectDelivery: boolean`.
- `lib/gig-delivery.ts`: `isDeliverable(gig, clients, settings)` and
  `offeredStatuses(gig, deliverable)` — the statuses the control lists.
- Settings: a toggle "My clients expect delivery afterwards" in the
  gig-defaults group, `data-testid="settings-clients-delivery"`, with a
  line saying it only sets the default for new clients.
- ClientEdit: a `Toggle` "Work for this client needs delivering",
  `data-testid="client-needs-delivery"`, defaulted from the setting on
  a new client, from the record on an existing one.
- WorkCard: reads the client and settings through the existing
  queries; the status `<select>` lists `offeredStatuses`.
- Dashboard: no change — the count comes from the server.

## Help

- `create-client`: a step on the new toggle (target
  `ClientNeedsDelivery`), saying what it changes and where the default
  comes from.
- `record-work` "Status" step: `delivered` appears only for clients
  whose work needs delivering, and where to turn that on.
- The dashboard "To deliver" copy, wherever a scenario describes it,
  says it counts only such work.

## Tests

Backend: column round-trips on both doors; a client posted without the
field reads false; the setting round-trips; the dashboard count with
mixed clients and the clientless case under both setting values.
Webapp: outbox payload carries `needsDelivery`; `isDeliverable` and
`offeredStatuses`; ClientEdit defaults from the setting and saves the
flag; WorkCard hides `delivered` for a non-deliverable gig and keeps a
stored one; the settings toggle writes the key. Help validation. E2E:
create a client with the toggle on and see it back on reopen.
