# Invoice PDF from Reports — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a freelancer produce a real, numbered invoice for one client's unpaid work and save it as a PDF through the browser's own print pipeline — and add the help topic that walks them through it.

**Architecture:** A pure `invoice.ts` builds an `InvoiceDocument` from the local ledger, reusing the same filtering the CSV exports use so the three can never disagree. `/reports` gains a section that allocates a number and navigates to `/reports/invoice`, which renders the document as ordinary DOM. An `@media print` stylesheet hides the app chrome so printing yields just the invoice. Business identity and the number counter are new Settings fields, which means a matching change on the server, because the settings blob is validated there.

**Tech Stack:** TypeScript, React 19, react-router-dom, TanStack Query, Zod (backend), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-28-invoice-pdf-design.md`

**Branch:** `feat/invoice-pdf`, cut from `main` at `9b45c7d`.

> **Commits:** this project's standing rule is that nothing is committed,
> merged or pushed without the user's direct instruction. Each task ends
> with the commit it *should* make; run it only once the user has said so.

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `backend/src/domain/settings.ts` | Modify | Seven new fields on `SettingsSchema`, with defaults. The server is the authority; without this it rejects them. |
| `backend/test/settings-domain.test.ts` | Modify | Its `DEFAULT_SETTINGS` `toEqual` pins every default, so it must learn the new ones. |
| `webapp/src/lib/settings-schema.ts` | Modify | The hand-kept client mirror of the above. |
| `webapp/src/screens/settings/BusinessSection.tsx` | **Create** | The Settings UI for business identity and invoice terms. |
| `webapp/src/screens/settings/BusinessSection.test.tsx` | **Create** | Fields render current values and patch on change. |
| `webapp/src/screens/Settings.tsx` | Modify | Mount the new section. |
| `webapp/src/lib/invoice.ts` | **Create** | Pure: line selection, totals, number formatting. No DOM, no React. |
| `webapp/src/lib/invoice.test.ts` | **Create** | Line rules, totals, and agreement with `report-export.ts`. |
| `webapp/src/screens/Reports.tsx` | Modify | The Invoice section: the button, the needs-a-client hint, number allocation, navigation. |
| `webapp/src/screens/Reports.test.tsx` | **Create** | The URL the button navigates to. The hint-vs-button rendering is proved in `e2e/invoice.spec.ts` instead: `Reports` reads the ledger through `useData`, and mocking four loads plus settings to assert one paragraph is more scaffolding than signal. |
| `webapp/src/screens/Invoice.tsx` | **Create** | The document: header, lines, expenses, total, Print button. |
| `webapp/src/screens/Invoice.test.tsx` | **Create** | Renders lines and total; empty state; missing-details prompt. |
| `webapp/src/App.tsx` | Modify | The `/reports/invoice` route. |
| `webapp/src/styles/print.css` | **Create** | `@media print` rules. |
| `webapp/src/styles.css` | Modify | Import the above. |
| `webapp/src/help/targets.ts` | Modify | Targets for the new controls. |
| `webapp/src/help/scenarios/create-invoice.ts` | **Create** | The help topic. |
| `webapp/src/help/registry.ts` | Modify | Register it. |
| `webapp/e2e/invoice.spec.ts` | **Create** | End-to-end: generate a document, and prove the print rules apply. |
| `docs/help/README.md` | Modify | §6 gains the gap this scenario ships with. |

**Why this order.** Settings first, both halves, because everything reads those fields. The pure core next, so the screens are assembled from something already tested. Reports before Invoice, because Reports is what allocates the number and builds the URL. Help after the screens exist, so its targets resolve. Docs and verification last.

---

## Task 1: Settings fields, on both sides of the wire

**Files:**
- Modify: `backend/src/domain/settings.ts`
- Modify: `backend/test/settings-domain.test.ts`
- Modify: `webapp/src/lib/settings-schema.ts`

`webapp/src/lib/settings-schema.ts`'s own header explains why this is two-sided: it is "a hand-kept mirror of backend/src/domain/settings.ts… the server is the authority — it fills defaults on every read and rejects anything it does not recognise". Add the field on one side only and the client sends something the server 400s.

- [ ] **Step 1: Write the failing test**

In `backend/test/settings-domain.test.ts`, find the `it("states the defaults the rest of the app relies on")` case and add these seven keys to the object passed to `toEqual`, keeping the existing keys exactly as they are:

```ts
      businessName: null,
      businessAddress: null,
      businessContact: null,
      businessTaxId: null,
      businessPaymentDetails: null,
      invoiceNextNumber: 1,
      invoicePaymentTermsDays: 14,
```

Then append a new case to the same file, at the end of the `describe("parseSettings", …)` block:

```ts
  it("bounds the invoice fields a user can type into", () => {
    // These print onto a document that leaves the building, and the
    // counter feeds a number that must never repeat. A string long
    // enough to break the layout, or a zero counter, is a client bug
    // the server should refuse rather than store.
    expect(SettingsPatchSchema.safeParse({ invoiceNextNumber: 0 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ invoiceNextNumber: 1 }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ invoicePaymentTermsDays: 0 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ invoicePaymentTermsDays: 14 }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ businessName: "x".repeat(121) }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ businessName: "Tsygankov Ltd" }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ businessAddress: null }).success).toBe(true);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter gigsy-backend exec vitest run test/settings-domain.test.ts`

Expected: FAIL. The `toEqual` case fails because `DEFAULT_SETTINGS` lacks the seven keys; the new case fails because the schema accepts anything it does not know about (it strips unknown keys, so `safeParse` succeeds where the test wants `false`).

- [ ] **Step 3: Add the fields to the server schema**

In `backend/src/domain/settings.ts`, append this block to `SettingsSchema` — after the availability fields, before the closing `})`:

```ts
  // --- Invoicing (invoice-pdf spec, 2026-08-28) ---
  // Identity printed on a document that leaves the building, so every
  // one of these is bounded rather than merely typed: an unbounded
  // string here is a layout break on somebody else's desk, not just a
  // large row.
  businessName: z.string().min(1).max(120).nullable().default(null),
  businessAddress: z.string().min(1).max(400).nullable().default(null),
  businessContact: z.string().min(1).max(200).nullable().default(null),
  businessTaxId: z.string().min(1).max(60).nullable().default(null),
  businessPaymentDetails: z.string().min(1).max(400).nullable().default(null),
  /** The number the NEXT invoice will carry. Allocated and incremented
   *  by the client when a document is opened, so gaps are ordinary —
   *  an abandoned invoice burns one. Repeats are not ordinary, which is
   *  why this is a stored counter and not derived from a count. */
  invoiceNextNumber: z.number().int().min(1).default(1),
  /** Days from issue to due, printed on the document. */
  invoicePaymentTermsDays: z.number().int().min(1).max(365).default(14),
