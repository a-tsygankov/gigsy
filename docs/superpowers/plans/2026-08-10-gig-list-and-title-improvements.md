# Gig list & title improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** five improvements to gigs — quarter-hour time entry, an
unsynced marker, a stale-on-reopen fix, list sorting/filtering/search,
and an optional gig title that falls back to the first line of notes.

**Architecture:** Four of the five are webapp-only. The title is the
one full-stack change: a nullable `title` column threaded from
migration 0011 through zod, the repo, `/api/sync`, the CRUD route, the
webapp types and the outbox payload. All list filtering happens
client-side over the local Dexie copy, which is already the source of
truth for reads — no new endpoints. Filter state lives in the URL query
string so it survives navigating into a gig and back.

**Tech Stack:** Hono + Drizzle + D1 (backend), React + TanStack Query +
Dexie + react-router (webapp), vitest + Playwright.

**Verification note:** `pnpm test` in `backend/` is unreliable on
Windows — a full parallel run exhausts the ephemeral port range and
workerd cannot reach its own module server. Use
`npx vitest run --no-file-parallelism`. E2E runs against a local stack:
`E2E_BASE_URL=http://localhost:5210 E2E_REQUIRE_AUTH=1`.

---

## File Structure

**Created**
- `backend/migrations/0011_gig_title.sql` — the nullable column.
- `webapp/src/lib/gig-title.ts` — `gigDisplayTitle()`, the single place
  the title→notes→client fallback is decided. Pure, so both the list
  and the detail screen agree without duplicating the rule.
- `webapp/src/lib/gig-title.test.ts`
- `webapp/src/lib/gig-filters.ts` — filter/sort state, its URL
  encoding, and the pure `applyGigFilters()`. Kept out of the screen so
  the rules are testable without a browser.
- `webapp/src/lib/gig-filters.test.ts`
- `webapp/src/screens/gigs/GigFilters.tsx` — the controls. Its own file
  because `Gigs.tsx` is a list screen, not a filter panel, and the two
  change for different reasons.

**Modified**
- `backend/src/db/schema.ts`, `src/domain/schemas.ts`,
  `src/repos/gigs.ts`, `src/services/sync.ts`, `src/routes/gigs.ts` —
  thread `title`.
- `backend/test/helpers/db.ts` — register migration 0011.
- `webapp/src/lib/types.ts` — `Gig.title`, `GigInput.title`.
- `webapp/src/lib/local-store.ts` — `title` in record and payload;
  new `pendingIds()`.
- `webapp/src/lib/data-service.ts` — expose `pendingGigIds()`.
- `webapp/src/screens/GigEdit.tsx` — title field, `step`, cache fix.
- `webapp/src/screens/Gigs.tsx` — dot, display title, filter wiring.

---

## Task 1: Reopening a just-saved gig shows stale data

**Root cause (already diagnosed):** `GigEdit`'s save invalidates
`["gigs"]` but never `["gig", id]`. `staleTime` is 30s (main.tsx), so
reopening within that window serves the cached copy.

**Files:**
- Modify: `webapp/src/screens/GigEdit.tsx:109-124`
- Test: `webapp/e2e/signed-in.spec.ts`

- [ ] **Step 1: Write the failing e2e**

Append to `webapp/e2e/signed-in.spec.ts`:

```ts
// Editing a gig then reopening it used to show the pre-edit values:
// save invalidated the LIST query but not the single-gig one, and the
// 30s staleTime happily served the old copy.
test("reopening a just-edited gig shows the new values", async ({ page }) => {
  const marker = `stale-check-${Date.now()}`;

  await page.getByRole("link", { name: "Gigs" }).click();
  await page.getByRole("link", { name: "Add gig" }).click();
  await page.getByLabel("Location").fill(marker);
  await page.getByRole("button", { name: "Save gig" }).click();
  await expect(page.getByText(marker)).toBeVisible({ timeout: 15_000 });

  // Edit it: change the duration, save, reopen immediately.
  await page.getByText(marker).click();
  await page.getByTestId("gig-duration").selectOption("300");
  await page.getByRole("button", { name: "Save gig" }).click();
  await expect(page.getByText(marker)).toBeVisible({ timeout: 15_000 });

  await page.getByText(marker).click();
  await expect(page.getByTestId("gig-duration")).toHaveValue("300");
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd webapp && E2E_BASE_URL=http://localhost:5210 E2E_REQUIRE_AUTH=1 npx playwright test --project=chromium -g "reopening a just-edited"
```

Expected: FAIL — duration reads `""` (or the old value), not `300`.

- [ ] **Step 3: Invalidate the single-gig key too**

In `webapp/src/screens/GigEdit.tsx`, replace the `save` mutation:

```tsx
  const save = useMutation({
    mutationFn: (input: GigInput) =>
      api.putGig(isNew ? crypto.randomUUID() : id, input),
    // The list AND this gig's own cache entry. Invalidating only the
    // list left ["gig", id] stale for its 30s window, so reopening a
    // gig you had just edited showed the values you replaced.
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ["gigs"] });
      await queryClient.invalidateQueries({ queryKey: ["gig", saved.id] });
      navigate("/gigs");
    },
  });
```

