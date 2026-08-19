/**
 * A length of time, as hours and minutes.
 *
 * Replaces a `<select>` of eight fixed shift lengths. That list was
 * fine while gigs were quoted in whole hours; it cannot express the
 * 3h20m an hourly gig actually ran.
 *
 * The value is a string of total minutes because that is what the
 * form state holds either side of it ("" for unset), which keeps the
 * conversion in one place instead of at every call site.
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

/**
 * "" and "0" read the same to whoever is looking at the field, so they
 * have to read the same here too — there is no hidden flag recording
 * whether a "0" came from the user typing it or from `partsOf` filling
 * in the other half of a round number of hours.
 */
function isZeroish(part: string): boolean {
  return part === "" || part === "0";
}

/**
 * Collapsing a zeroish pair to "" is not a UX preference — the write
 * schema (backend/src/domain/schemas.ts) makes durationMinutes
 * `.positive()` when present and treats "unknown" as null: "a
 * zero-length gig is a data-entry mistake, and 'unknown' is null."
 * There is no valid zero-length duration on the other side of this
 * form to lose, so "" is the only outcome the API would accept anyway.
 */
function join(hours: string, minutes: string): string {
  if (isZeroish(hours) && isZeroish(minutes)) return "";
  return String(clampToWholeNonNegative(hours) * 60 + clampToWholeNonNegative(minutes));
}

/**
 * `min`/`max` on the inputs below are affordances for the desktop
 * spinner and the mobile numeric keyboard only — nothing about
 * `type="number"` stops a typed "-5" or "1.5" reaching this handler.
 * This clamp corrects exactly those two cases: a negative half floors
 * to 0, and a fractional half floors to a whole number, because the
 * write schema (backend/src/domain/schemas.ts) requires
 * `durationMinutes` to be a positive integer and rejects either one
 * with a 400.
 *
 * It does *not* enforce that schema's 24-hour ceiling — `max={24}` on
 * the hours input above is display-only, and a value like 25 still
 * reaches the API unchanged, where the ceiling is that schema's job to
 * enforce, not this field's.
 *
 * Only clamps below zero and to whole numbers — 75 minutes is left as
 * 75, not rolled into 1h15m, because normalising mid-typing would
 * rewrite digits out from under whoever is still typing them. `partsOf`
 * does that rollover once the value is stored, which is the point it
 * stops moving.
 */
function clampToWholeNonNegative(part: string): number {
  return Math.max(0, Math.floor(Number(part) || 0));
}

export function DurationField({ value, onChange, testId }: DurationFieldProps) {
  const { hours, minutes } = partsOf(value);
  const id = (suffix: string) => (testId === undefined ? undefined : `${testId}-${suffix}`);

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
