# `parent_gig_id` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a gig point at the gig it came from, so a follow-up or a split reads as one engagement, without sharing any data between them.

**Architecture:** One nullable self-referencing column on `gigs`, added by a plain `ALTER TABLE` (no rebuild). Four invariants live in one module that both write doors call. The webapp carries the field through Dexie and the outbox, and mirrors `ON DELETE SET NULL` locally.

**Tech Stack:** Cloudflare D1 (SQLite), Drizzle, Hono, zod, Vitest with `@cloudflare/vitest-pool-workers`, React 18, Dexie 4, TanStack Query 5.

**Spec:** `docs/superpowers/specs/2026-08-25-parent-gig-id-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `backend/migrations/0018_gig_parent.sql` | **Create.** `ALTER TABLE` + index. |
| `backend/test/helpers/db.ts` | **Modify.** Import 0018; extend `MIGRATIONS`. |
| `backend/src/db/schema.ts` | **Modify.** `gigs.parentGigId` + index. |
| `backend/src/repos/gigs.ts` | **Modify.** `GigData.parentGigId`, written by `upsert`. |
| `backend/src/domain/schemas.ts` | **Modify.** `GigInput.parentGigId`. |
| `backend/test/gig-parent-column.test.ts` | **Create.** Round-trip + the FK-action question. |
| `backend/src/services/gig-invariants.ts` | **Create.** The four rules, one module. |
| `backend/src/routes/gigs.ts` | **Modify.** Call the check; map a violation to 400. |
| `backend/src/services/sync.ts` | **Modify.** Call the same check; map to `errored()`. |
| `backend/test/gig-parent-invariants.test.ts` | **Create.** Every rule, at both doors. |
| `webapp/src/lib/types.ts` | **Modify.** `Gig.parentGigId`, `GigInput.parentGigId`. |
| `webapp/src/lib/db.ts` | **Modify.** Dexie `version(5)`, `gigs` indexed on `parentGigId`. |
| `webapp/src/lib/local-store.ts` | **Modify.** Payload field; `removeGig` clears children. |
| `webapp/src/lib/gig-input.ts` | **Modify.** `gigToInput` carries it. |
| `webapp/src/lib/local-store.test.ts` | **Modify.** Payload + orphan-clearing tests. |
| `webapp/src/screens/GigDetail.tsx` | **Modify.** "Part of" line, "Follow-up jobs" list. |
| `webapp/src/screens/GigDetail.test.tsx` | **Create or modify.** Both surfaces. |
| `webapp/src/screens/GigEdit.tsx` | **Modify.** Parent picker. |
| `webapp/src/screens/GigEdit.test.tsx` | **Create or modify.** Picker exclusions. |

**Do not** add reports rollup, CSV grouping, `ClientEdit` nesting, or a create-follow-up shortcut. All four are explicitly out of scope.

---

### Task 1: The column, end to end, with nothing enforcing it yet

**Files:**
- Create: `backend/migrations/0018_gig_parent.sql`
- Modify: `backend/test/helpers/db.ts`, `backend/src/db/schema.ts`, `backend/src/repos/gigs.ts`, `backend/src/domain/schemas.ts`, `backend/src/routes/gigs.ts`, `backend/src/services/sync.ts`
- Test: `backend/test/gig-parent-column.test.ts`

- [ ] **Step 1: Write the migration**

Create `backend/migrations/0018_gig_parent.sql`:

```sql
-- A gig can name the gig it came from.
--
-- Two situations, one column. A FOLLOW-UP links back to the job it
-- followed. A SPLIT's children link back to the engagement they came
-- out of. The link is grouping only: each gig keeps its own status,
-- its own money, its own expenses. Nothing is shared or inherited.
--
-- NO REBUILD, unlike 0015 and 0017. SQLite permits a REFERENCES clause
-- on ADD COLUMN provided the column's default is NULL, which it is.
-- This is why `delivered` (0017) shipped first: a self-referencing key
-- on gigs would have forced that rebuild to stage the table against
-- itself.
--
-- NOTHING IS BACKFILLED. Every existing gig gets NULL, which is the
-- right value for a gig that is part of nothing.
--
-- ON DELETE SET NULL: deleting a parent costs the grouping, never the
-- work. Each child is an independent job carrying its own money, so
-- CASCADE would destroy records nobody asked to remove, and refusing
-- the delete would turn a working action into an error.
--
-- THE ACTION IS NOT ASSUMED TO WORK. That D1 accepts this DDL does not
-- prove it honours the action — 0015's header records this instance
-- accepting and silently ignoring PRAGMA foreign_keys=off. A test
-- deletes a real parent and asserts the child survives with a null
-- link. If it turns out D1 does not honour it, GigsRepo.remove clears
-- children explicitly instead; the webapp has to do that locally
-- regardless (lib/local-store.ts).
ALTER TABLE gigs ADD COLUMN parent_gig_id TEXT
  REFERENCES gigs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_gigs_parent ON gigs(parent_gig_id);
```

- [ ] **Step 2: Wire it into the test migration list**

In `backend/test/helpers/db.ts`, add beside the other imports:

```ts
import gigParentSql from "../../migrations/0018_gig_parent.sql?raw";
```

Then replace the existing `const MIGRATIONS = [...]` block (there must be exactly one) with:

```ts
export const MIGRATIONS_BEFORE_GIG_PARENT = [
  ...MIGRATIONS_BEFORE_DELIVERED_STATUS,
  DELIVERED_STATUS_MIGRATION,
];