```

- [ ] **Step 4: Mirror them on the client**

In `webapp/src/lib/settings-schema.ts`, append to the `Settings` interface, before its closing brace:

```ts
  // --- Invoicing ---
  // Mirrors backend/src/domain/settings.ts. The server bounds these;
  // this side only needs their shape.
  businessName: string | null;
  businessAddress: string | null;
  businessContact: string | null;
  businessTaxId: string | null;
  businessPaymentDetails: string | null;
  /** The number the NEXT invoice will carry. */
  invoiceNextNumber: number;
  invoicePaymentTermsDays: number;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter gigsy-backend exec vitest run test/settings-domain.test.ts`

Expected: PASS.

- [ ] **Step 6: Run the full backend suite and both typechecks**

```bash
pnpm --filter gigsy-backend test && pnpm --filter gigsy-backend exec tsc --noEmit && pnpm --filter gigsy-webapp typecheck
```

Expected: all green. `settings-routes.test.ts` also round-trips the blob, so a mismatch between the two halves shows there.

- [ ] **Step 7: Bump the worker version**

`Version bump check` fails any PR that touches `backend/**` without a patch bump.

**Observed during execution: the `bump_versions` pre-commit hook bumps
the WORKER too**, not just the webapp, whenever backend files are
staged — so this step is belt and braces rather than the only source of
the bump. Run it anyway if you like (an extra patch bump is harmless
and the check only wants *a* bump), but do not be surprised when the
hook has already done it, and do not bump a second time by hand trying
to "fix" that.

```bash
python -c "import json,io;p='backend/package.json';d=json.load(io.open(p));a=d['version'].split('.');a[2]=str(int(a[2])+1);d['version']='.'.join(a);io.open(p,'w').write(json.dumps(d,indent=2)+'\n');print(d['version'])"
```

- [ ] **Step 8: Commit**

```bash
git add backend/src/domain/settings.ts backend/test/settings-domain.test.ts backend/package.json webapp/src/lib/settings-schema.ts && git commit -m "feat(settings): business identity and invoice numbering"
```

---

## Task 2: The Business details section in Settings

**Files:**
- Create: `webapp/src/screens/settings/BusinessSection.tsx`
- Create: `webapp/src/screens/settings/BusinessSection.test.tsx`
- Modify: `webapp/src/screens/Settings.tsx`

Follow `GigDefaultsSection.tsx` for structure: read through `useSettings()`, return `null` while `settings` is undefined, wrap in `SettingGroup`, one `SettingRow` per field.

**Do NOT copy its `disabled={isSaving}`.** Corrected during execution,
after review probed the real component: that rule is right for selects
and toggles, where the control *is* the value and a second write racing
the first is real. For a field whose commit is triggered by *leaving*
it, disabling the whole group on commit fights the user's next action —
clicking from Name into Address commits Name, flips `isSaving`, disables
Address, and the browser blurs the field the user just clicked into,
firing a second redundant write and losing anything typed in the gap.
The write is optimistic, so there is nothing to wait for.

**Skip writes that change nothing.** Blurring an untouched field must
not PATCH; `AvailabilitySection.tsx` already guards this
(`if (next !== settings.availabilityDisplayName)`), and without it
tabbing through this section produces seven writes.

**Every text input carries a `maxLength` matching its server bound**
(120 / 400 / 200 / 120 / 600). Without it, pasting an over-long value
gets a 400, and `useSettings`'s optimistic `onError` rolls the value
back — so the text simply vanishes from the box with no explanation.
`AvailabilitySection.tsx` already sets `maxLength={60}` on the display
name for exactly this reason.

- [ ] **Step 1: Write the failing test**

Create `webapp/src/screens/settings/BusinessSection.test.tsx`:

```tsx
/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BusinessSection } from "./BusinessSection.tsx";

const update = vi.fn();
let settings: Record<string, unknown> | undefined;

vi.mock("./useSettings.ts", () => ({
  useSettings: () => ({ settings, update, isSaving: false }),
}));

// react-dom's own `act` warns without this. Same setup as
// HelpProvider.test.tsx, which explains why it is not a global.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  update.mockReset();
  settings = {
    businessName: "Tsygankov Ltd",
    businessAddress: null,
    businessContact: null,
    businessTaxId: null,
    businessPaymentDetails: null,
    invoiceNextNumber: 7,
    invoicePaymentTermsDays: 14,
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = () => act(() => root.render(<BusinessSection />));
const field = (id: string) =>
  container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-testid="${id}"]`);

describe("BusinessSection", () => {
  it("renders nothing until settings have loaded", () => {
    settings = undefined;
    render();
    expect(container.textContent).toBe("");
  });

  it("shows the stored values", () => {
    render();
    expect(field("business-name")?.value).toBe("Tsygankov Ltd");
    expect(field("invoice-next-number")?.value).toBe("7");
  });

  it("patches a text field on blur, not on every keystroke", () => {
    // A settings PATCH per character would queue a write per letter of
    // an address. The rest of Settings uses selects and toggles, which
    // have no such problem; free text is the first field here that does.
    render();
    const name = field("business-name")!;
    act(() => {
      name.value = "New Name";
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(update).not.toHaveBeenCalled();
    act(() => name.dispatchEvent(new Event("blur", { bubbles: true })));
    expect(update).toHaveBeenCalledWith({ businessName: "New Name" });
  });

  it("stores an emptied field as null, not an empty string", () => {
    // The server bounds these with `.min(1)`, so "" is a 400. Absent
    // means null.
    render();
    const name = field("business-name")!;
    act(() => {
      name.value = "";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      name.dispatchEvent(new Event("blur", { bubbles: true }));
    });
    expect(update).toHaveBeenCalledWith({ businessName: null });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter gigsy-webapp exec vitest run src/screens/settings/BusinessSection.test.tsx`

Expected: FAIL — `Failed to resolve import "./BusinessSection.tsx"`.

- [ ] **Step 3: Write the section**

Create `webapp/src/screens/settings/BusinessSection.tsx`:

```tsx
/**
 * Who the invoice is FROM, and how it is numbered.
 *
 * None of this affects the app's own behaviour — it exists to be
 * printed on a document that goes to somebody else. That is why every
 * field is optional: a user who never invoices should not be nagged,
 * and one who does gets told what is missing on the invoice itself
 * rather than being blocked here.
 *
 * Free text is a first for this screen. Every other section is selects
 * and toggles, which commit on change; committing an address on change
 * would queue a settings PATCH per keystroke, so these commit on blur.
 */
import { useEffect, useState } from "react";
import { Input, SettingGroup, SettingRow, Textarea } from "../../components/index.ts";
import { useSettings } from "./useSettings.ts";

/** Local draft that follows the stored value until the user types.
 *  Without this, an optimistic settings write would rewrite the box
 *  under the cursor. */
function useDraft(stored: string | null): [string, (v: string) => void] {
  const [draft, setDraft] = useState(stored ?? "");
  useEffect(() => setDraft(stored ?? ""), [stored]);
  return [draft, setDraft];
}

export function BusinessSection() {
  const { settings, update, isSaving } = useSettings();
  const [name, setName] = useDraft(settings?.businessName ?? null);
  const [address, setAddress] = useDraft(settings?.businessAddress ?? null);
  const [contact, setContact] = useDraft(settings?.businessContact ?? null);
  const [taxId, setTaxId] = useDraft(settings?.businessTaxId ?? null);
  const [payment, setPayment] = useDraft(settings?.businessPaymentDetails ?? null);
  // The two counters are drafts as well, so typing "1024" is not four
  // settings writes. `useDraft` takes a string, so they are stringified
  // on the way in and parsed on blur.
  const [number, setNumber] = useDraft(
    settings === undefined ? null : String(settings.invoiceNextNumber),
  );
  const [terms, setTerms] = useDraft(
    settings === undefined ? null : String(settings.invoicePaymentTermsDays),
  );

  if (settings === undefined) return null;

  /** "" is not a value the server will take — every one of these is
   *  `.min(1).nullable()`, so an emptied box means null.
   *
   *  The key is a union, not `string`: `update({ [key]: … })` with a
   *  `string` key widens to `{ [x: string]: string | null }`, which is
   *  not assignable to `Partial<Settings>` — it would have to satisfy
   *  `invoiceNextNumber?: number` too. */
  type TextField =
    | "businessName"
    | "businessAddress"
    | "businessContact"
    | "businessTaxId"
    | "businessPaymentDetails";

  const commit = (key: TextField, value: string): void => {
    const trimmed = value.trim();
    update({ [key]: trimmed === "" ? null : trimmed });
  };

  return (
    <SettingGroup title="Business details" data-testid="settings-business">
      <SettingRow
        label="Business name"
        description="Printed at the top of every invoice. Your own name is fine."
        htmlFor="set-business-name"
        control={
          <Input
            id="set-business-name"
            data-testid="business-name"
            maxLength={120}
            value={name}
            disabled={isSaving}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => commit("businessName", name)}
          />
        }
      />
      <SettingRow
        label="Address"
        description="Your postal address, as it should appear on the invoice."
        htmlFor="set-business-address"
        control={
          <Textarea
            id="set-business-address"
            data-testid="business-address"
            maxLength={400}
            rows={3}
            value={address}
            disabled={isSaving}
            onChange={(e) => setAddress(e.target.value)}
            onBlur={() => commit("businessAddress", address)}
          />
        }
      />
      <SettingRow
        label="Contact"
        description="Email or phone — how the client reaches you about this bill."
        htmlFor="set-business-contact"
        control={
          <Input
            id="set-business-contact"
            data-testid="business-contact"
            maxLength={200}
            value={contact}
            disabled={isSaving}
            onChange={(e) => setContact(e.target.value)}
            onBlur={() => commit("businessContact", contact)}
          />
        }
      />
      <SettingRow
        label="Tax / VAT number"
        description="Printed as text. Gigsy does not calculate tax."
        htmlFor="set-business-taxid"
        control={
          <Input
            id="set-business-taxid"
            data-testid="business-taxid"
            maxLength={120}
            value={taxId}
            disabled={isSaving}
            onChange={(e) => setTaxId(e.target.value)}
            onBlur={() => commit("businessTaxId", taxId)}
          />
        }
      />
      <SettingRow
        label="Payment details"
        description="Bank account, IBAN, or however you want to be paid."
        htmlFor="set-business-payment"
        control={
          <Textarea
            id="set-business-payment"
            data-testid="business-payment"
            maxLength={600}
            rows={3}
            value={payment}
            disabled={isSaving}
            onChange={(e) => setPayment(e.target.value)}
            onBlur={() => commit("businessPaymentDetails", payment)}
          />
        }
      />
      <SettingRow
        label="Next invoice number"
        description="Counts up on its own. Change it if you are continuing a sequence from elsewhere."
        htmlFor="set-invoice-number"
        control={
          <Input
            id="set-invoice-number"
            data-testid="invoice-next-number"
            type="number"
            min={1}
            max={9999999}
            value={number}
            disabled={isSaving}
            onChange={(e) => setNumber(e.target.value)}
            // On blur, like the text fields above and for the same
            // reason: committing on change is a settings PATCH per
            // keystroke, so typing "1024" would write 1, then 10, then
            // 102. An out-of-range value is discarded rather than sent,
            // because the server bounds this at 1..9,999,999 and a 400
            // here would silently roll the counter back.
            onBlur={() => {
              const n = Number(number);
              if (Number.isInteger(n) && n >= 1 && n <= 9_999_999) {
                update({ invoiceNextNumber: n });
              } else {
                setNumber(String(settings.invoiceNextNumber));
              }
            }}
          />
        }
      />
      <SettingRow
        label="Payment terms (days)"
        description="How long the client has to pay. Sets the due date on the invoice."
        htmlFor="set-invoice-terms"
        control={
          <Input
            id="set-invoice-terms"
            data-testid="invoice-terms-days"
            type="number"
            min={1}
            max={365}
            value={terms}
            disabled={isSaving}
            onChange={(e) => setTerms(e.target.value)}
            onBlur={() => {
              const n = Number(terms);
              if (Number.isInteger(n) && n >= 1 && n <= 365) {
                update({ invoicePaymentTermsDays: n });
              } else {
                setTerms(String(settings.invoicePaymentTermsDays));
              }
            }}
          />
        }
      />
    </SettingGroup>
  );
}
```

- [ ] **Step 4: Mount it**

In `webapp/src/screens/Settings.tsx`, add the import beside the other section imports:

```tsx
import { BusinessSection } from "./settings/BusinessSection.tsx";
```

and render `<BusinessSection />` immediately after `<GigDefaultsSection />`.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter gigsy-webapp exec vitest run src/screens/settings/
pnpm --filter gigsy-webapp typecheck
```

