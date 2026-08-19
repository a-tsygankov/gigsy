# Phase 1 — Minute-precision time + shadcn foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every time control in the app accepts any minute of the hour, and shadcn/ui is wired into the existing design-token layer so later phases can build on it.

**Architecture:** The quarter-hour `<select>` in `DateTimeField` exists only because a native picker could not be *constrained* to quarter hours. Dropping that rule lets the control go back to a native `<input type="time">`, which offers every minute on iOS and keyboard entry on desktop, and lets `QUARTER_HOUR_OPTIONS` / `timeOptionsFor` be deleted outright. Duration follows the same logic: a fixed list of eight shift lengths becomes an hours + minutes pair. shadcn is added by defining its CSS variables **in terms of** the existing `--c-*` triplets, so `docs/design-system.md` stays canonical and no existing screen changes appearance.

**Tech Stack:** React 18, TypeScript, Tailwind 3.4, Vitest, Playwright, shadcn/ui (radix + cva + tailwind-merge), Motion.

Spec: `docs/superpowers/specs/2026-08-18-hourly-rate-worklog-design.md`

> **Component tests in this repo do not use `@testing-library/react`.** It is
> not a dependency and must not be added. `SettingRow.test.tsx`,
> `SyncBadge.test.tsx` and `HelpProvider.test.tsx` all use `react-dom`'s
> `createRoot` + `act` with `container.querySelector`, an
> `IS_REACT_ACT_ENVIRONMENT` shim, and a `setValue` helper that writes
> through the native prototype setter and dispatches an `input` event —
> React tracks controlled inputs on `input`, not `change`. Test snippets
> below are written in testing-library style for readability; translate
> each assertion 1:1 into that idiom.

> **Tasks 1 and 2 form one commit boundary.** Task 1 deletes
> `timeOptionsFor` while `DateTimeField.tsx` still imports it, so the tree
> does not compile between them. Run them back to back and do not leave
> the branch at Task 1.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `webapp/src/lib/datetime.ts` | ms ↔ local-input string conversion | Delete `QUARTER_HOUR_OPTIONS`, `timeOptionsFor` |
| `webapp/src/lib/datetime.test.ts` | Pins the conversions | Drop the quarter-hour describes |
| `webapp/src/components/DateTimeField.tsx` | Date + time entry | `<select>` → `<input type="time">` |
| `webapp/src/components/DurationField.tsx` | **New.** Hours + minutes entry | Create |
| `webapp/src/components/DurationField.test.tsx` | **New.** Pins the conversion | Create |
| `webapp/src/components/index.ts` | Barrel | Export `DurationField` |
| `webapp/src/screens/GigEdit.tsx` | Gig form | `DURATIONS` select → `DurationField` |
| `webapp/src/help/targets.ts` | Help target ids | Split `GigDuration` into two |
| `webapp/src/help/scenarios/create-gig.ts` | Walkthrough copy | Re-word the quarter-hour claims |
| `webapp/src/styles/tokens/shadcn.css` | **New.** shadcn vars ← `--c-*` | Create |
| `webapp/src/lib/utils.ts` | **New.** `cn()` for shadcn | Create |
| `webapp/tailwind.config.ts` | Tailwind theme | Add shadcn colour names, `tailwindcss-animate` |
| `webapp/src/lib/design-tokens.test.ts` | Token adherence | Add bridge assertions |
| `webapp/e2e/*.spec.ts` | E2E | `selectOption` → `fill` for time and duration |

---

## Task 1: Delete the quarter-hour grid

**Files:**
- Modify: `webapp/src/lib/datetime.ts:36-81`
- Test: `webapp/src/lib/datetime.test.ts:32-86`

- [ ] **Step 1: Rewrite the test file's quarter-hour section as the new contract**

Replace the two `describe` blocks covering `QUARTER_HOUR_OPTIONS` and `timeOptionsFor` (everything from line 32 to the end) with:

```ts
describe("time strings", () => {
  it("keeps any minute, not just the quarters", () => {
    expect(splitLocalInput("2026-09-12T14:18")).toEqual({
      date: "2026-09-12",
      time: "14:18",
    });
    expect(joinLocalInput("2026-09-12", "14:18")).toBe("2026-09-12T14:18");
  });

  it("drops seconds a browser may append", () => {
    expect(splitLocalInput("2026-09-12T14:18:30").time).toBe("14:18");
  });

  it("has no value without a date — a time alone is not a moment", () => {
    expect(joinLocalInput("", "14:18")).toBe("");
  });
});
```