- [ ] **Step 4: Run it and watch it pass**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add webapp/src/screens/GigEdit.tsx webapp/e2e/signed-in.spec.ts
git commit -m "Fix: reopening a just-edited gig showed the old values"
```

---

## Task 2: Quarter-hour time entry

Pickers offer only `:00/:15/:30/:45`. Values that arrived from email or
photo capture are left exactly as they are — `step` constrains what can
be *picked*, not what is already in the field, and `GigEdit` parses the
value itself rather than relying on native form validation, so an
out-of-step value still saves.

**Files:**
- Modify: `webapp/src/screens/GigEdit.tsx:232-238`
- Test: `webapp/e2e/signed-in.spec.ts`

- [ ] **Step 1: Write the failing e2e**

```ts
test("the time field offers quarter hours but preserves captured minutes", async ({
  page,
}) => {
  await page.getByRole("link", { name: "Gigs" }).click();
  await page.getByRole("link", { name: "Add gig" }).click();

  // The picker steps in 15-minute increments.
  await expect(page.getByLabel("Date & time")).toHaveAttribute("step", "900");

  // …but a value that did not come from the picker survives a save.
  // This is what an email/photo capture produces.
  const marker = `odd-minutes-${Date.now()}`;
  await page.getByLabel("Location").fill(marker);
  await page.getByLabel("Date & time").fill("2027-03-04T10:07");
  await page.getByRole("button", { name: "Save gig" }).click();
  await expect(page.getByText(marker)).toBeVisible({ timeout: 15_000 });

  await page.getByText(marker).click();
  await expect(page.getByLabel("Date & time")).toHaveValue("2027-03-04T10:07");
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd webapp && E2E_BASE_URL=http://localhost:5210 E2E_REQUIRE_AUTH=1 npx playwright test --project=chromium -g "quarter hours"
```

Expected: FAIL — no `step` attribute.

- [ ] **Step 3: Add the step**

```tsx
            <Field label="Date & time">
              <Input
                type="datetime-local"
                // Quarter hours only. A gig starts at :00/:15/:30/:45,
                // not 10:07 — but a time extracted from an email might,
                // and `step` does not rewrite a value already in the
                // field, so captured times survive untouched.
                step={900}
                value={form.dateTime}
                onChange={(e) => set("dateTime", e.target.value)}
              />
            </Field>
```

- [ ] **Step 4: Run it and watch it pass**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add webapp/src/screens/GigEdit.tsx webapp/e2e/signed-in.spec.ts
git commit -m "Gig time entry steps in quarter hours"
```

---

## Task 3: Optional gig title

Falls back to the first non-empty line of notes, then the client name.
Full-stack, and the `Required<OutboxPayload>` guard added in the
duration fix will refuse to compile until the outbox payload carries it
— which is the guard doing its job.

**Files:**
- Create: `backend/migrations/0011_gig_title.sql`
- Modify: `backend/src/db/schema.ts`, `backend/src/domain/schemas.ts`,
  `backend/src/repos/gigs.ts`, `backend/src/services/sync.ts`,
  `backend/src/routes/gigs.ts`, `backend/test/helpers/db.ts`
- Create: `webapp/src/lib/gig-title.ts`, `webapp/src/lib/gig-title.test.ts`
- Modify: `webapp/src/lib/types.ts`, `webapp/src/lib/local-store.ts`,
  `webapp/src/screens/GigEdit.tsx`

- [ ] **Step 1: Write the failing display-rule test**

Create `webapp/src/lib/gig-title.test.ts`:

```ts
/**
 * What a gig is called on screen.
 *
 * One rule, one place: the list and the detail screen must agree, and
 * duplicating "title, else notes, else client" in two components is how
 * they stop agreeing.
 */
import { describe, it, expect } from "vitest";
import { gigDisplayTitle } from "./gig-title.ts";

const base = { title: null, notes: null };

describe("gigDisplayTitle", () => {
  it("uses the title when there is one", () => {
    expect(gigDisplayTitle({ ...base, title: "Costco tasting" }, "Acme")).toBe(
      "Costco tasting",
    );
  });

  it("falls back to the first non-empty line of notes", () => {
    expect(
      gigDisplayTitle({ ...base, notes: "Booth 12 setup\nBring the banner" }, "Acme"),
    ).toBe("Booth 12 setup");
  });

  it("skips blank leading lines rather than showing nothing", () => {
    expect(gigDisplayTitle({ ...base, notes: "\n\n  Real line" }, "Acme")).toBe(
      "Real line",
    );
  });

  it("falls back to the client when there is neither", () => {
    expect(gigDisplayTitle(base, "Acme")).toBe("Acme");
  });

  it("says No client when there is nothing at all", () => {
    expect(gigDisplayTitle(base, null)).toBe("No client");
  });

  it("treats a whitespace-only title as absent", () => {
    expect(gigDisplayTitle({ ...base, title: "   " }, "Acme")).toBe("Acme");
  });

  it("shortens a notes line long enough to swamp the row", () => {
    const long = "x".repeat(200);
    const shown = gigDisplayTitle({ ...base, notes: long }, "Acme");
    expect(shown.length).toBeLessThanOrEqual(80);
    expect(shown.endsWith("…")).toBe(true);
  });

  it("does not shorten a long explicit title", () => {
    // The user typed it deliberately; notes are prose that happens to
    // be first, which is a different thing.
    const long = "y".repeat(120);
    expect(gigDisplayTitle({ ...base, title: long }, "Acme")).toBe(long);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd webapp && npx vitest run src/lib/gig-title.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the helper**

Create `webapp/src/lib/gig-title.ts`:

```ts
/**
 * What a gig is called on screen (title → first line of notes → client).
 *
 * A gig often has no name of its own; what identifies it is who it is
 * for. The optional title is for when that is not enough — two shifts
 * for the same agency in one week — and the notes fallback exists
 * because people already write the useful line there first.
 */
const MAX_DERIVED = 80;

export interface TitledGig {
  title: string | null;
  notes: string | null;
}

export function gigDisplayTitle(gig: TitledGig, clientName: string | null): string {
  const title = gig.title?.trim();
  if (title !== undefined && title !== "") return title;

  const firstLine = gig.notes
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  if (firstLine !== undefined) {
    // Only the derived label is shortened. A title the user typed is
    // shown as typed; notes are prose that happens to start here.
    return firstLine.length > MAX_DERIVED
      ? `${firstLine.slice(0, MAX_DERIVED - 1)}…`
      : firstLine;
  }

  return clientName ?? "No client";
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd webapp && npx vitest run src/lib/gig-title.test.ts
```

Expected: PASS (8 tests).

- [ ] **Step 5: Add the migration**

Create `backend/migrations/0011_gig_title.sql`:

```sql
-- 0011_gig_title: an optional name for a gig.
--
-- Nullable, because most gigs are identified by who they are for and
-- need nothing else. It earns its place when that is ambiguous — two
-- shifts for the same agency in one week. Where it is absent the UI
-- falls back to the first line of notes, which is where people were
-- already writing this.
ALTER TABLE gigs ADD COLUMN title TEXT;
```

- [ ] **Step 6: Thread it through the backend**

`backend/src/db/schema.ts` — in the `gigs` table, after `clientId`:

```ts
    /** Optional name. Most gigs are identified by their client; this
     *  is for when that is not enough. */
    title: text("title"),
```

`backend/src/domain/schemas.ts` — in `GigInput`, after `clientId`:

```ts
  title: z.string().max(200).nullish(),
```

`backend/src/repos/gigs.ts` — in `GigData`, after `clientId`:

```ts
  title: string | null;
```

`backend/src/services/sync.ts` — in the `gig` case's upsert object,
after `clientId`:

```ts
                title: parsed.data.title ?? null,
```

`backend/src/routes/gigs.ts` — in the PUT upsert object, after
`clientId`:

```ts
        title: input.title ?? null,
```

`backend/test/helpers/db.ts` — add the import beside the others and
append to `MIGRATIONS`:

```ts
import gigTitleSql from "../../migrations/0011_gig_title.sql?raw";
```

```ts
  availabilityTokensSql,
  gigTitleSql,
];
```

- [ ] **Step 7: Write the backend round-trip test**

Append to `backend/test/gigs-routes.test.ts`:

```ts
describe("gig title", () => {
  it("stores and returns an optional title", async () => {
    const id = "77777777-aaaa-4aaa-8aaa-777777777777";
    const put = await api(U1, "PUT", `/api/gigs/${id}`, {
      status: "lead",
      title: "Costco tasting",
    });
    expect(put.status).toBe(201);

    const got = await (await api(U1, "GET", `/api/gigs/${id}`)).json();
    expect((got as { title: string }).title).toBe("Costco tasting");
  });

  it("treats an absent title as null rather than rejecting it", async () => {
    const id = "77777777-bbbb-4bbb-8bbb-777777777777";
    const put = await api(U1, "PUT", `/api/gigs/${id}`, { status: "lead" });

    expect(put.status).toBe(201);
    expect(((await put.json()) as { title: string | null }).title).toBeNull();
  });

  it("refuses a title long enough to be a note", async () => {
    const id = "77777777-cccc-4ccc-8ccc-777777777777";
    const res = await api(U1, "PUT", `/api/gigs/${id}`, {
      status: "lead",
      title: "x".repeat(201),
    });

    expect(res.status).toBe(400);
  });
});
```

Note: `U1` and `api` already exist at the top of that file — do not
redeclare them.

- [ ] **Step 8: Run the backend tests**

```bash
cd backend && npx vitest run --no-file-parallelism test/gigs-routes.test.ts
```

Expected: PASS.

- [ ] **Step 9: Thread it through the webapp**

`webapp/src/lib/types.ts` — in `Gig`, after `clientId`:

```ts
  /** Optional name; the UI falls back to the first line of notes. */
  title: string | null;
```

…and in `GigInput`, after `clientId`:

```ts
  title?: string | null;
```

`webapp/src/lib/local-store.ts` — in `putGig`'s `record`, after
`clientId`:

```ts
      title: input.title ?? null,
```

…and in its `payload`, after `clientId`:

```ts
      title: record.title,
```

The payload line is not optional: `OutboxPayload<GigInput>` is
`Required<GigInput>`, so leaving it out is a compile error. That guard
exists because exactly this omission silently dropped gig durations for
months.

- [ ] **Step 10: Add the field to the edit screen**

In `webapp/src/screens/GigEdit.tsx`: add `title: string;` to
`FormState`, `title: "",` to `BLANK`, `title: gig.data.title ?? "",` to
the `setForm` effect, and to the `save.mutate` object:

```tsx
      title: form.title.trim() === "" ? null : form.title.trim(),
```

Then the field itself, immediately above `<Field label="Client">`:

```tsx
            <Field label="Title (optional)">
              <Input
                data-testid="gig-title"
                maxLength={200}
                placeholder="Leave empty to use the first line of notes"
                value={form.title}
                onChange={(e) => set("title", e.target.value)}
              />
            </Field>
```

- [ ] **Step 11: Run the webapp checks**

```bash
cd webapp && pnpm typecheck && npx vitest run
```

Expected: typecheck clean, all unit tests pass.

- [ ] **Step 12: Apply the migration locally**

```bash
cd backend && pnpm db:migrate:local
```

Expected: `0011_gig_title.sql` applied. (Remote is applied by the
deploy workflow on merge to main — do not run `db:migrate:remote`.)

- [ ] **Step 13: Commit**

```bash
git add backend webapp/src/lib/gig-title.ts webapp/src/lib/gig-title.test.ts webapp/src/lib/types.ts webapp/src/lib/local-store.ts webapp/src/screens/GigEdit.tsx
git commit -m "Gigs can have a title, falling back to the first line of notes"
```

---

## Task 4: An unsynced marker on the gig list

Amber dot = this gig has changes that have not reached the server.
Synced gigs show nothing: synced is the normal state, and a permanent
dot on every row is noise rather than information.

**Files:**
- Modify: `webapp/src/lib/local-store.ts`,
  `webapp/src/lib/local-store.test.ts`,
  `webapp/src/lib/data-service.ts`, `webapp/src/screens/Gigs.tsx`

- [ ] **Step 1: Write the failing store test**

Append to `webapp/src/lib/local-store.test.ts`:

```ts
describe("pendingIds", () => {
  it("names the records with unsent changes", async () => {
    const { store } = makeStore();
    await store.putGig(G1, { status: "lead" });
    await store.putGig(G2, { status: "lead" });

    expect(await store.pendingIds("gig")).toEqual(new Set([G1, G2]));
  });

  it("is empty once the ops are drained", async () => {
    const { store } = makeStore();
    await store.putGig(G1, { status: "lead" });
    for (const op of await store.pendingOps()) await store.deleteOp(op.opKey);

    expect(await store.pendingIds("gig")).toEqual(new Set());
  });

  it("does not mix entities", async () => {
    const { store } = makeStore();
    await store.putGig(G1, { status: "lead" });
    await store.putClient(C1, { name: "Acme" });

    expect(await store.pendingIds("gig")).toEqual(new Set([G1]));
    expect(await store.pendingIds("client")).toEqual(new Set([C1]));
  });

  it("includes a record queued for deletion", async () => {
    // It still differs from the server until the delete is sent.
    const { store } = makeStore();
    await store.putGig(G1, { status: "lead" });
    for (const op of await store.pendingOps()) await store.deleteOp(op.opKey);
    await store.removeGig(G1);

    expect(await store.pendingIds("gig")).toEqual(new Set([G1]));
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd webapp && npx vitest run src/lib/local-store.test.ts
```

Expected: FAIL — `store.pendingIds is not a function`.

- [ ] **Step 3: Add the method**

In `webapp/src/lib/local-store.ts`, beside `hasPendingOp`:

```ts
  /** Every record of this entity with unsent changes. The outbox holds
   *  at most one op per record and is drained continuously, so it is
   *  small enough to scan rather than index. */
  async pendingIds(entity: SyncEntityName): Promise<Set<string>> {
    const ops = await this.db.pendingOps.toArray();
    return new Set(
      ops.filter((op) => op.entity === entity).map((op) => op.entityId),
    );
  }
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd webapp && npx vitest run src/lib/local-store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Expose it on the data service**

In `webapp/src/lib/data-service.ts`, beside the other gig methods:

```ts
  /** Gig ids whose changes have not reached the server yet. */
  pendingGigIds() {
    return this.store.pendingIds("gig");
  }
```

If the surrounding methods delegate to a differently-named private
field, match that name — read the neighbouring methods first.

- [ ] **Step 6: Render the dot**

In `webapp/src/screens/Gigs.tsx`, add the query and re-run it whenever
the outbox size changes:

```tsx
  const sync = useSyncState();
  const pending = useQuery({
    queryKey: ["pending-gig-ids", sync?.pendingCount ?? 0],
    queryFn: () => api.pendingGigIds(),
  });
```

Import `useSyncState` from `../lib/app-context.tsx` alongside `useData`.

Then inside the row, as the first child of the outer flex div:

```tsx
                {pending.data?.has(gig.id) === true && (
                  <span
                    data-testid="gig-unsynced"
                    // Not colour alone: the label is what a screen
                    // reader and a colour-blind user actually get.
                    title="Not synced yet"
                    aria-label="Not synced yet"
                    className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-amber-500"
                  />
                )}
```

`bg-amber-500` needs `amber` step 500 in `webapp/tailwind.config.ts`.
The scale currently lists `[50, 100, 700, 800]` — add `500`:

```ts
        amber: scale("amber", [50, 100, 500, 700, 800]),
```

- [ ] **Step 7: Write the e2e**

Append to `webapp/e2e/signed-in.spec.ts`:

```ts
test("a gig with unsent changes is marked, and the mark clears on sync", async ({
  page,
  context,
}) => {
  const marker = `dot-check-${Date.now()}`;

  await page.getByRole("link", { name: "Gigs" }).click();
  await context.setOffline(true);
  await page.getByRole("link", { name: "Add gig" }).click();
  await page.getByLabel("Location").fill(marker);
  await page.getByRole("button", { name: "Save gig" }).click();

  await expect(page.getByText(marker)).toBeVisible();
  await expect(page.getByTestId("gig-unsynced").first()).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByTestId("sync-pending")).toBeHidden({ timeout: 20_000 });
  await expect(page.getByTestId("gig-unsynced")).toHaveCount(0, {
    timeout: 20_000,
  });
});
```

- [ ] **Step 8: Run the e2e**

```bash
cd webapp && E2E_BASE_URL=http://localhost:5210 E2E_REQUIRE_AUTH=1 npx playwright test --project=chromium -g "unsent changes"
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add webapp
git commit -m "Mark gigs whose changes have not reached the server"
```

---

## Task 5: Sorting, filtering, search and hide-past

All state in the URL query string, so filtering then opening a gig and
coming back keeps the filter. Filtering is client-side over the local
list, which is already local-first.

**Files:**
- Create: `webapp/src/lib/gig-filters.ts`,
  `webapp/src/lib/gig-filters.test.ts`,
  `webapp/src/screens/gigs/GigFilters.tsx`
- Modify: `webapp/src/screens/Gigs.tsx`

- [ ] **Step 1: Write the failing filter test**

Create `webapp/src/lib/gig-filters.test.ts`:

```ts
/**
 * Gig list filtering.
 *
 * Pure and URL-encoded, so the rules are testable without a browser
 * and a filtered list survives navigating into a gig and back — a
 * filter that resets every time you look at something is a filter
 * nobody uses.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_FILTERS,
  applyGigFilters,
  parseGigFilters,
  toSearchParams,
} from "./gig-filters.ts";
import type { Gig } from "./types.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-08-10T12:00:00.000Z");

function gig(over: Partial<Gig> = {}): Gig {
  return {
    id: crypto.randomUUID(),
    clientId: null,
    title: null,
    status: "lead",
    location: null,
    dateTime: null,
    durationMinutes: null,
    calendarEventId: null,
    amountOfferedCents: null,
    amountPaidCents: null,
    notes: null,
    source: "manual",
    createdAt: NOW,
    modifiedAt: NOW,
    ...over,
  };
}

const names = new Map<string, string>([["c1", "Acme"], ["c2", "Wharfside"]]);

describe("applyGigFilters — status", () => {
  it("keeps everything when no status is selected", () => {
    const gigs = [gig({ status: "lead" }), gig({ status: "paid" })];
    expect(applyGigFilters(gigs, DEFAULT_FILTERS, names, NOW)).toHaveLength(2);
  });

  it("keeps only the selected statuses", () => {
    const gigs = [gig({ status: "lead" }), gig({ status: "paid" })];
    const out = applyGigFilters(
      gigs,
      { ...DEFAULT_FILTERS, statuses: ["paid"] },
      names,
      NOW,
    );
    expect(out.map((g) => g.status)).toEqual(["paid"]);
  });
});

describe("applyGigFilters — hide past", () => {
  it("drops gigs dated before today", () => {
    const gigs = [gig({ dateTime: NOW - 3 * DAY }), gig({ dateTime: NOW + DAY })];
    const out = applyGigFilters(
      gigs,
      { ...DEFAULT_FILTERS, hidePast: true },
      names,
      NOW,
    );
    expect(out).toHaveLength(1);
  });

  it("always keeps undated gigs", () => {
    // A lead with no date is the most live thing on the list; hiding it
    // as "past" would be exactly wrong.
    const out = applyGigFilters(
      [gig({ dateTime: null })],
      { ...DEFAULT_FILTERS, hidePast: true },
      names,
      NOW,
    );
    expect(out).toHaveLength(1);
  });

  it("keeps something earlier today", () => {
    const out = applyGigFilters(
      [gig({ dateTime: NOW - 60 * 60 * 1000 })],
      { ...DEFAULT_FILTERS, hidePast: true },
      names,
      NOW,
    );
    expect(out).toHaveLength(1);
  });
});

describe("applyGigFilters — search", () => {
  it("matches the title, location, notes and client name", () => {
    const gigs = [
      gig({ title: "Costco tasting" }),
      gig({ location: "Pier 39" }),
      gig({ notes: "bring the banner" }),
      gig({ clientId: "c2" }),
      gig({ title: "nothing relevant" }),
    ];
    for (const term of ["costco", "pier", "banner", "wharfside"]) {
      expect(
        applyGigFilters(gigs, { ...DEFAULT_FILTERS, search: term }, names, NOW),
      ).toHaveLength(1);
    }
  });

  it("ignores case and surrounding space", () => {
    const out = applyGigFilters(
      [gig({ title: "Costco tasting" })],
      { ...DEFAULT_FILTERS, search: "  COSTCO " },
      names,
      NOW,
    );
    expect(out).toHaveLength(1);
  });
});

describe("applyGigFilters — client and dates", () => {
  it("narrows to one client", () => {
    const gigs = [gig({ clientId: "c1" }), gig({ clientId: "c2" })];
    const out = applyGigFilters(
      gigs,
      { ...DEFAULT_FILTERS, clientId: "c1" },
      names,
      NOW,
    );
    expect(out).toHaveLength(1);
  });

  it("applies from and to bounds inclusively", () => {
    const gigs = [
      gig({ dateTime: NOW - 5 * DAY }),
      gig({ dateTime: NOW }),
      gig({ dateTime: NOW + 5 * DAY }),
    ];
    const out = applyGigFilters(
      gigs,
      { ...DEFAULT_FILTERS, from: NOW - DAY, to: NOW + DAY },
      names,
      NOW,
    );
    expect(out).toHaveLength(1);
  });

  it("excludes undated gigs when a date bound is set", () => {
    // Asking "what is happening that week" cannot sensibly answer with
    // something that has no date.
    const out = applyGigFilters(
      [gig({ dateTime: null })],
      { ...DEFAULT_FILTERS, from: NOW },
      names,
      NOW,
    );
    expect(out).toHaveLength(0);
  });
});

describe("applyGigFilters — sorting", () => {
  it("defaults to newest first", () => {
    const gigs = [gig({ dateTime: NOW }), gig({ dateTime: NOW + DAY })];
    const out = applyGigFilters(gigs, DEFAULT_FILTERS, names, NOW);
    expect(out[0]!.dateTime).toBe(NOW + DAY);
  });

  it("sorts oldest first on request", () => {
    const gigs = [gig({ dateTime: NOW + DAY }), gig({ dateTime: NOW })];
    const out = applyGigFilters(
      gigs,
      { ...DEFAULT_FILTERS, sort: "date-asc" },
      names,
      NOW,
    );
    expect(out[0]!.dateTime).toBe(NOW);
  });

  it("sorts by amount, biggest first", () => {
    const gigs = [gig({ amountOfferedCents: 1000 }), gig({ amountPaidCents: 9000 })];
    const out = applyGigFilters(
      gigs,
      { ...DEFAULT_FILTERS, sort: "amount-desc" },
      names,
      NOW,
    );
    expect(out[0]!.amountPaidCents).toBe(9000);
  });

  it("sorts by client name", () => {
    const gigs = [gig({ clientId: "c2" }), gig({ clientId: "c1" })];
    const out = applyGigFilters(
      gigs,
      { ...DEFAULT_FILTERS, sort: "client-asc" },
      names,
      NOW,
    );
    expect(out[0]!.clientId).toBe("c1");
  });

  it("puts undated gigs last when sorting by date", () => {
    const gigs = [gig({ dateTime: null }), gig({ dateTime: NOW })];
    const out = applyGigFilters(gigs, DEFAULT_FILTERS, names, NOW);
    expect(out[0]!.dateTime).toBe(NOW);
  });

  it("does not mutate the array it was given", () => {
    const gigs = [gig({ dateTime: NOW }), gig({ dateTime: NOW + DAY })];
    const first = gigs[0];
    applyGigFilters(gigs, DEFAULT_FILTERS, names, NOW);
    expect(gigs[0]).toBe(first);
  });
});

describe("URL round trip", () => {
  it("survives being written to the URL and read back", () => {
    const filters = {
      search: "costco",
      statuses: ["lead", "paid"] as const,
      clientId: "c1",
      from: NOW,
      to: NOW + DAY,
      hidePast: true,
      sort: "amount-desc" as const,
    };

    expect(parseGigFilters(toSearchParams({ ...filters }))).toEqual(filters);
  });

  it("writes nothing for defaults, so a clean list has a clean URL", () => {
    expect(toSearchParams(DEFAULT_FILTERS).toString()).toBe("");
  });

  it("falls back to defaults for values it cannot read", () => {
    const params = new URLSearchParams("sort=sideways&from=abc&status=nonsense");
    expect(parseGigFilters(params)).toEqual(DEFAULT_FILTERS);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd webapp && npx vitest run src/lib/gig-filters.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

Create `webapp/src/lib/gig-filters.ts`:

```ts
/**
 * Gig list filtering, sorting and its URL encoding.
 *
 * Pure and separate from the screen for two reasons: the rules are
 * worth testing without a browser, and the state belongs in the URL.
 * A filter held in component state is lost the moment you tap a gig
 * and come back, which makes filtering not worth using.
 */
import { GIG_STATUSES, type Gig, type GigStatus } from "./types.ts";

export const GIG_SORTS = [
  "date-desc",
  "date-asc",
  "amount-desc",
  "client-asc",
] as const;
export type GigSort = (typeof GIG_SORTS)[number];

export interface GigFilters {
  search: string;
  statuses: readonly GigStatus[];
  clientId: string | null;
  from: number | null;
  to: number | null;
  hidePast: boolean;
  sort: GigSort;
}

export const DEFAULT_FILTERS: GigFilters = {
  search: "",
  statuses: [],
  clientId: null,
  from: null,
  to: null,
  hidePast: false,
  sort: "date-desc",
};

/** Whether anything is actually narrowing the list — drives the
 *  "showing N of M" line and the Clear button. */
export function isFiltered(filters: GigFilters): boolean {
  return (
    filters.search !== "" ||
    filters.statuses.length > 0 ||
    filters.clientId !== null ||
    filters.from !== null ||
    filters.to !== null ||
    filters.hidePast
  );
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Paid beats offered — what actually arrived is the truer number. */
function amountOf(gig: Gig): number {
  return gig.amountPaidCents ?? gig.amountOfferedCents ?? 0;
}

function haystack(gig: Gig, clientNames: Map<string, string>): string {
  return [
    gig.title,
    gig.location,
    gig.notes,
    gig.clientId !== null ? clientNames.get(gig.clientId) : null,
  ]
    .filter((part): part is string => part != null && part !== "")
    .join(" ")
    .toLowerCase();
}

export function applyGigFilters(
  gigs: readonly Gig[],
  filters: GigFilters,
  clientNames: Map<string, string>,
  now: number,
): Gig[] {
  const search = filters.search.trim().toLowerCase();
  const today = startOfDay(now);

  const kept = gigs.filter((gig) => {
    if (filters.statuses.length > 0 && !filters.statuses.includes(gig.status)) {
      return false;
    }
    if (filters.clientId !== null && gig.clientId !== filters.clientId) return false;
    // An undated gig is the liveliest thing on the list, so it survives
    // "hide past" — but it cannot answer a question about a date range.
    if (filters.hidePast && gig.dateTime !== null && gig.dateTime < today) {
      return false;
    }
    if (filters.from !== null || filters.to !== null) {
      if (gig.dateTime === null) return false;
      if (filters.from !== null && gig.dateTime < filters.from) return false;
      if (filters.to !== null && gig.dateTime > filters.to) return false;
    }
    if (search !== "" && !haystack(gig, clientNames).includes(search)) return false;
    return true;
  });

  // Copy before sorting: the caller's array is React query data.
  return kept.slice().sort((a, b) => {
    switch (filters.sort) {
      case "date-asc":
        return (a.dateTime ?? Infinity) - (b.dateTime ?? Infinity);
      case "amount-desc":
        return amountOf(b) - amountOf(a);
      case "client-asc":
        return (
          (a.clientId !== null ? (clientNames.get(a.clientId) ?? "") : "") ||
          "￿"
        ).localeCompare(
          (b.clientId !== null ? (clientNames.get(b.clientId) ?? "") : "") ||
            "￿",
        );
      default:
        // Undated last rather than first: they sort as -Infinity
        // otherwise and bury the schedule under them.
        return (b.dateTime ?? -Infinity) - (a.dateTime ?? -Infinity);
    }
  });
}

function isStatus(value: string): value is GigStatus {
  return (GIG_STATUSES as readonly string[]).includes(value);
}

function numberOrNull(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function parseGigFilters(params: URLSearchParams): GigFilters {
  const sort = params.get("sort");
  return {
    search: params.get("q") ?? "",
    statuses: params.getAll("status").filter(isStatus),
    clientId: params.get("client"),
    from: numberOrNull(params.get("from")),
    to: numberOrNull(params.get("to")),
    hidePast: params.get("hidePast") === "1",
    sort:
      sort !== null && (GIG_SORTS as readonly string[]).includes(sort)
        ? (sort as GigSort)
        : "date-desc",
  };
}

export function toSearchParams(filters: GigFilters): URLSearchParams {
  const params = new URLSearchParams();
  // Defaults are written as absence, so an unfiltered list has a clean
  // URL and "is anything set?" is answerable by looking at it.
  if (filters.search !== "") params.set("q", filters.search);
  for (const status of filters.statuses) params.append("status", status);
  if (filters.clientId !== null) params.set("client", filters.clientId);
  if (filters.from !== null) params.set("from", String(filters.from));
  if (filters.to !== null) params.set("to", String(filters.to));
  if (filters.hidePast) params.set("hidePast", "1");
  if (filters.sort !== "date-desc") params.set("sort", filters.sort);
  return params;
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd webapp && npx vitest run src/lib/gig-filters.test.ts
```

Expected: PASS (all cases).

- [ ] **Step 5: Build the controls component**

Create `webapp/src/screens/gigs/GigFilters.tsx`:

```tsx
/**
 * The gig list's controls.
 *
 * Search and sort are always visible because they are what gets used
 * daily. Everything else sits behind a toggle — on a 375px screen, six
 * permanent controls leave no room for the list they filter.
 */
import { GIG_STATUSES, type Client, type GigStatus } from "../../lib/types.ts";
import { Button, Input, Select } from "../../components/index.ts";
import {
  isFiltered,
  type GigFilters as Filters,
  type GigSort,
} from "../../lib/gig-filters.ts";

const SORT_LABELS: Record<GigSort, string> = {
  "date-desc": "Newest first",
  "date-asc": "Oldest first",
  "amount-desc": "Biggest amount",
  "client-asc": "Client A–Z",
};

/** Epoch ms ⇄ the yyyy-mm-dd an <input type="date"> speaks. */
const toDateInput = (ms: number | null): string =>
  ms === null ? "" : new Date(ms).toISOString().slice(0, 10);
const fromDateInput = (value: string): number | null =>
  value === "" ? null : new Date(`${value}T00:00:00`).getTime();

export function GigFilters({
  filters,
  clients,
  shown,
  total,
  expanded,
  onToggleExpanded,
  onChange,
  onClear,
}: {
  filters: Filters;
  clients: Client[];
  shown: number;
  total: number;
  expanded: boolean;
  onToggleExpanded: () => void;
  onChange: (next: Filters) => void;
  onClear: () => void;
}) {
  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    onChange({ ...filters, [key]: value });

  const toggleStatus = (status: GigStatus) =>
    set(
      "statuses",
      filters.statuses.includes(status)
        ? filters.statuses.filter((s) => s !== status)
        : [...filters.statuses, status],
    );

  return (
    <section className="space-y-2" data-testid="gig-filters">
      <div className="flex gap-2">
        <Input
          type="search"
          data-testid="gig-search"
          aria-label="Search gigs"
          placeholder="Search gigs"
          value={filters.search}
          onChange={(e) => set("search", e.target.value)}
        />
        <Select
          data-testid="gig-sort"
          aria-label="Sort gigs"
          className="w-40 shrink-0"
          value={filters.sort}
          onChange={(e) => set("sort", e.target.value as GigSort)}
        >
          {Object.entries(SORT_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </div>

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          data-testid="gig-filters-toggle"
          aria-expanded={expanded}
          onClick={onToggleExpanded}
          className="text-xs font-medium text-slate-600 underline-offset-2 hover:underline"
        >
          {expanded ? "Hide filters" : "Filters"}
        </button>
        {isFiltered(filters) && (
          <span className="text-xs text-slate-500" data-testid="gig-filter-count">
            Showing {shown} of {total}
          </span>
        )}
      </div>

      {expanded && (
        <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-3">
          <div className="flex flex-wrap gap-1.5" data-testid="gig-status-filter">
            {GIG_STATUSES.map((status) => {
              const on = filters.statuses.includes(status);
              return (
                <button
                  key={status}
                  type="button"
                  aria-pressed={on}
                  data-testid={`gig-status-${status}`}
                  onClick={() => toggleStatus(status)}
                  className={`rounded-full px-3 py-1 text-xs font-medium capitalize ${
                    on
                      ? "bg-emerald-600 text-on-accent"
                      : "bg-slate-100 text-slate-600"
                  }`}
                >
                  {status}
                </button>
              );
            })}
          </div>

          <Select
            data-testid="gig-client-filter"
            aria-label="Filter by client"
            value={filters.clientId ?? ""}
            onChange={(e) => set("clientId", e.target.value === "" ? null : e.target.value)}
          >
            <option value="">Any client</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>

          <div className="flex gap-2">
            <Input
              type="date"
              aria-label="From date"
              data-testid="gig-from"
              value={toDateInput(filters.from)}
              onChange={(e) => set("from", fromDateInput(e.target.value))}
            />
            <Input
              type="date"
              aria-label="To date"
              data-testid="gig-to"
              value={toDateInput(filters.to)}
              onChange={(e) => set("to", fromDateInput(e.target.value))}
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              data-testid="gig-hide-past"
              checked={filters.hidePast}
              onChange={(e) => set("hidePast", e.target.checked)}
              className="h-4 w-4 rounded border-slate-300"
            />
            Hide past gigs
          </label>

          {isFiltered(filters) && (
            <Button variant="ghost" data-testid="gig-filters-clear" onClick={onClear}>
              Clear filters
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 6: Wire it into the list**

Rewrite `webapp/src/screens/Gigs.tsx`'s body to read filters from the
URL, apply them, and use the display title. The heading becomes the
display title, and the client name moves to the sub-line so nothing is
lost:

```tsx
export function Gigs() {
  const api = useData();
  const sync = useSyncState();
  const [params, setParams] = useSearchParams();
  const [expanded, setExpanded] = useState(false);

  const gigs = useQuery({ queryKey: ["gigs"], queryFn: () => api.listGigs() });
  const clients = useQuery({
    queryKey: ["clients"],
    queryFn: () => api.listClients(),
  });
  const pending = useQuery({
    queryKey: ["pending-gig-ids", sync?.pendingCount ?? 0],
    queryFn: () => api.pendingGigIds(),
  });

  const clientName = new Map(clients.data?.map((c) => [c.id, c.name]) ?? []);
  const filters = parseGigFilters(params);
  const all = gigs.data ?? [];
  const visible = applyGigFilters(all, filters, clientName, Date.now());

  return (
    <>
      <AppHeader title="Gigs" />
      <main className="mx-auto max-w-lg space-y-3 p-4">
        {all.length > 0 && (
          <GigFilters
            filters={filters}
            clients={clients.data ?? []}
            shown={visible.length}
            total={all.length}
            expanded={expanded}
            onToggleExpanded={() => setExpanded((e) => !e)}
            onChange={(next) => setParams(toSearchParams(next), { replace: true })}
            onClear={() => setParams(new URLSearchParams(), { replace: true })}
          />
        )}

        {gigs.isPending && <ListSkeleton />}
        {gigs.isError && (
          <p className="text-sm text-red-600">Couldn't load gigs — pull to retry.</p>
        )}
        {all.length === 0 && !gigs.isPending && (
          <EmptyState
            title="No gigs yet"
            hint="Capture your first lead — tastings, promo shifts, ambassador work."
            cta="Add a gig"
            to="/gigs/new"
          />
        )}
        {/* Filtered to nothing is a different situation from having
            nothing, and offering "Add a gig" here would be answering a
            question nobody asked. */}
        {all.length > 0 && visible.length === 0 && (
          <EmptyState
            title="No gigs match these filters"
            hint="Try clearing a filter or widening the dates."
          />
        )}

        {visible.map((gig) => {
          const money = gig.amountPaidCents ?? gig.amountOfferedCents;
          const name = gig.clientId !== null ? (clientName.get(gig.clientId) ?? null) : null;
          const heading = gigDisplayTitle(gig, name);
          // Only when the heading is not already the client's name.
          const showClient = name !== null && heading !== name;
          return (
            <CardLink key={gig.id} to={`/gigs/${gig.id}`}>
              <div className="flex items-start justify-between gap-3">
                {pending.data?.has(gig.id) === true && (
                  <span
                    data-testid="gig-unsynced"
                    title="Not synced yet"
                    aria-label="Not synced yet"
                    className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-amber-500"
                  />
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-900">
                    {heading}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-slate-500">
                    {[
                      showClient ? name : null,
                      dateLine(gig.dateTime),
                      gig.location,
                    ]
                      .filter((part) => part != null && part !== "")
                      .join(" · ")}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <StatusPill status={gig.status} />
                  {money !== null && (
                    <span className="text-sm font-semibold text-slate-800">
                      {formatMoney(money)}
                    </span>
                  )}
                </div>
              </div>
            </CardLink>
          );
        })}
      </main>
      <Fab to="/gigs/new" label="Add gig" />
    </>
  );
}
```

Imports to add at the top of `Gigs.tsx`:

```tsx
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useData, useSyncState } from "../lib/app-context.tsx";
import { gigDisplayTitle } from "../lib/gig-title.ts";
import { applyGigFilters, parseGigFilters, toSearchParams } from "../lib/gig-filters.ts";
import { GigFilters } from "./gigs/GigFilters.tsx";
```

`EmptyState`'s `cta`/`to` are optional, so the filtered-empty state
above compiles as written.

- [ ] **Step 7: Write the e2e**

Create `webapp/e2e/gig-list.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { requireTestAuth } from "./helpers/test-auth.ts";

test.beforeEach(async ({ page, request, baseURL }) => {
  await requireTestAuth(request, baseURL!);
  await page.goto("/login");
  await page.getByTestId("test-signin").click();
  await expect(page.getByTestId("tab-bar")).toBeVisible();
});

test("search narrows the list and survives opening a gig", async ({ page }) => {
  const marker = `findme-${Date.now()}`;

  await page.getByRole("link", { name: "Gigs" }).click();
  await page.getByRole("link", { name: "Add gig" }).click();
  await page.getByLabel("Location").fill(marker);
  await page.getByRole("button", { name: "Save gig" }).click();
  await expect(page.getByText(marker)).toBeVisible({ timeout: 15_000 });

  await page.getByTestId("gig-search").fill(marker);
  await expect(page.getByTestId("gig-filter-count")).toContainText("Showing 1 of");

  // The filter is in the URL, so it is still there after a round trip
  // into a gig and back — the whole reason it lives there.
  await page.getByText(marker).click();
  await page.goBack();
  await expect(page.getByTestId("gig-search")).toHaveValue(marker);
  await expect(page.getByText(marker)).toBeVisible();
});

test("a filter matching nothing says so instead of offering to add a gig", async ({
  page,
}) => {
  await page.goto("/gigs");
  await page.getByTestId("gig-search").fill(`no-such-gig-${Date.now()}`);

  await expect(page.getByText("No gigs match these filters")).toBeVisible();
});

test("status filter and clear work together", async ({ page }) => {
  await page.goto("/gigs");
  await page.getByTestId("gig-filters-toggle").click();
  await page.getByTestId("gig-status-paid").click();

  await expect(page).toHaveURL(/status=paid/);

  await page.getByTestId("gig-filters-clear").click();
  await expect(page).not.toHaveURL(/status=paid/);
});
```

- [ ] **Step 8: Run everything**

```bash
cd webapp && pnpm typecheck && npx vitest run
cd webapp && E2E_BASE_URL=http://localhost:5210 E2E_REQUIRE_AUTH=1 npx playwright test --project=chromium
cd backend && pnpm typecheck && npx vitest run --no-file-parallelism
```

Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add webapp
git commit -m "Sort, filter, search and hide past gigs, with the filter in the URL"
```

---

## Self-review notes

- **Spec coverage:** all five requested improvements have a task —
  time steps (2), unsynced dot (4), stale reopen (1), list controls
  (5), title with notes fallback (3).
- **Type consistency:** `gigDisplayTitle(gig, clientName)` is used with
  that signature in Task 5; `applyGigFilters(gigs, filters, names, now)`
  matches its definition and every test call; `pendingIds(entity)`
  matches its use as `pendingGigIds()`.
- **Known follow-on:** adding `Gig.title` means every existing
  `Gig`-shaped fixture in webapp tests needs the field. Task 3 Step 11
  is where that surfaces; fix the fixtures it names rather than
  loosening the type.
