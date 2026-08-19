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
 * If one half is cleared and the other is already reading as zero,
 * there is no way to tell "0h 0m, entered on purpose" from "clearing
 * the field, one half at a time" — collapsing both to "not set" is the
 * safer of the two failures. The alternative (a stray "0" left behind
 * from before the field was touched, surviving as a real duration) is
 * the more surprising one to ship.
 */
function join(hours: string, minutes: string): string {
  if (isZeroish(hours) && isZeroish(minutes)) return "";
  const total = (Number(hours) || 0) * 60 + (Number(minutes) || 0);
  return String(total);
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