Also remove `QUARTER_HOUR_OPTIONS` and `timeOptionsFor` from the import at the top of the file.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter gigsy-webapp exec vitest run src/lib/datetime.test.ts
```

Expected: FAIL — TypeScript/Vitest reports the removed imports are still exported but unused, or the file passes while `datetime.ts` still exports dead code. Confirm the failure is only about the removed symbols before continuing.

- [ ] **Step 3: Delete the dead exports**

In `webapp/src/lib/datetime.ts`, delete `QUARTER_HOUR_OPTIONS` (and its long comment block) and `timeOptionsFor` entirely. Keep `msToLocalInput`, `localInputToMs`, `splitLocalInput`, `joinLocalInput`. Update the file's header comment to:

```ts
/**
 * Conversions between epoch ms (storage/API) and the local-time
 * string the date + time inputs speak (YYYY-MM-DDTHH:mm).
 *
 * There is no minute grid. There used to be one — gigs snapped to the
 * quarter hour — and the whole reason `DateTimeField` split into two
 * controls was that no native picker could be held to it. Times are now
 * whatever the user (or an extracted email) says, so the split survives
 * only because a date input and a time input are genuinely better on a
 * phone than one `datetime-local`.
 */
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter gigsy-webapp exec vitest run src/lib/datetime.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add webapp/src/lib/datetime.ts webapp/src/lib/datetime.test.ts
git commit -m "refactor(time): drop the quarter-hour grid"
```

---

## Task 2: DateTimeField uses a native time input

**Files:**
- Modify: `webapp/src/components/DateTimeField.tsx`
- Test: `webapp/src/components/DateTimeField.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

Create `webapp/src/components/DateTimeField.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DateTimeField } from "./DateTimeField.tsx";

describe("DateTimeField", () => {
  it("renders a time input, not a select", () => {
    render(<DateTimeField testId="f" value="2026-09-12T14:18" onChange={() => {}} />);
    const time = screen.getByTestId("f-time");
    expect(time.tagName).toBe("INPUT");
    expect(time).toHaveAttribute("type", "time");
    expect(time).toHaveValue("14:18");
  });

  it("emits the joined value when the time changes to an off-quarter minute", () => {
    const onChange = vi.fn();
    render(<DateTimeField testId="f" value="2026-09-12T09:00" onChange={onChange} />);
    fireEvent.change(screen.getByTestId("f-time"), { target: { value: "14:07" } });
    expect(onChange).toHaveBeenCalledWith("2026-09-12T14:07");
  });

  it("clears the whole value when the date is cleared", () => {
    const onChange = vi.fn();
    render(<DateTimeField testId="f" value="2026-09-12T14:18" onChange={onChange} />);
    fireEvent.change(screen.getByTestId("f-date"), { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("fills 09:00 when a date is picked before a time", () => {
    const onChange = vi.fn();
    render(<DateTimeField testId="f" value="" onChange={onChange} />);
    fireEvent.change(screen.getByTestId("f-date"), { target: { value: "2026-09-12" } });
    expect(onChange).toHaveBeenCalledWith("2026-09-12T09:00");
  });
});
```

If `@testing-library/react` and `@testing-library/jest-dom` are not yet dependencies, add them first:

```bash
pnpm --filter gigsy-webapp add -D @testing-library/react @testing-library/jest-dom @testing-library/dom
```

and confirm `webapp/vitest.config.ts` has `environment: "jsdom"` and a setup file importing `@testing-library/jest-dom/vitest`. `SettingRow.test.tsx` and `SyncBadge.test.tsx` already render components — follow whatever they do.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter gigsy-webapp exec vitest run src/components/DateTimeField.test.tsx
```

Expected: FAIL — "expected SELECT to be INPUT".

- [ ] **Step 3: Replace the select with a time input**

`webapp/src/components/DateTimeField.tsx` becomes:

```tsx
/**
 * A date and a time, as two native controls.
 *
 * Not one `<input type="datetime-local">`: on a phone that is a single
 * combined wheel, and the date half of it is worse than the calendar a
 * bare date input gives. Two controls also let the date stand alone —
 * picking a day before you know the hour is the common case.
 *
 * The time half used to be a `<select>` of quarter hours, because that
 * was the only way to stop a picker offering 14:18. Gigs are no longer
 * on a grid, so the native control is simply correct: every minute,
 * a wheel on iOS, keyboard entry on desktop.
 */
