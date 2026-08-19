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