export const GIG_PARENT_MIGRATION = gigParentSql;

const MIGRATIONS = [
  ...MIGRATIONS_BEFORE_GIG_PARENT,
  GIG_PARENT_MIGRATION,
];
```

- [ ] **Step 3: Write the failing test**

Create `backend/test/gig-parent-column.test.ts`:

```ts
/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * The column itself: does it round-trip, and does D1 honour
 * ON DELETE SET NULL?
 *
 * The second question is the reason this file exists. 0015's header
 * records this D1 instance accepting and silently ignoring
 * `PRAGMA foreign_keys=off`, so "the DDL was accepted" is not evidence
 * the action runs. If the last test here fails, the migration's own
 * header names the fallback: clear children explicitly in
 * GigsRepo.remove.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";

const U1 = "gig-parent-column-user";
const ACME = "ba000000-0000-4000-8000-000000000001";
const PARENT = "bb000000-0000-4000-8000-000000000001";
const CHILD = "bb000000-0000-4000-8000-000000000002";

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
  await api(U1, "PUT", `/api/clients/${ACME}`, { name: "Acme" });
});

describe("gigs.parent_gig_id", () => {
  it("round-trips through the CRUD route", async () => {
    await api(U1, "PUT", `/api/gigs/${PARENT}`, {
      clientId: ACME,
      status: "confirmed",
    });
    const res = await api(U1, "PUT", `/api/gigs/${CHILD}`, {
      clientId: ACME,
      status: "lead",
      parentGigId: PARENT,
    });
    expect(res.status).toBeLessThan(300);
    const body = (await res.json()) as { parentGigId: string | null };
    expect(body.parentGigId).toBe(PARENT);

    const read = await api(U1, "GET", `/api/gigs/${CHILD}`);
    const got = (await read.json()) as { parentGigId: string | null };
    expect(got.parentGigId).toBe(PARENT);
  });

  it("defaults to null for a gig that is part of nothing", async () => {
    const id = "bb000000-0000-4000-8000-000000000003";
    await api(U1, "PUT", `/api/gigs/${id}`, { clientId: ACME, status: "lead" });
    const read = await api(U1, "GET", `/api/gigs/${id}`);
    const got = (await read.json()) as { parentGigId: string | null };
    expect(got.parentGigId).toBeNull();
  });

  it("keeps the child alive with a null link when its parent is deleted", async () => {
    // The question this file exists for. If this fails, D1 accepted the
    // ON DELETE SET NULL clause without honouring it, and the fallback
    // is to clear children explicitly in GigsRepo.remove.
    const p = "bb000000-0000-4000-8000-000000000004";
    const c = "bb000000-0000-4000-8000-000000000005";
    await api(U1, "PUT", `/api/gigs/${p}`, { clientId: ACME, status: "confirmed" });
    await api(U1, "PUT", `/api/gigs/${c}`, {
      clientId: ACME,
      status: "lead",
      parentGigId: p,
    });

    const del = await api(U1, "DELETE", `/api/gigs/${p}`);
    expect(del.status).toBe(204);

    const read = await api(U1, "GET", `/api/gigs/${c}`);
    expect(read.status).toBe(200);
    const got = (await read.json()) as { parentGigId: string | null };
    expect(got.parentGigId).toBeNull();
  });
});
```

Check `api`'s signature and the `GET /api/gigs/:id` route exist before running; if the route differs, read the gig back through whatever route the other suites use rather than changing what is asserted.

- [ ] **Step 4: Run it and confirm it fails**

```bash
cd backend && pnpm exec vitest run test/gig-parent-column.test.ts
```

Expected: FAIL — `parentGigId` is not accepted or not returned, so the first test fails on `undefined`.

- [ ] **Step 5: Add the column to the Drizzle schema**

In `backend/src/db/schema.ts`, in the `gigs` table, beside `clientId`:

```ts
    parentGigId: text("parent_gig_id"),
```

Drizzle does not need the `references()` helper here — the constraint lives in the migration, and adding a self-reference in the table definition creates a circular type reference. Add the index alongside the existing ones:

```ts
    parentIdx: index("idx_gigs_parent").on(t.parentGigId),
```

- [ ] **Step 6: Carry it through the repo**

In `backend/src/repos/gigs.ts`, add to `GigData` (after `clientId`):

```ts
  parentGigId: string | null;
```

`upsert` builds its row from `GigData`; add `parentGigId` wherever the other fields are written. Read that method and follow its existing shape exactly — do not restructure it.

- [ ] **Step 7: Accept it at the zod boundary**

In `backend/src/domain/schemas.ts`, in `GigInput`, after `clientId`:

```ts
    /** The gig this one came from — a follow-up, or one arm of a split.
     *  Grouping only: nothing is shared or inherited. The rules that
     *  keep it coherent live in services/gig-invariants.ts, because a
     *  zod schema cannot ask the database whether the parent exists,
     *  belongs to the same client, or already has a parent of its own. */
    parentGigId: entityId.nullish(),
```

- [ ] **Step 8: Pass it through both doors**

`backend/src/routes/gigs.ts` — in the object passed to `repo.upsert`, beside `clientId`:

```ts
        parentGigId: input.parentGigId ?? null,
```

`backend/src/services/sync.ts` — in the `case "gig":` block's `gigsRepo.upsert` call, beside `clientId`:

```ts
                parentGigId: parsed.data.parentGigId ?? null,