Expected: PASS and exit 0.

- [ ] **Step 6: Commit**

```bash
git add webapp/src/screens/settings/BusinessSection.tsx webapp/src/screens/settings/BusinessSection.test.tsx webapp/src/screens/Settings.tsx && git commit -m "feat(settings): a Business details section for invoicing"
```

---

## Task 3: `invoice.ts` — the pure core

**Files:**
- Create: `webapp/src/lib/invoice.ts`
- Create: `webapp/src/lib/invoice.test.ts`

This is the whole feature's correctness. It reuses `inRange` from `report-export.ts`, `outstandingCents` and `storedOrDerivedExpectedCents` from `gig-pay.ts`, and reproduces `expenseRows`' expense rules exactly — the same-date, same-client semantics, so an invoice can never disagree with the CSV it came from.

- [ ] **Step 1: Write the failing test**

Create `webapp/src/lib/invoice.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildInvoice, formatInvoiceNumber } from "./invoice.ts";
import type { Expense, Gig, Service } from "./types.ts";

const BUSINESS = {
  name: "Tsygankov Ltd",
  address: "1 Example St",
  contact: "me@example.com",
  taxId: null,
  paymentDetails: "IBAN 123",
};

const DAY = 24 * 60 * 60 * 1000;
const JAN = Date.UTC(2026, 0, 15);

function gig(over: Partial<Gig>): Gig {
  return {
    id: "g1",
    clientId: "c1",
    title: "Tasting",
    dateTime: JAN,
    durationMinutes: 180,
    status: "completed",
    payType: "fixed",
    amountOfferedCents: 10000,
    amountPaidCents: 0,
    expectedCents: 10000,
    hourlyRateCents: null,
    workStartedAt: null,
    workEndedAt: null,
    breakMinutes: null,
    location: null,
    notes: null,
    source: "manual",
    parentGigId: null,
    createdAt: JAN,
    modifiedAt: JAN,
    // Spread LAST, like service() and expense() below. Omitting it was
    // a bug in the first draft of this plan: every override-dependent
    // test silently exercised the default gig instead, and 8 of the 18
    // fail once it is restored.
    ...over,
  } as Gig;
}

function service(over: Partial<Service>): Service {
  return {
    id: "s1",
    gigId: "g1",
    description: "Extra hour",
    amountOfferedCents: 5000,
    amountPaidCents: 0,
    paymentId: null,
    isCompleted: true,
    createdAt: JAN,
    modifiedAt: JAN,
    ...over,
  };
}

function expense(over: Partial<Expense>): Expense {
  return {
    id: "e1",
    gigId: "g1",
    amountCents: 2000,
    category: "parking",
    receiptR2Key: null,
    notes: null,
    reimbursable: true,
    createdAt: JAN,
    modifiedAt: JAN,
    ...over,
  };
}

const build = (over: Partial<Parameters<typeof buildInvoice>[0]> = {}) =>
  buildInvoice({
    gigs: [gig({})],
    services: [],
    expenses: [],
    clientId: "c1",
    clientName: "Acme",
    filters: {},
    business: BUSINESS,
    number: "INV-0001",
    issuedAt: JAN,
    termsDays: 14,
    ...over,
  });

describe("formatInvoiceNumber", () => {
  it("pads to four digits and keeps going past them", () => {
    expect(formatInvoiceNumber(1)).toBe("INV-0001");
    expect(formatInvoiceNumber(42)).toBe("INV-0042");
    expect(formatInvoiceNumber(12345)).toBe("INV-12345");
  });
});

describe("buildInvoice — which gigs become lines", () => {
  it("bills a completed gig with something outstanding", () => {
    const doc = build();
    expect(doc.lines).toHaveLength(1);
    expect(doc.lines[0]).toMatchObject({ description: "Tasting", amountCents: 10000 });
    expect(doc.totalCents).toBe(10000);
  });

  it("bills the remainder of a part-paid gig, not the whole fee", () => {
    const doc = build({ gigs: [gig({ amountPaidCents: 4000 })] });
    expect(doc.lines[0]?.amountCents).toBe(6000);
    expect(doc.totalCents).toBe(6000);
  });

  it("skips a settled gig", () => {
    expect(build({ gigs: [gig({ amountPaidCents: 10000 })] }).lines).toEqual([]);
  });

  it("skips a gig that is not completed or delivered", () => {
    expect(build({ gigs: [gig({ status: "confirmed" })] }).lines).toEqual([]);
    expect(build({ gigs: [gig({ status: "lead" })] }).lines).toEqual([]);
    expect(build({ gigs: [gig({ status: "cancelled" })] }).lines).toEqual([]);
    expect(build({ gigs: [gig({ status: "delivered" })] }).lines).toHaveLength(1);
  });

  it("skips another client's gig", () => {
    expect(build({ gigs: [gig({ clientId: "c2" })] }).lines).toEqual([]);
  });

  it("honours the date range, and drops a dateless gig once a bound exists", () => {
    expect(build({ filters: { from: JAN + DAY } }).lines).toEqual([]);
    expect(build({ filters: { to: JAN - DAY } }).lines).toEqual([]);
    expect(build({ filters: { from: JAN - DAY, to: JAN + DAY } }).lines).toHaveLength(1);
    expect(build({ gigs: [gig({ dateTime: null })], filters: { from: JAN } }).lines).toEqual([]);
  });
});

describe("buildInvoice — services", () => {
  it("bills a service's own remainder under its gig", () => {
    const doc = build({ services: [service({ amountPaidCents: 1000 })] });
    expect(doc.lines).toHaveLength(2);
    expect(doc.lines[1]).toMatchObject({ description: "Extra hour", amountCents: 4000 });
    expect(doc.totalCents).toBe(14000);
  });

  it("skips a settled service", () => {
    expect(build({ services: [service({ amountPaidCents: 5000 })] }).lines).toHaveLength(1);
  });

  it("skips a service whose gig is not on the invoice", () => {
    // Deliberate: a line with no work above it reads as a mistake to
    // whoever receives the invoice. See the spec.
    const doc = build({
      gigs: [gig({ amountPaidCents: 10000 })],
      services: [service({})],
    });
    expect(doc.lines).toEqual([]);
    expect(doc.totalCents).toBe(0);
  });
});

describe("buildInvoice — reimbursable expenses", () => {
  it("lists a reimbursable expense separately and adds it to the total", () => {
    const doc = build({ expenses: [expense({})] });
    expect(doc.lines).toHaveLength(1);
    expect(doc.expenses).toHaveLength(1);
    expect(doc.expenses[0]).toMatchObject({ description: "parking", amountCents: 2000 });
    expect(doc.totalCents).toBe(12000);
  });

  it("skips a non-reimbursable expense", () => {
    expect(build({ expenses: [expense({ reimbursable: false })] }).expenses).toEqual([]);
  });

  it("skips an expense with no gig, because it cannot belong to a client", () => {
    // Matches expenseRows: "A client filter inner-joins gigs on the
    // server, so an unlinked expense cannot belong to the selected
    // client."
    expect(build({ expenses: [expense({ gigId: null })] }).expenses).toEqual([]);
  });

  it("dates an expense by its gig, not by when it was recorded", () => {
    const doc = build({
      gigs: [gig({ dateTime: JAN })],
      expenses: [expense({ createdAt: JAN + 90 * DAY })],
      filters: { from: JAN - DAY, to: JAN + DAY },
    });
    expect(doc.expenses).toHaveLength(1);
    expect(doc.expenses[0]?.date).toBe(JAN);
  });

  it("falls back to when it was recorded when its gig has no date", () => {
    // The other half of the `gig?.dateTime ?? e.createdAt` rule, which
    // the test above never reaches. No bounds, because `inRange` only
    // admits a dateless row when there are none.
    const doc = build({
      gigs: [gig({ dateTime: null })],
      expenses: [expense({ createdAt: JAN + 90 * DAY })],
      filters: {},
    });
    expect(doc.expenses).toHaveLength(1);
    expect(doc.expenses[0]?.date).toBe(JAN + 90 * DAY);
  });

  it("bills a reimbursable expense even when its gig is settled", () => {
    // An expense is a cost the client agreed to cover; whether the WORK
    // has been paid for is a different question. This is the one place
    // expenses deliberately do not follow their gig.
    const doc = build({
      gigs: [gig({ amountPaidCents: 10000 })],
      expenses: [expense({})],
    });
    expect(doc.lines).toEqual([]);
    expect(doc.expenses).toHaveLength(1);
    expect(doc.totalCents).toBe(2000);
  });
});

describe("buildInvoice — the document", () => {
  it("carries the number, the parties, and a due date from the terms", () => {
    const doc = build({ termsDays: 30 });
    expect(doc.number).toBe("INV-0001");
    expect(doc.client).toEqual({ id: "c1", name: "Acme" });
    expect(doc.business.name).toBe("Tsygankov Ltd");
    expect(doc.issuedAt).toBe(JAN);
    expect(doc.dueAt).toBe(JAN + 30 * DAY);
  });

  it("sorts lines oldest first", () => {
    const doc = build({
      gigs: [
        gig({ id: "late", dateTime: JAN + DAY, title: "Later" }),
        gig({ id: "early", dateTime: JAN, title: "Earlier" }),
      ],
    });
    expect(doc.lines.map((l) => l.description)).toEqual(["Earlier", "Later"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter gigsy-webapp exec vitest run src/lib/invoice.test.ts`