import { Input } from "./index.ts";
import { joinLocalInput, splitLocalInput } from "../lib/datetime.ts";

/** Where a date lands when a time has not been chosen yet.
 *
 *  Something has to fill it: a date with no time cannot be stored, and
 *  silently dropping the date someone just picked because they had not
 *  reached the time yet is the worse failure. Nine is the start of a
 *  working day, and the input shows it — a visible guess, not a hidden
 *  one. */
const DEFAULT_TIME = "09:00";

export interface DateTimeFieldProps {
  /** "YYYY-MM-DDTHH:mm", or "" for unset. */
  value: string;
  onChange: (value: string) => void;
  /** Suffixed with "-date" and "-time" for the two controls. */
  testId?: string;
}

export function DateTimeField({ value, onChange, testId }: DateTimeFieldProps) {
  const { date, time } = splitLocalInput(value);

  return (
    <div className="flex gap-2">
      <Input
        type="date"
        className="min-w-0 flex-1"
        data-testid={testId === undefined ? undefined : `${testId}-date`}
        value={date}
        onChange={(e) => {
          const next = e.target.value;
          // Clearing the date clears the whole value — the time alone
          // is not a moment.
          onChange(next === "" ? "" : joinLocalInput(next, time || DEFAULT_TIME));
        }}
      />
      <Input
        type="time"
        className="w-32 shrink-0"
        data-testid={testId === undefined ? undefined : `${testId}-time`}
        // Nothing to attach a time to yet. Disabled rather than hidden,
        // so the control does not appear once you touch the date and
        // make the row jump.
        disabled={date === ""}
        value={time}
        onChange={(e) => onChange(joinLocalInput(date, e.target.value))}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter gigsy-webapp exec vitest run src/components/DateTimeField.test.tsx
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add webapp/src/components/DateTimeField.tsx webapp/src/components/DateTimeField.test.tsx webapp/package.json
git commit -m "feat(time): DateTimeField accepts any minute"
```

---

## Task 3: DurationField

**Files:**
- Create: `webapp/src/components/DurationField.tsx`
- Create: `webapp/src/components/DurationField.test.tsx`
- Modify: `webapp/src/components/index.ts`

- [ ] **Step 1: Write the failing test**

Create `webapp/src/components/DurationField.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DurationField } from "./DurationField.tsx";

describe("DurationField", () => {
  it("splits stored minutes into hours and minutes", () => {
    render(<DurationField testId="d" value="200" onChange={() => {}} />);
    expect(screen.getByTestId("d-hours")).toHaveValue(3);
    expect(screen.getByTestId("d-minutes")).toHaveValue(20);
  });

  it("shows both halves empty when unset", () => {
    render(<DurationField testId="d" value="" onChange={() => {}} />);
    expect(screen.getByTestId("d-hours")).toHaveValue(null);
    expect(screen.getByTestId("d-minutes")).toHaveValue(null);
  });

  it("emits total minutes when the hours change", () => {
    const onChange = vi.fn();
    render(<DurationField testId="d" value="20" onChange={onChange} />);
    fireEvent.change(screen.getByTestId("d-hours"), { target: { value: "3" } });
    expect(onChange).toHaveBeenCalledWith("200");
  });

  it("emits empty when both halves are cleared", () => {
    const onChange = vi.fn();
    render(<DurationField testId="d" value="60" onChange={onChange} />);
    fireEvent.change(screen.getByTestId("d-hours"), { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("treats a lone minutes entry as a duration", () => {
    const onChange = vi.fn();
    render(<DurationField testId="d" value="" onChange={onChange} />);
    fireEvent.change(screen.getByTestId("d-minutes"), { target: { value: "45" } });
    expect(onChange).toHaveBeenCalledWith("45");
  });

  it("shows nothing for a stored value that is not a number", () => {
    render(<DurationField testId="d" value="oops" onChange={() => {}} />);
    expect(screen.getByTestId("d-hours")).toHaveValue(null);
    expect(screen.getByTestId("d-minutes")).toHaveValue(null);
  });

  it("clamps a negative half to zero — the API rejects a negative duration", () => {
    const onChange = vi.fn();
    render(<DurationField testId="d" value="45" onChange={onChange} />);
    fireEvent.change(screen.getByTestId("d-hours"), { target: { value: "-5" } });
    expect(onChange).toHaveBeenCalledWith("45");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter gigsy-webapp exec vitest run src/components/DurationField.test.tsx
```

Expected: FAIL — cannot resolve `./DurationField.tsx`.

- [ ] **Step 3: Write the component**

Create `webapp/src/components/DurationField.tsx`:

```tsx
/**
 * A length of time, as hours and minutes.
 *
 * Replaces a `<select>` of eight fixed shift lengths. That list was
 * fine while gigs were quoted in whole hours; it cannot express the
 * 3h20m an hourly gig actually ran, and the value it holds now feeds
 * the pay calculation rather than just the calendar.
 *
 * The value is a string of total minutes because that is what the
 * form state holds either side of it ("" for unset), which keeps the
 * conversion in one place instead of at every call site.
 *
 * Say only what is true today: duration currently reaches
 * domain/gig-time.ts and nothing else. Phase 2 is what makes it feed
 * pay, and that comment belongs to Phase 2.
 */
import { Input } from "./index.ts";

export interface DurationFieldProps {
  /** Total minutes as a string, or "" for unset. */
  value: string;
  onChange: (value: string) => void;
  /** Suffixed with "-hours" and "-minutes". */
  testId?: string;
}

function partsOf(value: string): { hours: string; minutes: string } {
  if (value === "") return { hours: "", minutes: "" };
  const total = Number(value);
  if (!Number.isFinite(total)) return { hours: "", minutes: "" };
  return {
    hours: String(Math.floor(total / 60)),
    minutes: String(total % 60),
  };
}

/** Zero-ish, not empty: `partsOf` fills the other half with "0", so
 *  clearing one of them never leaves both literally empty. There is no
 *  zero-length duration to protect — domain/schemas.ts validates
 *  durationMinutes as positive and expresses "unknown" as null — so
 *  collapsing to "" is the only outcome the API would accept. */
const isZeroish = (v: string) => v === "" || Number(v) === 0;

/** `min`/`max` on the inputs drive the desktop spinner and the mobile
 *  keyboard and constrain nothing (this repo learned that from `step` on
 *  datetime-local); the clamp here is the actual guard. Minutes ≥ 60 are
 *  deliberately NOT rolled over — 75 renders back as 1h15m through
 *  partsOf, and normalising mid-keystroke is worse. */
function join(hours: string, minutes: string): string {
  if (isZeroish(hours) && isZeroish(minutes)) return "";
  const half = (v: string) => Math.max(0, Number(v) || 0);
  return String(half(hours) * 60 + half(minutes));
}

export function DurationField({ value, onChange, testId }: DurationFieldProps) {
  const { hours, minutes } = partsOf(value);
  const id = (suffix: string) =>
    testId === undefined ? undefined : `${testId}-${suffix}`;

  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        inputMode="numeric"
        min={0}
        max={24}
        className="w-20"
        placeholder="0"
        data-testid={id("hours")}
        value={hours}
        onChange={(e) => onChange(join(e.target.value, minutes))}
      />
      <span className="text-sm text-slate-500">h</span>
      <Input
        type="number"
        inputMode="numeric"
        min={0}
        max={59}
        className="w-20"
        placeholder="00"
        data-testid={id("minutes")}
        value={minutes}
        onChange={(e) => onChange(join(hours, e.target.value))}
      />
      <span className="text-sm text-slate-500">m</span>
    </div>
  );
}
```

- [ ] **Step 4: Export it from the barrel**

In `webapp/src/components/index.ts`, beside the `DateTimeField` export:

```ts
export { DurationField } from "./DurationField.tsx";
```

Add `DurationField` to the component list in the file's header comment.

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm --filter gigsy-webapp exec vitest run src/components/DurationField.test.tsx
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add webapp/src/components/DurationField.tsx webapp/src/components/DurationField.test.tsx webapp/src/components/index.ts
git commit -m "feat(time): DurationField for arbitrary shift lengths"
```

---

## Task 4: GigEdit uses DurationField

**Files:**
- Modify: `webapp/src/screens/GigEdit.tsx:22-29` (the `DURATIONS` array and `formatDuration`), `:254-257` (a stale comment), `:264-283` (the Duration field)
- Modify: `webapp/src/screens/DraftReview.tsx:223-232` (a stale comment)
- Modify: `webapp/src/help/targets.ts:71`
- Modify: `webapp/src/help/scenarios/create-gig.ts:79-95`
- Modify: `webapp/e2e/signed-in.spec.ts:148,190`, `webapp/e2e/availability.spec.ts:103-104`, `webapp/e2e/gig-list.spec.ts:271`

- [ ] **Step 1: Replace the duration select**

In `webapp/src/screens/GigEdit.tsx`, delete the `DURATIONS` constant (lines 22-24 including its comment). Keep `formatDuration` — the "Ends" hint still uses it. Replace the Duration `<Field>` body with:

```tsx
<Field label="Duration">
  <DurationField
    testId="gig-duration"
    value={form.durationMinutes}
    onChange={(v) => set("durationMinutes", v)}
  />
  {endsAt !== null && (
    <span className="mt-1 block text-xs text-slate-500">
      {formatDuration(Number(form.durationMinutes))} · ends {endsAt}
    </span>
  )}
</Field>
```

Add `DurationField` to the import from `../components/index.ts` and drop the now-unused `Select` import only if nothing else on the screen uses it (the Client and Status fields do — keep it).

Two comments elsewhere were made stale by Tasks 1–3 and must be corrected here, since this is the task that owns these files:

- `webapp/src/screens/GigEdit.tsx:254-257` still says *"its picker cannot be held to quarter hours on any platform… DateTimeField offers a time `<select>` that contains nothing else."* Both halves are now false. Reword to say why the field is still two controls rather than one `datetime-local`: the date half of a combined picker is worse on a phone than a bare date input, and a date is often picked before the hour is known.
- `webapp/src/screens/DraftReview.tsx:223-232` claims *"DateTimeField keeps an off-grid value as an option rather than correcting it."* The property still holds — an extracted 14:18 is never silently corrected — but the machinery it credits (`timeOptionsFor`) is deleted. Reword so it attributes the guarantee to the time input accepting any minute.

- [ ] **Step 2: Update the help targets**

In `webapp/src/help/targets.ts`, replace the `GigDuration` entry with:

```ts
  GigDurationHours: element("gig-duration-hours"),
```

One entry, not two: nothing points a scenario at the minutes box, and a registry entry with no consumer reads like coverage that does not exist. Add the second the day a step needs it.

In `webapp/src/help/scenarios/create-gig.ts`, point the duration step at `HelpTarget.GigDurationHours`, and re-word the time and duration copy so it no longer claims a quarter-hour grid. Replace the `GigTime` step's description with:

```
"Any minute of the hour — 14:07 if that is when you start. The time is what the calendar event and your public availability page are built from, so it is worth getting right."
```

and the duration step's description with:

```
"How long the job runs, in hours and minutes. It is what stops the calendar guessing four hours, and what your public availability page subtracts from your free time."
```

Help copy is user-facing, so it must describe what ships in *this* phase. Duration does not reach any pay calculation until Phase 2 — saying otherwise here would also contradict the Offered $ step immediately below it, which correctly attributes "Expected" to that field.

- [ ] **Step 3: Update the e2e specs**

Time controls change from select to input:

```ts
// webapp/e2e/availability.spec.ts:103
await page.getByTestId("gig-datetime-time").fill(localTime);
// webapp/e2e/gig-list.spec.ts:271
await time.fill("14:15");
// webapp/e2e/signed-in.spec.ts:249
await page.getByTestId("gig-datetime-time").fill("10:45");
```

Duration changes from one select to two inputs:

```ts
// webapp/e2e/availability.spec.ts:104 — was selectOption("120")
await page.getByTestId("gig-duration-hours").fill("2");
// webapp/e2e/signed-in.spec.ts:148 — was selectOption("180")
await page.getByTestId("gig-duration-hours").fill("3");
// webapp/e2e/signed-in.spec.ts:190 — was selectOption("300")
await page.getByTestId("gig-duration-hours").fill("5");
```

- [ ] **Step 4: Run the unit suites and the help validation**

```bash
pnpm --filter gigsy-webapp test
```

Expected: PASS. `src/help/validate.test.ts` and `src/help/targets.test.ts` are the ones that catch a target rename you missed.

- [ ] **Step 5: Run the e2e suite**

```bash
pnpm --filter gigsy-webapp test:e2e
```

Expected: PASS. If the app is not running, follow whatever `webapp/playwright.config.ts` sets as `webServer`.

- [ ] **Step 6: Commit**

```bash
git add webapp/src/screens/GigEdit.tsx webapp/src/help webapp/e2e
git commit -m "feat(gigs): enter duration as hours and minutes"
```

---

## Task 5: shadcn foundation and the token bridge

**Files:**
- Create: `webapp/src/lib/utils.ts`
- Create: `webapp/src/styles/tokens/shadcn.css`
- Create: `webapp/components.json`
- Modify: `webapp/tailwind.config.ts`
- Modify: `webapp/src/styles.css`, `webapp/tsconfig.app.json`, `webapp/vite.config.ts`
- Test: `webapp/src/lib/design-tokens.test.ts`

- [ ] **Step 1: Install the dependencies**

```bash
pnpm --filter gigsy-webapp add class-variance-authority clsx tailwind-merge motion
```

```bash
pnpm --filter gigsy-webapp add -D tailwindcss-animate
```

Radix packages are added per component by the shadcn CLI later; do not add them speculatively.

- [ ] **Step 2: Write the failing bridge test**

Append to `webapp/src/lib/design-tokens.test.ts`:

```ts
describe("shadcn token bridge", () => {
  const bridge = readFileSync(tokensDir + "shadcn.css", "utf8");

  /** Every shadcn variable a component may reference. If a component is
   *  added that needs one not listed here, add it to BOTH this list and
   *  shadcn.css — an undefined var renders as transparent, silently. */
  const REQUIRED = [
    "--background", "--foreground",
    "--card", "--card-foreground",
    "--popover", "--popover-foreground",
    "--primary", "--primary-foreground",
    "--secondary", "--secondary-foreground",
    "--muted", "--muted-foreground",
    "--accent", "--accent-foreground",
    "--destructive", "--destructive-foreground",
    "--border", "--input", "--ring",
  ];

  it("defines every variable the components use", () => {
    for (const name of REQUIRED) {
      expect(bridge).toContain(`${name}:`);
    }
  });

  it("defines them from the --c-* palette, never from raw colour values", () => {
    for (const [, name, value] of bridge.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      if (name === undefined || value === undefined) continue;
      if (name.startsWith("--c-")) continue;
      expect(value).toMatch(/var\(--c-[\w-]+\)/);
    }
  });

  it("re-themes with the rest of the palette rather than separately", () => {
    // No theme block of its own: the --c-* vars it points at are the
    // ones colors.css already swaps, so the bridge must not duplicate
    // that switch and get a chance to disagree with it.
    //
    // Comments are stripped first, and the assertion counts :root rules
    // rather than grepping for a selector string — a raw substring check
    // fails on a comment that merely mentions the selector, and still
    // misses [data-theme='dark'] spelled with single quotes.
    const codeOnly = bridge.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(codeOnly.match(/:root/g)).toHaveLength(1);
  });

  it("is imported after semantic.css, which also defines some of these names", () => {
    const styles = readFileSync(srcDir + "styles.css", "utf8");
    expect(styles.indexOf("tokens/shadcn.css")).toBeGreaterThan(
      styles.indexOf("tokens/semantic.css"),
    );
  });
});
```

`--accent` is the reason for that last test. `semantic.css` already defines it — as a finished `rgb(...)` colour, not a triplet — so two files claim the name and only import order decides the winner. The bridge therefore names its own `--shadcn-accent` / `--shadcn-accent-foreground` and points Tailwind's `accent` key at those, which removes the clash rather than sequencing around it; component code only ever sees the `bg-accent` class, so the rename is invisible to it. The ordering test stays as a backstop for the *next* collision, which will not be this one.

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm --filter gigsy-webapp exec vitest run src/lib/design-tokens.test.ts
```

Expected: FAIL — `ENOENT: no such file … shadcn.css`.

- [ ] **Step 4: Write the bridge**

Create `webapp/src/styles/tokens/shadcn.css`:

```css
/**
 * shadcn/ui's variable names, defined from Gigsy's palette.
 *
 * shadcn components reference --background, --primary and so on. Rather
 * than adopting a second palette that would have to be kept in step
 * with docs/design-system.md, each name is an alias for a --c-* triplet
 * that colors.css already defines and already swaps under
 * [data-theme="dark"]. So there is exactly one place where a colour is
 * chosen, and one place where the theme switches.
 *
 * The values are "R G B" channel triplets, not colours, because that is
 * what Tailwind's <alpha-value> substitution needs — the same reason
 * colors.css is written that way.
 */
:root {
  --background: var(--c-white);
  --foreground: var(--c-slate-900);

  --card: var(--c-white);
  --card-foreground: var(--c-slate-900);

  --popover: var(--c-white);
  --popover-foreground: var(--c-slate-900);

  --primary: var(--c-emerald-600);
  --primary-foreground: var(--c-on-accent);

  --secondary: var(--c-slate-100);
  --secondary-foreground: var(--c-slate-900);

  --muted: var(--c-slate-100);
  --muted-foreground: var(--c-slate-500);

  --accent: var(--c-emerald-50);
  --accent-foreground: var(--c-emerald-700);

  --destructive: var(--c-red-600);
  --destructive-foreground: var(--c-white);

  --border: var(--c-slate-200);
  --input: var(--c-slate-300);
  --ring: var(--c-emerald-500);
}
```

Check the exact token names against `webapp/src/styles/tokens/colors.css` before writing — `--c-on-accent` is the accent-foreground token referenced in `tailwind.config.ts`; if a name here does not exist there, use the one that does rather than adding a new token.

Import it from `webapp/src/styles.css` alongside the other token files, **after** `colors.css`.

- [ ] **Step 5: Teach Tailwind the names**

In `webapp/tailwind.config.ts`, inside `theme.extend.colors`, add:

```ts
        background: withAlpha2("background"),
        foreground: withAlpha2("foreground"),
        card: { DEFAULT: withAlpha2("card"), foreground: withAlpha2("card-foreground") },
        popover: { DEFAULT: withAlpha2("popover"), foreground: withAlpha2("popover-foreground") },
        primary: { DEFAULT: withAlpha2("primary"), foreground: withAlpha2("primary-foreground") },
        secondary: { DEFAULT: withAlpha2("secondary"), foreground: withAlpha2("secondary-foreground") },
        muted: { DEFAULT: withAlpha2("muted"), foreground: withAlpha2("muted-foreground") },
        accent: { DEFAULT: withAlpha2("accent"), foreground: withAlpha2("accent-foreground") },
        destructive: { DEFAULT: withAlpha2("destructive"), foreground: withAlpha2("destructive-foreground") },
        border: withAlpha2("border"),
        input: withAlpha2("input"),
        ring: withAlpha2("ring"),
```

with a second helper beside the existing `withAlpha`, since these variables are not `--c-` prefixed:

```ts
/** Same trick as `withAlpha`, for the shadcn aliases in
 *  styles/tokens/shadcn.css — those names carry no --c- prefix because
 *  shadcn's own components reference them verbatim. */
const withAlpha2 = (token: string) => `rgb(var(--${token}) / <alpha-value>)`;
```

Add `plugins: [require("tailwindcss-animate")]` (or the ESM equivalent this config uses) and confirm `darkMode` stays as it is.

- [ ] **Step 6: Add the `@/` alias and components.json**

`webapp/tsconfig.app.json` — add to `compilerOptions`:

```json
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
```

`webapp/vite.config.ts` — add to the config:

```ts
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
```

Mirror the same alias in `webapp/vitest.config.ts` if it does not extend the Vite config.

Create `webapp/src/lib/utils.ts`:

```ts
/** shadcn's class merger. Tailwind resolves competing utilities by
 *  stylesheet order, not attribute order (see components/Input.tsx for
 *  what that cost us), and this is what makes a caller's class actually
 *  win. */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

Create `webapp/components.json`:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "tailwind.config.ts",
    "css": "src/styles.css",
    "baseColor": "slate",
    "cssVariables": true
  },
  "aliases": { "components": "@/components", "utils": "@/lib/utils" }
}
```

- [ ] **Step 7: Add one component and prove the bridge renders**

```bash
cd webapp && pnpm dlx shadcn@latest add card
```

The CLI reads the root `tsconfig.json`, which here holds project references and no `paths`, so it writes into a literal `webapp/@/` directory. Move the file to `src/components/ui/` and delete the stray directory.

Then **change the Card's bare `border` class to `border-border`.** Stock shadcn resolves a bare `border` through a global `@layer base { * { @apply border-border } }`; that rule is deliberately not added here because it would restyle every border in the app. Without it, `border` falls back to Tailwind's stock `gray-200` — a hardcoded hex that never repaints in dark theme. Every component added from here on needs the same correction, so say so in one line at the top of the file.

Then verify in the browser: start the dev server via the preview tooling, open any screen, and confirm nothing changed appearance. Toggle the theme and confirm the token swap still works.

- [ ] **Step 7b: Prove the `@/` alias actually resolves**

`ui/card.tsx` is the only file importing through the alias, and it is neither rendered by a test nor reachable from the entry graph — so a typo in `vite.config.ts` or `vitest.config.ts` passes every gate command silently. Add `webapp/src/lib/utils.test.ts` importing `cn` **through the alias**, asserting the merge behaviour that justifies `tailwind-merge`: a later competing utility wins over an earlier one. Vite's own alias stays unexercised until Phase 3 imports a shadcn component into a real screen.

- [ ] **Step 8: Run everything**

```bash
pnpm --filter gigsy-webapp test && pnpm --filter gigsy-webapp typecheck && pnpm --filter gigsy-webapp build
```

Expected: PASS on all three.

- [ ] **Step 9: Commit**

```bash
git add webapp/components.json webapp/src/lib/utils.ts webapp/src/styles webapp/tailwind.config.ts webapp/tsconfig.app.json webapp/vite.config.ts webapp/vitest.config.ts webapp/package.json webapp/src/components/ui webapp/src/lib/design-tokens.test.ts
git commit -m "feat(ui): shadcn foundation on the existing token layer"
```

---

## Task 6: Document it

**Files:**
- Modify: `docs/design-system.md`

- [ ] **Step 1: Add a section**

Under the token documentation, add:

```markdown
### shadcn/ui

shadcn components reference their own variable names (`--background`,
`--primary`, …). `src/styles/tokens/shadcn.css` defines every one of
them as an alias for a `--c-*` triplet, so the palette here stays the
only place a colour is chosen and the dark-theme block in `colors.css`
stays the only place the theme switches. Adding a component that needs a
variable not yet aliased means adding it to `shadcn.css` **and** to the
`REQUIRED` list in `src/lib/design-tokens.test.ts` — an undefined
variable renders as transparent with no error.

Three things to know before adding a component:

- **Rewrite a bare `border` as `border-border`.** Stock shadcn relies on
  a global `@layer base { * { @apply border-border } }`, which is not
  present here because it would restyle every border in the app. Left
  alone, `border` resolves to Tailwind's stock grey and never repaints in
  dark theme. The same applies to any other bare utility a component
  assumes the global layer will redirect.
- **The CLI writes to the wrong place.** `pnpm dlx shadcn@latest add …`
  reads the root `tsconfig.json`, which carries no `paths`, so it creates
  a literal `@/` directory. Move the file into `src/components/ui/`.
- **`Card` now names two different things.** `src/components/Card.tsx` is
  the app's own card, barrel-exported and used on every screen;
  `src/components/ui/card.tsx` is shadcn's, imported through `@/`. They
  are one autocomplete slip apart. Reach for the app's own component
  unless you are building on a screen that has deliberately moved to
  shadcn.

Adoption is incremental: shadcn is used on the gig detail screens
(Phase 3 onward). The core components in `src/components/` are
unchanged and remain the vocabulary everywhere else.
```

- [ ] **Step 2: Commit**

```bash
git add docs/design-system.md
git commit -m "docs: record the shadcn token bridge"
```

---

## Verification

- [ ] `pnpm --filter gigsy-webapp test` passes
- [ ] `pnpm --filter gigsy-webapp typecheck` passes
- [ ] `pnpm --filter gigsy-webapp test:e2e` passes
- [ ] `pnpm --filter gigsy-webapp help:validate` passes
- [ ] Manually: a gig can be saved at 14:07 with a duration of 3h20m, and both survive a reload
- [ ] Manually: light and dark still swap on every screen