```

- [ ] **Step 9: Run it and confirm it passes**

```bash
cd backend && pnpm exec vitest run test/gig-parent-column.test.ts
```

Expected: PASS, 3 tests.

**If the third test fails**, D1 did not honour `ON DELETE SET NULL`. Do not delete the test and do not weaken it. Instead, clear children explicitly at the top of `GigsRepo.remove`, before the delete:

```ts
    // D1 did not honour ON DELETE SET NULL on a column added by ALTER
    // TABLE (verified, not assumed — see 0018's header). Clearing the
    // link here keeps the rule the same: deleting a parent costs the
    // grouping, never the work.
    await this.db
      .update(gigs)
      .set({ parentGigId: null })
      .where(and(eq(gigs.parentGigId, id), eq(gigs.userId, userId)));
```

Then re-run, and say clearly in your report which of the two paths is live.

- [ ] **Step 10: Run the whole backend suite**

```bash
cd backend && pnpm test
```

Expected: PASS. Every suite applies the full `MIGRATIONS` list, which now ends with 0018.

- [ ] **Step 11: Commit**

```bash
git add backend/migrations/0018_gig_parent.sql backend/test/helpers/db.ts backend/src/db/schema.ts backend/src/repos/gigs.ts backend/src/domain/schemas.ts backend/src/routes/gigs.ts backend/src/services/sync.ts backend/test/gig-parent-column.test.ts
git commit -m "feat(db): a gig can name the gig it came from"
```

---

### Task 2: The four invariants, one module, both doors

**Files:**
- Create: `backend/src/services/gig-invariants.ts`
- Modify: `backend/src/routes/gigs.ts`, `backend/src/services/sync.ts`
- Test: `backend/test/gig-parent-invariants.test.ts`

Read `backend/src/services/payment-invariants.ts` first. Its header explains why checks that both doors must satisfy live in one module: they were duplicated once, a bug was found in both copies, and fixing one did not fix the other.

- [ ] **Step 1: Write the failing test**

Create `backend/test/gig-parent-invariants.test.ts`:

```ts
/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * The rules that keep parentGigId coherent, enforced identically at
 * both doors — PUT /api/gigs/:id and a sync "gig" op.
 *
 * Rule 3 (a parent may not itself have a parent) is doing more work
 * than it looks. It makes cycles unreachable: if A's parent is B then
 * B has none, so B cannot later adopt A. No traversal, no recursive
 * query, no cycle detection. The one cycle it does NOT catch is a gig
 * naming itself, which is why rule 4 exists separately.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";

const U1 = "gig-parent-inv-user";
const U2 = "gig-parent-inv-other";
const ACME = "ca000000-0000-4000-8000-000000000001";
const BRAVO = "ca000000-0000-4000-8000-000000000002";

const TOP = "cb000000-0000-4000-8000-000000000001";      // Acme, no parent
const CHILD = "cb000000-0000-4000-8000-000000000002";    // Acme, parent TOP
const OTHER_CLIENT = "cb000000-0000-4000-8000-000000000003"; // Bravo
const NO_CLIENT_A = "cb000000-0000-4000-8000-000000000004";
const NO_CLIENT_B = "cb000000-0000-4000-8000-000000000005";
const FOREIGN = "cb000000-0000-4000-8000-000000000006";  // belongs to U2

/** One sync op, through POST /api/sync. */
async function syncGig(
  userId: string,
  id: string,
  payload: Record<string, unknown>,
): Promise<{ status: string; error?: string }> {
  const res = await api(userId, "POST", "/api/sync", {
    ops: [{ entity: "gig", op: "upsert", id, modifiedAt: Date.now(), payload }],
  });
  const body = (await res.json()) as {
    results: { id: string; status: string; error?: string }[];
  };
  return body.results[0]!;
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
  await seedUser(env.DB, U2);
  await api(U1, "PUT", `/api/clients/${ACME}`, { name: "Acme" });
  await api(U1, "PUT", `/api/clients/${BRAVO}`, { name: "Bravo" });

  await api(U1, "PUT", `/api/gigs/${TOP}`, { clientId: ACME, status: "confirmed" });
  await api(U1, "PUT", `/api/gigs/${CHILD}`, {
    clientId: ACME,
    status: "lead",
    parentGigId: TOP,
  });
  await api(U1, "PUT", `/api/gigs/${OTHER_CLIENT}`, { clientId: BRAVO, status: "lead" });
  await api(U1, "PUT", `/api/gigs/${NO_CLIENT_A}`, { status: "lead" });
  await api(U1, "PUT", `/api/gigs/${NO_CLIENT_B}`, { status: "lead" });
  await api(U2, "PUT", `/api/gigs/${FOREIGN}`, { status: "lead" });
});