Expected: FAIL — `Failed to resolve import "./invoice.ts"`.

- [ ] **Step 3: Write the module**

Create `webapp/src/lib/invoice.ts`:

```ts
/**
 * What one client owes, as a document.
 *
 * A third output over the same ledger the CSV exports read, and it must
 * agree with them. `report-export.ts`'s header states the rule this
 * file inherits: filtering "deliberately reproduces the endpoint's SQL
 * semantics so a CSV can never disagree with the numbers it was
 * exported from". So `inRange` is imported rather than rewritten, and
 * the expense rules below are `expenseRows`' rules, not new ones.
 *
 * Pure: no DOM, no React, no formatting. The screen decides how money
 * and dates are rendered; this decides what is owed.
 */
import { inRange } from "./report-export.ts";
import { outstandingCents } from "./gig-pay.ts";
import { gigDisplayTitle } from "./gig-title.ts";
import type { Expense, Gig, ReportFilters, Service } from "./types.ts";

export interface BusinessDetails {
  name: string | null;
  address: string | null;
  contact: string | null;
  taxId: string | null;
  paymentDetails: string | null;
}

export interface InvoiceLine {
  /** Epoch ms. Every line on an invoice has a date — a gig's, or the
   *  day an expense was recorded. */
  date: number;
  description: string;
  amountCents: number;
}

export interface InvoiceDocument {
  number: string;
  issuedAt: number;
  dueAt: number;
  business: BusinessDetails;
  client: { id: string; name: string };
  /** Work: gigs, each followed by its own outstanding services. */
  lines: InvoiceLine[];
  /** Costs the client agreed to cover, kept apart from the work the
   *  way Reports keeps `reimbursableCents` apart from net. */
  expenses: InvoiceLine[];
  /** Work that qualifies but cannot be priced — `completed` or
   *  `delivered`, in range, for this client, but `expectedCents` is
   *  null because an hourly gig has no rate or a fixed one has no
   *  amount. Deliberately NOT billed: a $0.00 line is worse than no
   *  line. Surfaced so the document can say so, because otherwise the
   *  user prints, sends, and under-bills with nothing anywhere
   *  admitting it. Selected with `outstandingCents(g) === null`, never
   *  `?? 0` — that is what conflates "unknown" with "settled". */
  unpricedGigs: { id: string; description: string }[];
  totalCents: number;
}

export interface BuildInvoiceInput {
  gigs: Gig[];
  services: Service[];
  expenses: Expense[];
  clientId: string;
  clientName: string;
  filters: ReportFilters;
  business: BusinessDetails;
  number: string;
  issuedAt: number;
  termsDays: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Zero-padded to four, then simply longer. A five-digit invoice is a
 *  good problem to have and must not become "INV-1234 5". */
export function formatInvoiceNumber(n: number): string {
  return `INV-${String(n).padStart(4, "0")}`;
}

/** Work that has been done and not paid for. `completed` and
 *  `delivered` are the two statuses reports.ts counts as owed; a lead
 *  or a confirmed booking has not happened yet, and a cancellation
 *  never will. */
const BILLABLE_STATUSES = new Set(["completed", "delivered"]);

export function buildInvoice(input: BuildInvoiceInput): InvoiceDocument {
  const {
    gigs, services, expenses, clientId, clientName,
    filters, business, number, issuedAt, termsDays,
  } = input;

  const billable = gigs
    .filter(
      (g) =>
        g.clientId === clientId &&
        BILLABLE_STATUSES.has(g.status) &&
        inRange(g.dateTime, filters) &&
        (outstandingCents(g) ?? 0) > 0,
    )
    .sort((a, b) => (a.dateTime ?? 0) - (b.dateTime ?? 0));

  const lines: InvoiceLine[] = [];
  for (const g of billable) {
    lines.push({
      // A billable gig has passed `inRange`, which only lets a dateless
      // gig through when there are no bounds at all — and then there is
      // nothing better to date the line by than when it was created.
      date: g.dateTime ?? g.createdAt,
      // NOT `g.title`: it is `string | null`, and a gig often has no
      // name of its own (gig-title.ts's own doc says so). An empty
      // description is a blank row on a document somebody is being
      // asked to pay from. `gigDisplayTitle` is what Gigs.tsx and
      // GigDetail.tsx already use for this, and `clientName` is
      // already in hand.
      description: gigDisplayTitle(g, clientName),
      amountCents: outstandingCents(g) ?? 0,
    });
    for (const s of services) {
      if (s.gigId !== g.id) continue;
      const owed = (s.amountOfferedCents ?? 0) - (s.amountPaidCents ?? 0);
      if (owed <= 0) continue;
      lines.push({
        date: g.dateTime ?? g.createdAt,
        description: s.description,
        amountCents: owed,
      });
    }
  }

  // `expenseRows`' rules, one for one: an expense belongs to a client
  // only through its gig, and is dated by that gig, falling back to
  // when it was recorded. Note this does NOT require the gig to be
  // billable — a cost the client agreed to cover is owed whether or not
  // the work it attached to has been paid for.
  const gigById = new Map(gigs.map((g) => [g.id, g]));
  const billedExpenses: InvoiceLine[] = expenses
    .filter((e) => {
      if (!e.reimbursable) return false;
      const gig = e.gigId !== null ? gigById.get(e.gigId) : undefined;
      if (gig?.clientId !== clientId) return false;
      return inRange(gig.dateTime ?? e.createdAt, filters);
    })
    .map((e) => {
      const gig = gigById.get(e.gigId!);
      return {
        date: gig?.dateTime ?? e.createdAt,
        description: e.category ?? "Expense",
        amountCents: e.amountCents,
      };
    })
    .sort((a, b) => a.date - b.date);

  const totalCents =
    lines.reduce((sum, l) => sum + l.amountCents, 0) +
    billedExpenses.reduce((sum, l) => sum + l.amountCents, 0);

  return {
    number,
    issuedAt,
    dueAt: issuedAt + termsDays * DAY_MS,
    business,
    client: { id: clientId, name: clientName },
    lines,
    expenses: billedExpenses,
    totalCents,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter gigsy-webapp exec vitest run src/lib/invoice.test.ts`

Expected: PASS. If the `Gig` literal in the test does not satisfy the real type, fix the literal — do not loosen `buildInvoice`'s types.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter gigsy-webapp typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add webapp/src/lib/invoice.ts webapp/src/lib/invoice.test.ts && git commit -m "feat(invoice): build a client's outstanding work into a document"
```

---

## Task 4: The Invoice section on `/reports`

**Files:**
- Modify: `webapp/src/screens/Reports.tsx`
- Create: `webapp/src/screens/Reports.test.tsx`

The button allocates the number and navigates.

**A refinement to the spec.** The spec says the number is allocated
"when the document opens". This allocates it on the click that opens
it, which satisfies the same intent and is strictly safer: React
StrictMode double-invokes effects in development, so an allocating
effect on the invoice route would burn two numbers on every dev open.
A click handler runs once. It also leaves `/reports/invoice` free of
side effects, so the document is a pure function of its URL.

- [ ] **Step 1: Write the failing test**

Create `webapp/src/screens/Reports.test.tsx`:

```tsx
/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { invoiceHref } from "./Reports.tsx";

