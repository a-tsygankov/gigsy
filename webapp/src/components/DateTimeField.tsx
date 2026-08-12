/**
 * A date, and a time that can only be a quarter hour.
 *
 * Replaces `<input type="datetime-local" step={900}>`, which could not
 * be made to hold the rule. `step` sets the desktop picker's arrow
 * increments and marks an off-grid value invalid, but the value is
 * still whatever was entered; iOS ignores it and offers a wheel of all
 * sixty minutes. Snapping the result afterwards was worse in practice —
 * the wheel still offered 14:18 and picking it silently produced 14:15,
 * which reads as the app losing your input rather than enforcing a
 * rule.
 *
 * A control can only offer what it contains. The date stays native
 * (the calendar is genuinely good on a phone); the time is a <select>,
 * so on iOS it is a wheel with four minute values and on desktop an
 * ordinary dropdown. Neither can express 14:18.
 *
 * Except when the record already does — see `timeOptionsFor`. A time
 * extracted from an email is a record of what the client said, and this
 * field shows it rather than quietly correcting it.
 */
import { Input, Select } from "./index.ts";
import {
  joinLocalInput,
  splitLocalInput,
  timeOptionsFor,
} from "../lib/datetime.ts";

/** Where a date lands when a time has not been chosen yet.
 *
 *  Something has to fill it: a date with no time cannot be stored, and
 *  silently dropping the date someone just picked because they had not
 *  reached the time yet is the worse failure. Nine is the start of a
 *  working day, and the select shows it — a visible guess, not a
 *  hidden one. */
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
      <Select
        className="w-28 shrink-0"
        data-testid={testId === undefined ? undefined : `${testId}-time`}
        // Nothing to attach a time to yet. Disabled rather than hidden,
        // so the control does not appear once you touch the date and
        // make the row jump.
        disabled={date === ""}
        value={time}
        onChange={(e) => onChange(joinLocalInput(date, e.target.value))}
      >
        {/* Only reachable before a date is picked, and it keeps the
            select from displaying the first option as though it were a
            choice someone made. */}
        {time === "" && <option value="">--:--</option>}
        {timeOptionsFor(time).map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </Select>
    </div>
  );
}