describe("parent rules — CRUD route", () => {
  const NEW = "cc000000-0000-4000-8000-00000000000";

  it("refuses a parent that is not yours", async () => {
    const res = await api(U1, "PUT", `/api/gigs/${NEW}1`, {
      clientId: ACME,
      status: "lead",
      parentGigId: FOREIGN,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("parentGigId does not reference your gig");
  });

  it("refuses a parent belonging to another client", async () => {
    const res = await api(U1, "PUT", `/api/gigs/${NEW}2`, {
      clientId: ACME,
      status: "lead",
      parentGigId: OTHER_CLIENT,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("parentGigId does not reference the same client");
  });

  it("refuses a parent that already has a parent", async () => {
    const res = await api(U1, "PUT", `/api/gigs/${NEW}3`, {
      clientId: ACME,
      status: "lead",
      parentGigId: CHILD,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("parentGigId already has a parent of its own");
  });

  it("refuses a gig naming itself", async () => {
    const res = await api(U1, "PUT", `/api/gigs/${NEW}4`, {
      clientId: ACME,
      status: "lead",
      parentGigId: `${NEW}4`,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("a gig cannot be its own parent");
  });

  it("allows two client-less gigs to link", async () => {
    // Both null IS the same client. The rule is about coherence of the
    // client's history, and two unattributed gigs share that answer.
    const res = await api(U1, "PUT", `/api/gigs/${NEW}5`, {
      status: "lead",
      parentGigId: NO_CLIENT_A,
    });
    expect(res.status).toBeLessThan(300);
    expect((await res.json()).parentGigId).toBe(NO_CLIENT_A);
  });

  it("refuses a client-less child under a client's gig", async () => {
    const res = await api(U1, "PUT", `/api/gigs/${NEW}6`, {
      status: "lead",
      parentGigId: TOP,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("parentGigId does not reference the same client");
  });
});

describe("parent rules — sync door, byte-identical messages", () => {
  const S = "cd000000-0000-4000-8000-00000000000";

  it("refuses a parent that is not yours", async () => {
    const r = await syncGig(U1, `${S}1`, {
      clientId: ACME,
      status: "lead",
      parentGigId: FOREIGN,
    });
    expect(r.status).toBe("error");
    expect(r.error).toBe("parentGigId does not reference your gig");
  });

  it("refuses a parent belonging to another client", async () => {
    const r = await syncGig(U1, `${S}2`, {
      clientId: ACME,
      status: "lead",
      parentGigId: OTHER_CLIENT,
    });
    expect(r.status).toBe("error");
    expect(r.error).toBe("parentGigId does not reference the same client");
  });

  it("refuses a parent that already has a parent", async () => {
    const r = await syncGig(U1, `${S}3`, {
      clientId: ACME,
      status: "lead",
      parentGigId: CHILD,
    });
    expect(r.status).toBe("error");
    expect(r.error).toBe("parentGigId already has a parent of its own");
  });

  it("refuses a gig naming itself", async () => {
    const r = await syncGig(U1, `${S}4`, {
      clientId: ACME,
      status: "lead",
      parentGigId: `${S}4`,
    });
    expect(r.status).toBe("error");
    expect(r.error).toBe("a gig cannot be its own parent");
  });

  it("accepts a legitimate link", async () => {
    const r = await syncGig(U1, `${S}5`, {
      clientId: ACME,
      status: "lead",
      parentGigId: TOP,
    });
    expect(r.status).not.toBe("error");
  });
});
```

**Verify before running:** the sync response shape (`results[].status` / `.error`) against `backend/test/sync.test.ts`, and the CRUD error shape (`{ error }` with 400) against `backend/test/gigs-routes.test.ts`. Correct the helpers to match reality; do not change the messages being asserted.

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd backend && pnpm exec vitest run test/gig-parent-invariants.test.ts
```

Expected: FAIL — nothing enforces the rules yet, so every refusal test gets a success instead.

- [ ] **Step 3: Write the invariants module**

Create `backend/src/services/gig-invariants.ts`:

```ts
/**
 * The rules a gig's `parentGigId` must satisfy, checked once here
 * rather than at each door that happens to be handling the request.
 *
 * Every gig write reaches D1 through the CRUD route (routes/gigs.ts)
 * or the offline outbox (services/sync.ts). `payment-invariants.ts`
 * exists because that same pair of doors each carried its own copy of
 * a check, both copies had the same bug, and fixing one did not fix
 * the other. This module follows it.
 *
 * Rule 3 carries the weight. A parent may not itself have a parent,
 * which makes cycles UNREACHABLE rather than merely detected: if A's
 * parent is B, then B has no parent, so B cannot later adopt A. No
 * traversal, no recursive CTE, no depth limit. The single cycle it
 * does not close is a gig naming itself, which rule 4 handles.
 */
import { GigsRepo } from "../repos/gigs.ts";

export interface InvariantViolation {
  ok: false;
  message: string;
}

function violation(message: string): InvariantViolation {
  return { ok: false, message };
}

/**
 * Returns the violation that should stop this write, or null when the
 * parent link is acceptable — including when there is no link at all.
 *
 * `clientId` is the client the gig will have AFTER this write, not the
 * one it has now: a write can move a gig and set its parent in the
 * same operation, and the rule has to hold against the result.
 */
export async function checkGigParent(
  d1: D1Database,
  userId: string,
  id: string,
  parentGigId: string | null,
  clientId: string | null,
): Promise<InvariantViolation | null> {
  if (parentGigId === null) return null;

  if (parentGigId === id) {
    return violation("a gig cannot be its own parent");
  }

  const parent = await GigsRepo.for(d1).get(userId, parentGigId);
  if (parent === null) {
    return violation("parentGigId does not reference your gig");
  }

  // Both null IS the same client: the rule exists so a client's history
  // reads coherently, and two unattributed gigs share that answer.
  if ((parent.clientId ?? null) !== clientId) {
    return violation("parentGigId does not reference the same client");
  }

  // One level. This is what makes cycles unreachable — see the header.
  if (parent.parentGigId !== null) {
    return violation("parentGigId already has a parent of its own");
  }

  return null;
}
```

- [ ] **Step 4: Call it from the CRUD route**

In `backend/src/routes/gigs.ts`, before the `repo.upsert(...)` call:

```ts
    const parentViolation = await checkGigParent(
      c.env.DB,
      c.get("userId"),
      id,
      input.parentGigId ?? null,
      input.clientId ?? null,
    );
    if (parentViolation !== null) {
      return c.json({ error: parentViolation.message }, 400);
    }
```

and import it:

```ts
import { checkGigParent } from "../services/gig-invariants.ts";
```

- [ ] **Step 5: Call it from the sync door**

In `backend/src/services/sync.ts`, in `case "gig":`, immediately after the existing `clientId` ownership check and before `gigsRepo.get`:

```ts
        const parentViolation = await checkGigParent(
          d1,
          userId,
          op.id,
          parsed.data.parentGigId ?? null,
          parsed.data.clientId ?? null,
        );
        if (parentViolation !== null) {
          results.push(errored(op.id, parentViolation.message));
          break;
        }
```

Import it alongside the other service imports. The variable that holds the `D1Database` in that function may not be named `d1` — read the surrounding code and use the real one.

- [ ] **Step 6: Run it and confirm it passes**

```bash
cd backend && pnpm exec vitest run test/gig-parent-invariants.test.ts
```

Expected: PASS, 11 tests.

- [ ] **Step 7: Prove each rule is load-bearing**

Comment out each of the four checks in `gig-invariants.ts` in turn, run the suite, and confirm exactly the expected pair of tests (one per door) fails each time. Restore after each. A rule whose removal breaks nothing is not being tested.

Report the four results.

- [ ] **Step 8: Run the whole backend suite and commit**

```bash
cd backend && pnpm test
git add backend/src/services/gig-invariants.ts backend/src/routes/gigs.ts backend/src/services/sync.ts backend/test/gig-parent-invariants.test.ts
git commit -m "feat(gigs): keep a parent link coherent at both write doors"
```

---

### Task 3: The webapp carries it to the wire

**Files:**
- Modify: `webapp/src/lib/types.ts`, `webapp/src/lib/db.ts`, `webapp/src/lib/local-store.ts`, `webapp/src/lib/gig-input.ts`
- Test: `webapp/src/lib/local-store.test.ts`

This is where the documented incident lives. `OutboxPayload<T> = Required<T>` and `FullGigInput = Required<Omit<GigInput, …>>` both exist because `durationMinutes` and `reimbursable` were added to the record and not the payload, so *"every gig saved for months reached the server with no duration… Nothing failed; the data just never arrived."* Adding a field to `GigInput` will stop both files compiling. That is the guard working — satisfy it, never route around it.

- [ ] **Step 1: Write the failing test**

Append to `webapp/src/lib/local-store.test.ts`:

```ts
describe("gig parent link", () => {
  it("sends parentGigId to the server, not just to Dexie", async () => {
    // The failure this guards is silent: the local record keeps the
    // value and the screen keeps showing it, right up until a pull
    // overwrites it with the server's null. That happened once already
    // (see the OutboxPayload comment in local-store.ts).
    const { store, db } = makeStore();
    await store.putGig(G1, { status: "confirmed" });
    await store.putGig(G2, { status: "lead", parentGigId: G1 });

    const ops = await db.pendingOps.toArray();
    const op = ops.find((o) => o.entityId === G2);
    expect((op?.payload as { parentGigId?: string }).parentGigId).toBe(G1);
  });

  it("clears a child's link locally when its parent is removed", async () => {
    // ON DELETE SET NULL is a SERVER behaviour. Dexie is a separate
    // store and deletes locally first, so without this the local child
    // holds a link to a gig that no longer exists — offline, possibly
    // for days.
    const { store } = makeStore();
    await store.putGig(G1, { status: "confirmed" });
    await store.putGig(G2, { status: "lead", parentGigId: G1 });

    await store.removeGig(G1);

    const child = await store.getGig(G2);
    expect(child?.parentGigId).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd webapp && pnpm exec vitest run src/lib/local-store.test.ts -t "gig parent link"
```

Expected: FAIL — `parentGigId` is not a known property, so this will not compile until step 3.

- [ ] **Step 3: Add the field to the types**

`webapp/src/lib/types.ts` — in `Gig`, after `clientId`:

```ts
  /** The gig this one came from — a follow-up, or one arm of a split.
   *  Grouping only: nothing is shared or inherited. Null for a gig that
   *  is part of nothing, which is most of them. */
  parentGigId: string | null;
```

and in `GigInput`, after `clientId`:

```ts
  parentGigId?: string | null;
```

- [ ] **Step 4: Bump the Dexie schema**

In `webapp/src/lib/db.ts`, after the existing `this.version(4)` block:

```ts
    // Finding a gig's children is a query BY parentGigId, which Dexie
    // cannot serve unindexed. A version's `stores()` is a delta over
    // the previous one, so naming `gigs` here re-declares only that
    // store and leaves the other six untouched.
    this.version(5).stores({
      gigs: "id, dateTime, modifiedAt, parentGigId",
    });
```

- [ ] **Step 5: Carry it through the store and the payload**

In `webapp/src/lib/local-store.ts`'s `putGig`, add `parentGigId` to both the local record and the outbox payload. `OutboxPayload` is `Required<...>`, so the compiler names the omission if you miss one — read the method and follow its existing shape.

In `webapp/src/lib/gig-input.ts`, add to `gigToInput`'s returned object:

```ts
    parentGigId: gig.parentGigId,
```

- [ ] **Step 6: Clear children on local delete**

In `webapp/src/lib/local-store.ts`, in `removeGig`, before the existing `removeEntity` call:

```ts
    // Mirrors the server's ON DELETE SET NULL (migration 0018). Dexie
    // is an independent store and deletes locally first, so without
    // this the child keeps a link to a gig that is already gone.
    const children = await this.db.gigs.where("parentGigId").equals(id).toArray();
    for (const child of children) {
      await this.putGig(child.id, { ...gigToInput(child), parentGigId: null });
    }
```

Going through `putGig` rather than writing Dexie directly is deliberate: the change has to reach the server too, and `putGig` is what queues the outbox op. Import `gigToInput` if it is not already imported.

- [ ] **Step 7: Run it and confirm it passes**

```bash
cd webapp && pnpm exec vitest run src/lib/local-store.test.ts
```

Expected: PASS, including the two new cases.

- [ ] **Step 8: Prove the payload test discriminates**

Delete `parentGigId` from the outbox payload only (leaving it on the local record), and confirm the first new test fails while the second still passes. That is precisely the shape of the original incident. Restore, re-run, confirm green.

- [ ] **Step 9: Typecheck, full suite, commit**

```bash
pnpm -r typecheck
cd webapp && pnpm exec vitest run
git add webapp/src/lib/types.ts webapp/src/lib/db.ts webapp/src/lib/local-store.ts webapp/src/lib/gig-input.ts webapp/src/lib/local-store.test.ts
git commit -m "feat(gigs): carry the parent link through Dexie and the outbox"
```

---

### Task 4: `GigDetail` shows the link

**Files:**
- Modify: `webapp/src/screens/GigDetail.tsx`
- Test: `webapp/src/screens/GigDetail.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `webapp/src/screens/GigDetail.test.tsx` (it does not exist). `GigDetail` reaches for five queries — `getGig(id)`, `listClients()`, `listServicesByGig(id)`, `listPaymentsByGig(id)`, `listAllocationsByGig(id)` — plus `listGigs()`, which Task 4 adds. All six must be mocked or the tree throws before rendering.

Gigs are named by `gigDisplayTitle(gig, clientName)` (`lib/gig-title.ts`), which prefers `title`, falls back to the first non-empty line of `notes`, then to the client's name. So a distinct `title` IS renderable here — unlike `ClientEdit`'s `JobRow`, which never draws it.

```tsx
/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GigDetail } from "./GigDetail.tsx";
import { HelpProvider } from "../help/runtime/HelpProvider.tsx";
import type { Client, Gig } from "../lib/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// TanStack Query v5 schedules the re-render through a real
// setTimeout(fn, 0). `await act` drains only microtasks, so without
// this the assertions race the timer and the file is non-deterministic.
notifyManager.setScheduler((cb) => cb());

const ACME: Client = {
  id: "c1", name: "Acme", contactInfo: null, notes: null, createdAt: 0, modifiedAt: 0,
};

function gig(over: Partial<Gig>): Gig {
  return {
    id: "g1",
    clientId: "c1",
    parentGigId: null,
    title: null,
    status: "confirmed",
    location: null,
    dateTime: 0,
    durationMinutes: null,
    payType: "fixed",
    hourlyRateCents: null,
    workStartedAt: null,
    workEndedAt: null,
    breakMinutes: null,
    calendarEventId: null,
    amountOfferedCents: null,
    amountPaidCents: 0,
    expectedCents: null,
    notes: null,
    source: null,
    createdAt: 0,
    modifiedAt: 0,
    ...over,
  };
}

const api = {
  getGig: vi.fn(async (id: string) => ALL.find((g) => g.id === id) ?? null),
  listGigs: vi.fn(async () => ALL),
  listClients: vi.fn(async () => [ACME]),
  listServicesByGig: vi.fn(async () => []),
  listPaymentsByGig: vi.fn(async () => []),
  listAllocationsByGig: vi.fn(async () => []),
};

let ALL: Gig[] = [];

vi.mock("../lib/app-context.tsx", () => ({
  useData: () => api,
  useSyncState: () => ({ online: true, pendingCount: 0 }),
  useServices: () => ({ ready: true }),
  useAuthState: () => ({ user: { email: "t@e.com" }, ready: true, signedIn: true }),
  useSyncEngine: () => null,
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(all: Gig[], openId: string) {
  ALL = all;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/gigs/${openId}`]}>
          <HelpProvider>
            <Routes>
              <Route path="/gigs/:id" element={<GigDetail />} />
            </Routes>
          </HelpProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

describe("GigDetail parent link", () => {
  it("says what this gig is part of, and links to it", async () => {
    const parent = gig({ id: "p", title: "The original booking" });
    const child = gig({ id: "k", title: "Second day", parentGigId: "p" });
    const el = await render([parent, child], "k");

    const line = el.querySelector('[data-testid="gig-parent"]');
    expect(line).not.toBeNull();
    expect(line?.textContent).toContain("The original booking");
    expect(line?.querySelector('a[href="/gigs/p"]')).not.toBeNull();
  });

  it("lists what came out of this gig", async () => {
    const parent = gig({ id: "p", title: "The original booking" });
    const a = gig({ id: "k1", title: "Second day", parentGigId: "p" });
    const b = gig({ id: "k2", title: "Third day", parentGigId: "p" });
    const el = await render([parent, a, b], "p");

    const list = el.querySelector('[data-testid="gig-children"]');
    expect(list).not.toBeNull();
    expect(list?.textContent).toContain("Second day");
    expect(list?.textContent).toContain("Third day");
    expect(list?.querySelectorAll("a")).toHaveLength(2);
  });

  it("shows neither surface for a gig that is part of nothing", async () => {
    const lone = gig({ id: "solo", title: "One and done" });
    const el = await render([lone], "solo");

    expect(el.querySelector('[data-testid="gig-parent"]')).toBeNull();
    expect(el.querySelector('[data-testid="gig-children"]')).toBeNull();
  });

  it("does not list an unrelated gig as a child", async () => {
    // The filter is `g.parentGigId === gig.id`, and a bare truthiness
    // check or a `!== null` would sweep in every linked gig in the app.
    const parent = gig({ id: "p", title: "The original booking" });
    const mine = gig({ id: "k1", title: "Second day", parentGigId: "p" });
    const theirs = gig({ id: "x", title: "Someone else's follow-up", parentGigId: "other" });
    const el = await render([parent, mine, theirs], "p");

    const list = el.querySelector('[data-testid="gig-children"]');
    expect(list?.textContent).toContain("Second day");
    expect(list?.textContent).not.toContain("Someone else's follow-up");
  });
});
```

`ALL` is declared after `api` on purpose — `vi.fn` closures read it at call time, not at definition. If the mock list needs a different shape, adjust the fixture, never the assertions.

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd webapp && pnpm exec vitest run src/screens/GigDetail.test.tsx
```

Expected: FAIL — neither surface exists yet.

- [ ] **Step 3: Render both surfaces**

In `webapp/src/screens/GigDetail.tsx`, fetch the sibling data and render the two surfaces. The children query is a filter over the gigs the screen can already reach:

```tsx
  const parent =
    gig?.parentGigId == null
      ? null
      : (gigs.data?.find((g) => g.id === gig.parentGigId) ?? null);
  const children = gigs.data?.filter((g) => g.parentGigId === gig?.id) ?? [];
```

Render `parent` as a single line reading "Part of" with a `Link` to `/gigs/${parent.id}`, and `children` as a "Follow-up jobs" section listing a `Link` per child. Use whatever the file already uses to name a gig in a link — do not invent a new title helper.

Give the parent line `data-testid="gig-parent"` and the children list `data-testid="gig-children"` so the e2e and the unit test can both find them.

If `GigDetail` does not already load the full gig list, add the query the same way its existing ones are written, with the same query key the rest of the app uses for gigs (`["gigs"]`) so it shares the cache rather than refetching.

- [ ] **Step 4: Run it and confirm it passes**

```bash
cd webapp && pnpm exec vitest run src/screens/GigDetail.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add webapp/src/screens/GigDetail.tsx webapp/src/screens/GigDetail.test.tsx
git commit -m "feat(gigs): show what a gig is part of, and what came out of it"
```

---

### Task 5: The parent picker on the gig form

**Files:**
- Modify: `webapp/src/screens/GigEdit.tsx`
- Test: `webapp/src/screens/GigEdit.test.tsx`

The picker's option list is the client-side echo of the server's rules. It must exclude exactly three things, and each exclusion mirrors one invariant.

- [ ] **Step 1: Write the failing test**

Create `webapp/src/screens/GigEdit.test.tsx`. Use the same harness as the `GigDetail` test in Task 4 — same pragma, same `notifyManager.setScheduler`, same `app-context` mock, real `HelpProvider` — and mock the queries `GigEdit` actually makes: `getGig(id)`, `listClients()`, and `listGigs()` (which Task 5 adds).

```tsx
describe("GigEdit parent picker", () => {
  function options(el: HTMLElement): string[] {
    const select = el.querySelector('[data-testid="gig-parent-select"]');
    return [...(select?.querySelectorAll("option") ?? [])]
      .map((o) => o.getAttribute("value") ?? "")
      .filter((v) => v !== "");
  }

  it("offers a same-client gig that has no parent of its own", async () => {
    const editing = gig({ id: "me", clientId: "c1" });
    const ok = gig({ id: "ok", clientId: "c1", title: "Eligible" });
    const el = await render([editing, ok], "me");
    expect(options(el)).toContain("ok");
  });

  it("does not offer the gig being edited", async () => {
    // Mirrors "a gig cannot be its own parent".
    const editing = gig({ id: "me", clientId: "c1" });
    const el = await render([editing], "me");
    expect(options(el)).not.toContain("me");
  });

  it("does not offer another client's gig", async () => {
    // Mirrors "parentGigId does not reference the same client".
    const editing = gig({ id: "me", clientId: "c1" });
    const other = gig({ id: "other", clientId: "c2", title: "Bravo's job" });
    const el = await render([editing, other], "me");
    expect(options(el)).not.toContain("other");
  });

  it("does not offer a gig that already has a parent", async () => {
    // Mirrors "parentGigId already has a parent of its own" — the rule
    // that keeps the tree one level deep and cycles unreachable.
    const editing = gig({ id: "me", clientId: "c1" });
    const nested = gig({ id: "nested", clientId: "c1", parentGigId: "somewhere" });
    const el = await render([editing, nested], "me");
    expect(options(el)).not.toContain("nested");
  });

  it("offers a client-less gig only to another client-less gig", async () => {
    // Both null IS the same client, and `""` is how the form spells null.
    const editing = gig({ id: "me", clientId: null });
    const free = gig({ id: "free", clientId: null, title: "Unattributed" });
    const owned = gig({ id: "owned", clientId: "c1", title: "Acme's" });
    const el = await render([editing, free, owned], "me");
    expect(options(el)).toContain("free");
    expect(options(el)).not.toContain("owned");
  });
});
```

The `gig()` fixture and `render()` helper are the ones from Task 4's test file; copy them rather than importing across test files, which this repo does not do.

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd webapp && pnpm exec vitest run src/screens/GigEdit.test.tsx
```

Expected: FAIL — there is no picker.

- [ ] **Step 3: Add the picker**

In `webapp/src/screens/GigEdit.tsx`, add a `Select` field labelled "Part of" whose options are:

```tsx
  // `form.clientId` is a string where "" means none — that is how the
  // form spells null, and `GigEdit` already converts it on save
  // (`form.clientId === "" ? null : form.clientId`). Comparing the raw
  // value against `g.clientId` would never match a client-less gig.
  const formClientId = form.clientId === "" ? null : form.clientId;
  const parentOptions = (gigs.data ?? []).filter(
    (g) =>
      g.id !== id &&
      (g.clientId ?? null) === formClientId &&
      g.parentGigId === null,
  );
```

with an empty option meaning "not part of anything", bound to `form.parentGigId`. Give it `data-testid="gig-parent-select"`.

`GigEdit` does not currently load the gig list — add the query the same way its existing ones are written, keyed `["gigs"]` so it shares the cache the rest of the app already fills:

```tsx
  const gigs = useQuery({ queryKey: ["gigs"], queryFn: () => api.listGigs() });
```

`FormState` gains `parentGigId: string` (again `""` = none), `BLANK` gains `parentGigId: ""`, the effect that seeds the form from a loaded gig gains `parentGigId: gig.data.parentGigId ?? ""`, and the save mapping gains `parentGigId: form.parentGigId === "" ? null : form.parentGigId`.

Note the option list depends on the **form's** current `clientId`, not the saved gig's — changing the client in the form must re-filter the list, or the picker offers gigs the server will refuse.

- [ ] **Step 4: Run it and confirm it passes**

```bash
cd webapp && pnpm exec vitest run src/screens/GigEdit.test.tsx
```

Expected: PASS.

- [ ] **Step 4b: A gig with follow-ups cannot take a parent**

Added after Task 2's review, which proved the original rule set allowed
a two-level chain. Rule 5 — *a gig that already has children may not
acquire a parent* — constrains the gig being **edited**, not the
options, so it cannot be expressed by filtering the list.

If the gig being edited has children, disable the picker and say why:

```tsx
  const hasChildren = (gigs.data ?? []).some((g) => g.parentGigId === id);
```

Render the `Select` with `disabled={hasChildren}` and, when
`hasChildren`, a line beneath it reading something like "This job has
follow-ups of its own, so it can't also be part of another job. Unlink
them first." Give that line `data-testid="gig-parent-blocked"`.

An empty dropdown would read as "nothing matches"; this is "this gig
cannot be a child", which is a different fact and one the user can act
on.

Add a test: a gig with a child renders the picker disabled and the
explanation present; a gig without children renders it enabled and the
explanation absent. Then mutate — drop the `disabled` binding — and
confirm the test fails.

- [ ] **Step 5: Prove each exclusion is load-bearing**

Remove each of the three filter clauses in turn and confirm exactly one test fails each time. Restore after each, and report the three results. A filter whose removal breaks nothing is not being tested.

- [ ] **Step 6: Typecheck, full suite, commit**

```bash
pnpm -r typecheck
cd webapp && pnpm exec vitest run
git add webapp/src/screens/GigEdit.tsx webapp/src/screens/GigEdit.test.tsx
git commit -m "feat(gigs): pick what a gig is part of, from what the server would accept"
```

---

## Verification

- [ ] `pnpm -r typecheck` passes
- [ ] `pnpm -r test` passes
- [ ] `pnpm --filter gigsy-webapp test:e2e` passes against a LOCAL stack (`E2E_BASE_URL=http://127.0.0.1:5192 E2E_REQUIRE_AUTH=1`). Never the default — `playwright.config.ts` points at production and the specs share the prod D1.
- [ ] `pnpm --filter gigsy-webapp help:test` passes against the same local stack, with **zero flaky**
- [ ] `BASE_REF=main python scripts/check_version_bump.py` reports all tiers bumped
- [ ] `0018` applies to a local D1 that already has gigs: `pnpm exec wrangler d1 migrations apply gigsy-db --local`
- [ ] The report states which delete path is live: D1's `ON DELETE SET NULL`, or the explicit clear in `GigsRepo.remove`
- [ ] Manually: link a follow-up, see it on both gigs, delete the parent, confirm the child survives unlinked
- [ ] Manually: the picker offers nothing from another client, and nothing that already has a parent
- [ ] Manually: create a link offline, confirm it reaches the server after a drain

## Out of scope

- No reports rollup and no grouped CSV export.
- No nesting in `ClientEdit`'s client history.
- No "create follow-up" shortcut.
- No chains deeper than one level, and no cross-client links.
- No shared or inherited data between linked gigs.