describe("invoiceHref", () => {
  it("carries the client, the number and the issue date", () => {
    expect(invoiceHref("c1", 7, 1000, {})).toBe(
      "/reports/invoice?client=c1&n=7&issued=1000",
    );
  });

  it("carries the date bounds when they exist", () => {
    expect(invoiceHref("c1", 1, 1000, { from: 100, to: 200 })).toBe(
      "/reports/invoice?client=c1&n=1&issued=1000&from=100&to=200",
    );
  });

  it("omits bounds that are not set, rather than sending empty ones", () => {
    // `?from=` parses to 0, not NaN — so a bound of epoch 0 would
    // silently drop every dated gig. The reader refuses an empty bound
    // for the same reason; see Invoice.tsx's `invoiceParams`.
    expect(invoiceHref("c1", 1, 1000, { from: 100 })).toBe(
      "/reports/invoice?client=c1&n=1&issued=1000&from=100",
    );
  });

  it("escapes a client id rather than trusting it in a query string", () => {
    expect(invoiceHref("a b&c", 1, 1000, {})).toBe(
      "/reports/invoice?client=a+b%26c&n=1&issued=1000",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter gigsy-webapp exec vitest run src/screens/Reports.test.tsx`

Expected: FAIL — `Reports.tsx` has no export named `invoiceHref`.

- [ ] **Step 3: Add the helper and the section**

In `webapp/src/screens/Reports.tsx`:

Add to the imports:

```tsx
import { useNavigate } from "react-router-dom";
import { buildInvoice, formatInvoiceNumber } from "../lib/invoice.ts";
import type { InvoiceDocument } from "../lib/invoice.ts";
import { useSettings } from "./settings/useSettings.ts";
```

Add this exported helper above the `Reports` component:

```tsx
/** Where the Create invoice button goes. Exported for its own test —
 *  a wrong query string here is a silently empty invoice, not a crash. */
export function invoiceHref(
  clientId: string,
  number: number,
  issuedAt: number,
  filters: { from?: number; to?: number },
): string {
  const params = new URLSearchParams({
    client: clientId,
    n: String(number),
    // The issue date belongs in the URL, not to the page view.
    // Everything else about this document is fixed by the link, and the
    // number certainly is — so without this, reopening the same link
    // tomorrow prints INV-0007 with a different issue AND due date than
    // the INV-0007 already on somebody's desk. Nothing is stored, so
    // the URL is the document's only identity.
    issued: String(issuedAt),
  });
  if (filters.from !== undefined) params.set("from", String(filters.from));
  if (filters.to !== undefined) params.set("to", String(filters.to));
  return `/reports/invoice?${params.toString()}`;
}
```

Inside the component, beside the existing export handlers:

```tsx
  const navigate = useNavigate();
  const { settings, updateAsync } = useSettings();

  /** Allocate a number and open the document.
   *
   *  Allocating on the click, not in an effect on the invoice route:
   *  StrictMode double-invokes effects in development, so an allocating
   *  effect burns two numbers per open. A handler runs once.
   *
   *  Nothing is allocated for an invoice with no lines — the counter is
   *  only spent on a document that exists. */
  async function createInvoice() {
    if (clientId === "" || settings === undefined) return;
    // Loaded here rather than from a query: this screen keeps no gig,
    // service or expense query. `exportIncome` and `exportExpenses`
    // each read the local ledger on demand, and this follows them, so
    // the invoice sees exactly what the CSVs would.
    const [gigList, serviceList, expenseList, clientList] = await Promise.all([
      data.listGigs(),
      data.listServices(),
      data.listExpenses(),
      data.listClients(),
    ]);
    const next = settings.invoiceNextNumber;
    // Captured once, here, and carried in the URL — see `invoiceHref`.
    const issuedAt = Date.now();
    const doc = buildInvoice({
      gigs: gigList,
      services: serviceList,
      expenses: expenseList,
      clientId,
      clientName: clientList.find((c) => c.id === clientId)?.name ?? "",
      filters,
      business: {
        name: settings.businessName,
        address: settings.businessAddress,
        contact: settings.businessContact,
        taxId: settings.businessTaxId,
        paymentDetails: settings.businessPaymentDetails,
      },
      number: formatInvoiceNumber(next),
      issuedAt,
      termsDays: settings.invoicePaymentTermsDays,
    });
    // "Nothing to bill" and "nothing we could price" are different
    // answers, and only the first should refuse to open a document. A
    // client whose only qualifying work is unpriced still deserves the
    // page that tells them so — refusing here would hide the warning
    // behind an empty state that says the opposite.
    if (
      doc.lines.length === 0 &&
      doc.expenses.length === 0 &&
      doc.unpricedGigs.length === 0
    ) {
      setInvoiceEmpty(true);
      return;
    }
    setInvoiceEmpty(false);
    // Await the write, and do not open the document if it failed.
    //
    // `updateSettings` is NOT in the offline outbox — data-service.ts
    // forwards it straight to the API — while the invoice itself builds
    // from the local ledger and would render happily offline. Fire and
    // forget would therefore print a number, have the PATCH reject, and
    // let `useSettings`'s `onError` roll the counter back, so the NEXT
    // invoice reuses a number already on somebody's desk. Gaps in a
    // sequence are ordinary; repeats are the one thing this counter
    // exists to prevent.
    try {
      await updateAsync({ invoiceNextNumber: next + 1 });
    } catch {
      setInvoiceError(true);
      return;
    }
    navigate(invoiceHref(clientId, next, issuedAt, filters));
  }
```

Add `const [invoiceEmpty, setInvoiceEmpty] = useState(false);` and
`const [invoiceError, setInvoiceError] = useState(false);` beside the
other `useState` calls, and reset both when the filters change by
adding `setInvoiceEmpty(false); setInvoiceError(false);` to the
`onChange` of `report-client`.

`updateAsync` does not exist on `useSettings` yet. Add it in
`webapp/src/screens/settings/useSettings.ts`, beside the existing
`update`:

```ts
    /** Like `update`, but awaitable and rejecting. For the one caller
     *  that must not proceed unless the write actually landed: the
     *  invoice number is printed on a document, so a rolled-back
     *  counter would be reused. */
    updateAsync: (patch: SettingsPatch) => mutation.mutateAsync(patch),
```

Then add this section immediately **before** `<section data-testid="report-exports">`:

```tsx
        <section data-testid="report-invoice">
          <SectionHeading>Invoice</SectionHeading>
          {clientId === "" ? (
            <p className="text-sm text-slate-600" data-testid="invoice-needs-client">
              An invoice is addressed to one client. Choose one above and it will
              cover their unpaid work in the period selected.
            </p>
          ) : (
            <>
              <Button
                variant="ghost"
                block
                data-testid="invoice-create"
                disabled={settings === undefined}
                onClick={() => void createInvoice()}
              >
                Create invoice
              </Button>
              {invoiceEmpty && (
                <p className="mt-2 text-sm text-slate-600" data-testid="invoice-empty">
                  Nothing to invoice — this client has no unpaid work in the period
                  selected.
                </p>
              )}
              {invoiceError && (
                <p className="mt-2 text-sm text-red-600" data-testid="invoice-error">
                  Couldn't reserve an invoice number — you may be offline. The
                  document wasn't created, so nothing has been used up.
                </p>
              )}
            </>
          )}
        </section>
```

The hint is a rendered element rather than an inference from the button's `disabled` attribute, because a help branch has to read something PRESENT — an absence is also true while a screen is loading. That is the lesson `no-gigs-yet` paid for.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter gigsy-webapp exec vitest run src/screens/Reports.test.tsx
pnpm --filter gigsy-webapp typecheck
```

Expected: PASS and exit 0.

- [ ] **Step 5: Commit**

```bash
git add webapp/src/screens/Reports.tsx webapp/src/screens/Reports.test.tsx webapp/src/screens/settings/useSettings.ts && git commit -m "feat(reports): create an invoice for one client's unpaid work"
```

---

## Task 5: The `/reports/invoice` document

**Files:**
- Create: `webapp/src/screens/Invoice.tsx`
- Create: `webapp/src/screens/Invoice.test.tsx`
- Modify: `webapp/src/App.tsx`

- [ ] **Step 1: Write the failing test**

Create `webapp/src/screens/Invoice.test.tsx`:

```tsx
/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { invoiceParams, unpricedNotice } from "./Invoice.tsx";

describe("invoiceParams", () => {
  it("reads the client, the number and the bounds", () => {
    expect(invoiceParams(new URLSearchParams("client=c1&n=7&from=100&to=200"))).toEqual({
      clientId: "c1",
      number: 7,
      filters: { from: 100, to: 200 },
    });
  });

  it("leaves bounds out when they are absent", () => {
    expect(invoiceParams(new URLSearchParams("client=c1&n=7"))).toEqual({
      clientId: "c1",
      number: 7,
      filters: {},
    });
  });

  it("names the gigs it could not price, so nobody under-bills in silence", () => {
    // Not a nicety: `buildInvoice` drops work whose price is unknown
    // rather than billing zero, and this banner is the only place that
    // fact surfaces before the document is sent.
    expect(
      unpricedNotice({ unpricedGigs: [{ id: "g1", description: "Tasting" }] }),
    ).toBe("1 completed gig has no price set, so it is not on this invoice:");
    expect(
      unpricedNotice({
        unpricedGigs: [
          { id: "g1", description: "Tasting" },
          { id: "g2", description: "Promo" },
        ],
      }),
    ).toBe("2 completed gigs have no price set, so they are not on this invoice:");
  });

  it("refuses a missing client rather than inventing one", () => {
    expect(invoiceParams(new URLSearchParams("n=7"))).toBeNull();
  });

  it("refuses a number that is not a positive integer", () => {
    // A hand-edited URL must not print "INV-NaN" on a document that
    // gets sent to somebody.
    expect(invoiceParams(new URLSearchParams("client=c1&n=x"))).toBeNull();
    expect(invoiceParams(new URLSearchParams("client=c1&n=0"))).toBeNull();
    expect(invoiceParams(new URLSearchParams("client=c1"))).toBeNull();
  });

  it("ignores an EMPTY bound rather than reading it as epoch 0", () => {
    // `Number("")` is 0, so a truthiness- or null-check here would set
    // a bound of 0 and empty the invoice without saying so.
    expect(invoiceParams(new URLSearchParams("client=c1&n=1&issued=1000&to="))).toEqual({
      clientId: "c1",
      number: 1,
      issuedAt: 1000,
      filters: {},
    });
  });

  it("ignores a bound that is not a number", () => {
    expect(invoiceParams(new URLSearchParams("client=c1&n=1&from=x"))).toEqual({
      clientId: "c1",
      number: 1,
      filters: {},
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter gigsy-webapp exec vitest run src/screens/Invoice.test.tsx`

Expected: FAIL — no such module.

- [ ] **Step 3: Write the screen**

Create `webapp/src/screens/Invoice.tsx`:

```tsx
/**
 * One invoice, as a document rather than a screen.
 *
 * Everything here exists to be printed. The PDF is the browser's, not
 * ours: `styles/print.css` hides the app's chrome and this component's
 * own Print button, so what comes out is the document and nothing else.
 * That choice is the spec's, and the reason is text — PDF core fonts
 * are Latin-1, and gig titles and client names come from forwarded
 * emails and photographs.
 *
 * It reads its inputs from the URL so it is refreshable, linkable, and
 * a legal destination for a help `navigate` step. It allocates nothing
 * and writes nothing: the number was spent by whoever opened it.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Link } from "react-router-dom";
import { useData } from "../lib/app-context.tsx";
import { buildInvoice, formatInvoiceNumber } from "../lib/invoice.ts";
import { formatMoney } from "../lib/format.ts";
import { isoDate } from "../lib/report-export.ts";
import type { ReportFilters } from "../lib/types.ts";
import { useSettings } from "./settings/useSettings.ts";
import { AppHeader, Button, Card } from "../components/index.ts";

export interface InvoiceParams {
  clientId: string;
  number: number;
  /** Fixed at allocation and carried in the link, so reopening it
   *  prints the same dates as the copy already sent. */
  issuedAt: number;
  filters: ReportFilters;
}

/** The URL is the input. Exported for its own test: a hand-edited or
 *  truncated link must produce a refusal, never a document with a
 *  nonsense number printed on it. */
export function invoiceParams(search: URLSearchParams): InvoiceParams | null {
  const clientId = search.get("client");
  if (clientId === null || clientId === "") return null;

  const n = Number(search.get("n"));
  if (!Number.isInteger(n) || n < 1) return null;

  // Same refusal as a bad number: a document that prints "Invalid Date"
  // is worse than a link that admits it is broken.
  const issuedAt = Number(search.get("issued"));
  if (!Number.isInteger(issuedAt) || issuedAt <= 0) return null;

  // Read the RAW string, not the coerced number: `Number("")` is 0, so
  // `?to=` would set a bound of epoch 0 and silently drop every dated
  // gig — a hand-edited link inventing an answer, which is the one
  // thing this function exists to refuse.
  const filters: ReportFilters = {};
  const rawFrom = search.get("from");
  if (rawFrom !== null && rawFrom !== "" && Number.isFinite(Number(rawFrom))) {
    filters.from = Number(rawFrom);
  }
  const rawTo = search.get("to");
  if (rawTo !== null && rawTo !== "" && Number.isFinite(Number(rawTo))) {
    filters.to = Number(rawTo);
  }

  return { clientId, number: n, issuedAt, filters };
}

/** The sentence above the list of gigs that could not be priced.
 *  Exported for its own test: it is the only place the user is told
 *  that work was deliberately left off a bill, so the wording is
 *  behaviour, not decoration. Takes just the field it needs so a test
 *  does not have to build a whole document. */
export function unpricedNotice(doc: Pick<InvoiceDocument, "unpricedGigs">): string {
  return doc.unpricedGigs.length === 1
    ? "1 completed gig has no price set, so it is not on this invoice:"
    : `${doc.unpricedGigs.length} completed gigs have no price set, so they are not on this invoice:`;
}

export function Invoice() {
  const [search] = useSearchParams();
  const api = useData();
  const { settings } = useSettings();
  const params = invoiceParams(search);

  const gigs = useQuery({ queryKey: ["gigs"], queryFn: () => api.listGigs() });
  const services = useQuery({ queryKey: ["services"], queryFn: () => api.listServices() });
  const expenses = useQuery({ queryKey: ["expenses"], queryFn: () => api.listExpenses() });
  const clients = useQuery({ queryKey: ["clients"], queryFn: () => api.listClients() });

  const doc = useMemo(() => {
    if (params === null || settings === undefined) return null;
    return buildInvoice({
      gigs: gigs.data ?? [],
      services: services.data ?? [],
      expenses: expenses.data ?? [],
      clientId: params.clientId,
      clientName: clients.data?.find((c) => c.id === params.clientId)?.name ?? "",
      filters: params.filters,
      business: {
        name: settings.businessName,
        address: settings.businessAddress,
        contact: settings.businessContact,
        taxId: settings.businessTaxId,
        paymentDetails: settings.businessPaymentDetails,
      },
      number: formatInvoiceNumber(params.number),
      // From the URL, never `Date.now()`: this screen is a pure
      // function of its link, and an invoice whose number is fixed but
      // whose date drifts on every reopen is incoherent.
      issuedAt: params.issuedAt,
      termsDays: settings.invoicePaymentTermsDays,
    });
  }, [params, settings, gigs.data, services.data, expenses.data, clients.data]);

  // Three states, not two. `isPending` is FALSE once a query has
  // errored, and every input to `buildInvoice` defaults gracefully
  // (`gigs.data ?? []`), so a failed read renders a complete, confident
  // invoice saying "Nothing to invoice" — with a Print button. That is
  // the same silent under-bill `unpricedGigs` exists to prevent,
  // arriving by a different door. Gigs.tsx's own tests call this shape
  // "three renders wearing one face".
  if (gigs.isError || services.isError || expenses.isError || clients.isError || loadError) {
    return (
      <>
        <AppHeader title="Invoice" />
        <Card>
          <p className="text-sm text-red-600" data-testid="invoice-load-error">
            Couldn't load this invoice. Check your connection and try again — no
            invoice number has been used up.
          </p>
        </Card>
      </>
    );
  }

  if (params === null) {
    return (
      <>
        <AppHeader title="Invoice" />
        <Card>
          <p data-testid="invoice-bad-link">
            This invoice link is incomplete. Start again from{" "}
            <Link to="/reports">Reports</Link>.
          </p>
        </Card>
      </>
    );
  }

  if (doc === null) return null;

  const empty = doc.lines.length === 0 && doc.expenses.length === 0;

  return (
    <>
      <AppHeader title="Invoice" />
      {/* The app's standard page column. AuthGate supplies only the
          background and the tab-bar padding, so without this the cards
          run edge to edge. Print is unaffected — print.css targets test
          ids and `header`, not `main`. */}
      <main className="mx-auto max-w-lg space-y-4 p-4">
      <article data-testid="invoice-document" className="space-y-4 print:space-y-3">
        <Card>
          <div className="flex items-start justify-between gap-4">
            <div>
              {doc.business.name === null ? (
                <p data-testid="invoice-no-business" className="text-sm text-amber-700">
                  No business details yet — add them in{" "}
                  <Link to="/settings">Settings</Link> and they will appear here.
                </p>
              ) : (
                <p className="font-semibold" data-testid="invoice-business-name">
                  {doc.business.name}
                </p>
              )}
              {doc.business.address !== null && (
                <p className="whitespace-pre-line text-sm">{doc.business.address}</p>
              )}
              {doc.business.contact !== null && (
                <p className="text-sm">{doc.business.contact}</p>
              )}
              {doc.business.taxId !== null && (
                <p className="text-sm">Tax no. {doc.business.taxId}</p>
              )}
            </div>
            <div className="text-right">
              <p className="font-semibold" data-testid="invoice-number">{doc.number}</p>
              <p className="text-sm">Issued {isoDate(doc.issuedAt)}</p>
              <p className="text-sm" data-testid="invoice-due">Due {isoDate(doc.dueAt)}</p>
            </div>
          </div>
          <p className="mt-3 text-sm" data-testid="invoice-client">
            Billed to {doc.client.name}
          </p>
        </Card>

        {doc.unpricedGigs.length > 0 && (
          <Card>
            {/* The one thing the document knows and the user cannot
                otherwise find out. `buildInvoice` drops work it cannot
                price rather than billing $0.00; without this the user
                prints, sends, and under-bills in silence. Deliberately
                on the document itself, not a toast on the previous
                screen — it has to be visible at the moment somebody is
                about to send this. */}
            <p className="text-sm text-amber-700" data-testid="invoice-unpriced">
              {unpricedNotice(doc)}
            </p>
            <ul className="mt-1 text-sm text-amber-700">
              {doc.unpricedGigs.map((g) => (
                <li key={g.id}>{g.description}</li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-slate-600">
              Set a rate or an amount on the gig and create the invoice again.
            </p>
          </Card>
        )}

        {empty ? (
          <Card>
            <p data-testid="invoice-empty-doc">
              Nothing to invoice — this client has no unpaid work in the period
              selected.
            </p>
          </Card>
        ) : (
          <Card>
            <table className="w-full text-sm" data-testid="invoice-lines">
              <tbody>
                {doc.lines.map((line, i) => (
                  <tr key={`w${i}`}>
                    <td>{isoDate(line.date)}</td>
                    <td>{line.description}</td>
                    <td className="text-right">{formatMoney(line.amountCents)}</td>
                  </tr>
                ))}
                {doc.expenses.map((line, i) => (
                  <tr key={`e${i}`} data-testid="invoice-expense-line">
                    <td>{isoDate(line.date)}</td>
                    <td>{line.description} (expense)</td>
                    <td className="text-right">{formatMoney(line.amountCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-right font-semibold" data-testid="invoice-total">
              Total {formatMoney(doc.totalCents)}
            </p>
          </Card>
        )}

        {doc.business.paymentDetails !== null && (
          <Card>
            <p className="whitespace-pre-line text-sm" data-testid="invoice-payment-details">
              {doc.business.paymentDetails}
            </p>
          </Card>
        )}
      </article>

      <Button block data-testid="invoice-print" onClick={() => window.print()}>
        Print or save as PDF
      </Button>
      </main>
    </>
  );
}
```

`listGigs`, `listServices`, `listExpenses` and `listClients` all exist on the data service - `Reports.tsx`'s export handlers call each of them. The query keys above (`gigs`, `services`, `expenses`, `clients`) are the ones the rest of the app already uses, so this screen shares their cache rather than opening a second one.

- [ ] **Step 4: Add the route**

In `webapp/src/App.tsx`, import `Invoice` beside the other screen imports and add the route immediately after the `/reports` one:

```tsx
            <Route path="/reports" element={<Reports />} />
            {/* A document, not a screen — see Invoice.tsx and
                styles/print.css. Its inputs are in the query string so
                it is refreshable and a legal `navigate` destination. */}
            <Route path="/reports/invoice" element={<Invoice />} />
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter gigsy-webapp exec vitest run src/screens/Invoice.test.tsx
pnpm --filter gigsy-webapp typecheck
```

Expected: PASS and exit 0.

- [ ] **Step 6: Commit**

```bash
git add webapp/src/screens/Invoice.tsx webapp/src/screens/Invoice.test.tsx webapp/src/App.tsx && git commit -m "feat(invoice): the printable document at /reports/invoice"
```

---

## Task 6: The print stylesheet

**Files:**
- Create: `webapp/src/styles/print.css`
- Modify: `webapp/src/styles.css`

- [ ] **Step 1: Write the stylesheet**

Create `webapp/src/styles/print.css`:

```css
/*
 * What the browser prints.
 *
 * The invoice PDF is the browser's own, so this file IS the export
 * format. Everything that is app rather than document has to go: the
 * header, the tab bar, the floating action button, and the Print button
 * that started the print.
 *
 * Scoped to @media print, so it costs nothing at runtime and cannot
 * affect the screen.
 */
@media print {
  /* App chrome. Each of these is a fixture of every screen; on paper
     they are furniture around a document nobody asked to print.
     `header` by element rather than by test id: AppHeader.tsx carries
     none, and adding one purely so a stylesheet can find it would be a
     test hook masquerading as markup. */
  header,
  [data-testid="tab-bar"],
  [data-testid="invoice-print"] {
    display: none !important;
  }

  /* The document should own the page: no app background, no rounded
     card edges, no shadow — all of which print as grey boxes. */
  body {
    background: #fff !important;
  }

  [data-testid="invoice-document"] [class*="rounded"],
  [data-testid="invoice-document"] [class*="shadow"] {
    border-radius: 0 !important;
    box-shadow: none !important;
  }

  /* A line item split across a page break is unreadable on the desk of
     whoever has to check it. */
  [data-testid="invoice-lines"] tr {
    break-inside: avoid;
  }

  @page {
    margin: 16mm;
  }
}
```

- [ ] **Step 2: Import it**

In `webapp/src/styles.css`, add after the existing token imports:

```css
@import "./styles/print.css";
```

- [ ] **Step 3: Verify the selectors exist**

The rules above are worthless if they name test ids that do not exist. Check each:

```bash
grep -rn 'data-testid="tab-bar"' webapp/src/components/
grep -n "<header" webapp/src/components/AppHeader.tsx
```

Both must match what `print.css` names. `tab-bar` is on `TabBar.tsx`;
the app header is a bare `<header>` with no test id, which is why the
rule targets the element. If either has changed, fix `print.css` — do
not add a test id to a component purely so a stylesheet can find it.

- [ ] **Step 4: Confirm the build still passes**

```bash
pnpm --filter gigsy-webapp build
```

Expected: succeeds. A malformed `@import` fails here, not in the unit tests.

- [ ] **Step 5: Commit**

```bash
git add webapp/src/styles/print.css webapp/src/styles.css && git commit -m "feat(invoice): print only the document, not the app around it"
```

---

## Task 7: The help topic

**Files:**
- Modify: `webapp/src/help/targets.ts`
- Create: `webapp/src/help/scenarios/create-invoice.ts`
- Modify: `webapp/src/help/registry.ts`

- [ ] **Step 1: Add the targets**

In `webapp/src/help/targets.ts`, add a section after the existing report targets (or at the end of `HelpTarget` if there are none):

```ts
  // ── invoicing (Reports.tsx, Invoice.tsx) ──
  // `invoice-needs-client` is the hint that replaces the button while
  // the client filter is on "All clients". A branch reads IT rather
  // than the button's disabled state, because a help condition must
  // read something PRESENT — an absence is also true while a screen is
  // loading, which is what `no-gigs-yet` was fixed for.
  InvoiceNeedsClient: element("invoice-needs-client"),
  InvoiceCreate: element("invoice-create"),
  InvoiceDocument: element("invoice-document"),
  // Deliberately NO target for `invoice-total`: it renders only when
  // the document is non-empty, and a client whose only completed work
  // is unpriced opens a document where it never exists. A step
  // pointing at it would end that user's tour with the unavailable
  // banner, and CI could not catch it — CI never takes that branch.
  // What the total means is said in the document step instead.
  InvoicePrint: element("invoice-print"),
```

- [ ] **Step 2: Write the scenario**

Create `webapp/src/help/scenarios/create-invoice.ts`:

```ts
import { HelpTarget } from "../targets.ts";
import type { HelpScenario } from "../types.ts";

/**
 * Billing one client for the work they have not paid for.
 *
 * The tour cannot pick the client — that is the one decision only the
 * user can make, and the same shape `record-work` has with the gig
 * list. So it explains the two filters, then branches on whether a
 * client has actually been chosen, and only walks the document on the
 * branch where one has.
 *
 * The branch reads `invoice-needs-client`, a hint that is RENDERED when
 * no client is selected, rather than the Create invoice button's
 * disabled state. A help condition must read something present: an
 * absence is also true while a screen is loading, which is the bug
 * `no-gigs-yet` was fixed for.
 *
 * Every step is a `highlight` except the hop. Nothing here writes —
 * the report filters are component state, and the invoice number is
 * only spent when the user presses Create invoice themselves.
 *
 * ── A gap this scenario ships with ──
 *
 * CI always takes `invoice-needs-client`. `help-runner.ts` performs
 * highlight steps without choosing anything, and a `select` step cannot
 * name a client id statically — they are per-account UUIDs. So the
 * navigate step, `invoice-document`, `invoice-total` and
 * `invoice-print` are PROSE in CI: rename one of those test ids and the
 * suite stays green. That is docs/help/README.md §6's category, and it
 * is recorded there too. `expectedCiBranches` is pinned so that the day
 * CI starts taking the other branch, the assertion fails and someone
 * looks at why.
 */
export const createInvoice: HelpScenario = {
  id: "create-invoice",
  title: "Invoice a client",
  description:
    "Turn one client's unpaid work into a numbered invoice you can save as a PDF and send.",
  category: "money",
  startRoute: "/reports",
  // Empirical: the runner never selects a client, so the hint is always
  // the branch that holds. See the gap described above.
  expectedCiBranches: ["invoice-needs-client"],
  steps: [
    {
      action: "highlight",
      target: HelpTarget.ReportRange,
      title: "Pick the period",
      description:
        "An invoice covers the work in whatever range is set here — a month, a quarter, or a custom span. Only unpaid work inside it ends up on the bill, so this is what decides which shifts you are asking to be paid for.",
    },
    {
      action: "highlight",
      target: HelpTarget.ReportClient,
      title: "Choose who you are billing",
      description:
        "An invoice is addressed to one client, so \"All clients\" will not do. Pick the agency you are billing and the Invoice section below turns into a button.",
    },
    {
      action: "branch",
      branches: [
        {
          id: "invoice-needs-client",
          when: { type: "target-visible", target: HelpTarget.InvoiceNeedsClient },
          steps: [
            {
              action: "highlight",
              target: HelpTarget.InvoiceNeedsClient,
              title: "Pick a client first",
              description:
                "No client is selected yet, so there is nobody to address an invoice to. Choose one in the Client box above — then start this walkthrough again and it will carry on to the document itself.",
              end: true,
            },
          ],
        },
        {
          id: "invoice-ready",
          when: { type: "target-visible", target: HelpTarget.InvoiceCreate },
          steps: [
            {
              action: "navigate",
              target: HelpTarget.InvoiceCreate,
              route: "/reports/invoice",
              title: "Create the invoice",
              description:
                "This takes the next number in your sequence and opens the finished document. If the client truly has nothing to bill in the period, it says so here instead of opening anything, and the number is left unspent.",
            },
            {
              action: "highlight",
              target: HelpTarget.InvoiceDocument,
              title: "What the client will see",
              description:
                "Your business details at the top, the client's beneath, then a line for every unpaid gig — each billed for what is still owed on it, not the whole fee — with any extra services under their gig and reimbursable expenses after the work. The total at the bottom is exactly what this client still owes for the period, so a part-paid gig contributes only its remainder and you never ask twice for money you have already had. Anything blank up there comes from Settings, under Business details.",
            },
            {
              action: "highlight",
              target: HelpTarget.InvoicePrint,
              title: "Save it as a PDF",
              description:
                "This opens your browser's own print dialog; choose \"Save as PDF\" as the destination and you have a file to send. Printing uses the browser's fonts, so any alphabet comes out right — and the app's header, tabs and this button are all left off the page.",
            },
          ],
        },
      ],
    },
  ],
};
```

`HelpTarget.ReportRange` and `HelpTarget.ReportClient` do not exist — checked. Add them in Step 1 alongside the invoice targets:

```ts
  // ── the report filters (Reports.tsx) ──
  ReportRange: element("report-range"),
  ReportClient: element("report-client"),
```

- [ ] **Step 3: Register it**

In `webapp/src/help/registry.ts`, import `createInvoice` and add it to `helpScenarios` immediately after `findAPayment`, so the money section reads client → expense → payment → invoice.

- [ ] **Step 4: Validate**

Run: `pnpm --filter gigsy-webapp help:validate`

Expected: PASS. This runs the real `validateHelpRegistry` over the real registry, so a terminal step in the wrong place, a bad navigate route, or an `expectedCiBranches` naming a branch that does not exist all fail here.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter gigsy-webapp typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add webapp/src/help/targets.ts webapp/src/help/scenarios/create-invoice.ts webapp/src/help/registry.ts && git commit -m "docs(help): a topic for invoicing a client"
```

---

## Task 8: The end-to-end proof

**Files:**
- Create: `webapp/e2e/invoice.spec.ts`

- [ ] **Step 1: Write the spec**

Create `webapp/e2e/invoice.spec.ts`:

```ts
/**
 * The invoice, end to end — and the one thing about it that cannot be
 * tested at all.
 *
 * No browser automation can drive a native print dialog, so this never
 * asserts that a PDF appeared. What it CAN assert is the two halves
 * that decide whether the PDF is right: the document says what it
 * should, and the print rules are actually in force. The second is
 * read as a computed style rather than inferred from a class name —
 * the same move reachability.spec.ts makes to prove help.css reached
 * the page.
 */
import { expect, test } from "@playwright/test";
import { requireTestAuth, resetGigListView } from "./helpers/test-auth.ts";

test.beforeEach(async ({ page, request, baseURL }) => {
  await requireTestAuth(request, baseURL!);
  await resetGigListView(request, baseURL!);
  await page.goto("/login");
  await page.getByTestId("test-signin").click();
  await expect(page.getByTestId("tab-bar")).toBeVisible();
});

test("an invoice needs a client before it can be created", async ({ page }) => {
  await page.goto("/reports");
  // "All clients" is the default, so the hint is what shows.
  await expect(page.getByTestId("invoice-needs-client")).toBeVisible();
  await expect(page.getByTestId("invoice-create")).toHaveCount(0);
});

test("a bad invoice link refuses rather than printing a nonsense number", async ({
  page,
}) => {
  await page.goto("/reports/invoice?client=c1");
  await expect(page.getByTestId("invoice-bad-link")).toBeVisible();
  await expect(page.getByTestId("invoice-number")).toHaveCount(0);
});

test("the print stylesheet actually hides the app chrome", async ({ page }) => {
  // A complete link: `issued` is required now that the issue date
  // travels in the URL, so a link without it renders the bad-link
  // card instead of a document.
  await page.goto(`/reports/invoice?client=whoever&n=1&issued=${Date.now()}`);
  // Emulating print is the only way to observe @media print rules; the
  // dialog itself is out of reach.
  await page.emulateMedia({ media: "print" });
  const tabBar = page.getByTestId("tab-bar");
  await expect
    .poll(async () => tabBar.evaluate((el) => getComputedStyle(el).display))
    .toBe("none");
  await page.emulateMedia({ media: "screen" });
  await expect
    .poll(async () => tabBar.evaluate((el) => getComputedStyle(el).display))
    .not.toBe("none");
});
```

- [ ] **Step 2: Run it against a local stack**

Bring the stack up as `docs/help/README.md` §5 describes, then:

```bash
E2E_BASE_URL=http://127.0.0.1:5193 E2E_REQUIRE_AUTH=1 pnpm --filter gigsy-webapp test:e2e -g invoice
```

Expected: 3 passed. If the third test fails because the tab bar is still displayed, the test id in `print.css` does not match the real one — fix `print.css`, not the test.

- [ ] **Step 3: Commit**

```bash
git add webapp/e2e/invoice.spec.ts && git commit -m "test(invoice): the document, the refusal, and the print rules"
```

---

## Task 9: Documentation

**Files:**
- Modify: `docs/help/README.md`

- [ ] **Step 1: Record the gap in §6**

`docs/help/README.md` §6 lists what a green suite does not tell you. Add this as a further item, after the existing ones:

```markdown
**A branch CI can never take.** `create-invoice` needs a client
selected, and the runner cannot select one — a `select` step names an
option by value, and client ids are per-account UUIDs. So CI always
takes `invoice-needs-client`, and everything on the other branch — the
navigate step onto `/reports/invoice`, `invoice-document`,
`invoice-total`, `invoice-print` — is prose. Rename one of those test
ids and the suite stays green. Walking that branch by hand is the only
thing that checks it.
```

- [ ] **Step 2: Confirm nothing else went stale**

```bash
grep -rn "report-exports\|Export" docs/help/README.md | head
```

If §2's guidance or any example mentions the Reports screen's sections, make sure it still describes what is there now that Invoice sits above Export.

- [ ] **Step 3: Commit**

```bash
git add docs/help/README.md && git commit -m "docs(help): record the branch CI cannot take on create-invoice"
```

---

## Task 10: Verify

**Files:** none — this is the gate.

No completeness claim before this task's output has been read.

- [ ] **Step 1: Unit suites and typechecks**

```bash
pnpm --filter gigsy-backend test
pnpm --filter gigsy-webapp typecheck
pnpm --filter gigsy-webapp test
```

Expected: all green. Record the counts.

- [ ] **Step 2: Bring up the local stack**

```bash
cd backend && cp .dev.vars.example .dev.vars && pnpm exec wrangler d1 migrations apply gigsy-db --local && pnpm exec wrangler dev --port 8787
```

```bash
cd webapp && pnpm dev --port 5192 --host 127.0.0.1
```

Note which port vite actually binds — it moves silently when one is taken, and every command below needs the real one.

- [ ] **Step 3: The Playwright suites**

```bash
E2E_BASE_URL=http://127.0.0.1:5192 E2E_REQUIRE_AUTH=1 pnpm --filter gigsy-webapp help:test
E2E_BASE_URL=http://127.0.0.1:5192 E2E_REQUIRE_AUTH=1 pnpm --filter gigsy-webapp test:e2e
```

Expected: help green with `create-invoice` taking `["invoice-needs-client"]`; e2e green including the three new invoice tests.

Run `help:test` twice. A scenario that passes on the first run of a session and fails on the second means a precondition is not pinned.

- [ ] **Step 4: Walk it by hand — the part no suite covers**

In the running app:

1. Settings → Business details. Fill in a name, an address and payment details. Confirm they survive a reload.
2. Reports → choose a client with unpaid work → Create invoice.
3. Check the document: the number matches what Settings said was next, the due date is issue + terms, each line bills what is owed rather than the whole fee, and reimbursable expenses appear after the work.
4. Press Print and confirm the preview shows the document alone — no header, no tab bar, no Print button.
5. Go back to Settings and confirm the counter advanced by exactly one.
6. Create an invoice for a client with nothing unpaid: it must say so and leave the counter alone.
7. Start Help → "Invoice a client" with a client selected, and confirm the tour follows onto the document — the branch CI never takes.

- [ ] **Step 5: Report**

State what was run and what it said. If any step was skipped, say which and why.

---

## Notes for whoever executes this

- `pnpm --filter gigsy-webapp typecheck` runs `tsc -b`. A bare `tsc --noEmit` in that package always exits 0 and proves nothing.
- `help:validate` is `vitest run src/help` — the whole help unit suite, around twenty seconds, not just the validator.
- `help:test` refuses to run anywhere but localhost: these scenarios write settings.
- The backend version bump in Task 1 is not optional; `Version bump check` fails a PR touching `backend/**` without one.
- Nothing is committed, merged or pushed without the user saying so.
