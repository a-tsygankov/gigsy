/**
 * A moment — one field, one control.
 *
 * The app used to answer this question twice: a date input beside a time
 * input here, and a bare `<input type="datetime-local">` on the payment
 * form. Native controls are why: `datetime-local` renders as a different
 * thing in every browser (a combined wheel on iOS, three spin fields on
 * desktop Chrome, a text box on Firefox), and a bare `date` input's
 * calendar is the platform's, not the app's. So neither answer could be
 * made to look like the other, and the panel each one dropped down was
 * the browser's, past the reach of `data-theme`.
 *
 * A shadcn calendar in a popover plus a time input is one control that
 * looks the same everywhere and repaints with the theme, which is what
 * lets all five sites share it. The cost is that a day and an hour are
 * now behind a tap instead of in front of you; the row that replaces
 * them states the moment in full, so nothing is hidden except the
 * editing.
 *
 * There is no minute grid — see lib/datetime.ts. The time input carries
 * no `step`, so every minute is enterable; 14:07 is a real gig start.
 */
import { useRef, useState } from "react";
import { Button, Input } from "./index.ts";
import { Calendar } from "@/components/ui/calendar.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { inputShellClasses } from "./Input.tsx";
import {
  dateToLocalDate,
  formatLocalMoment,
  joinLocalInput,
  localDateToDate,
  localInputToMs,
  splitLocalInput,
} from "../lib/datetime.ts";

/** Where a date lands when a time has not been chosen yet.
 *
 *  Something has to fill it: a date with no time cannot be stored, and
 *  silently dropping the date someone just picked because they had not
 *  reached the time yet is the worse failure. Nine is the start of a
 *  working day, and the time input beside the calendar shows it — a
 *  visible guess, not a hidden one. */
const DEFAULT_TIME = "09:00";

/** How far the month/year dropdowns reach either side of the year in
 *  play. Gigs are booked weeks out and worked the same week; five years
 *  is already far past anything this app is for, and a longer list is a
 *  longer scroll on a phone. */
const YEAR_REACH = 5;

export interface DateTimeFieldProps {
  /** "YYYY-MM-DDTHH:mm", or "" for unset. */
  value: string;
  onChange: (value: string) => void;
  /** The trigger's own id. The controls inside the popover suffix it:
   *  "-time", "-calendar", "-clear", "-done". */
  testId?: string;
  /** What the field is called, for the trigger's accessible name.
   *
   *  `Field` wraps its children in a `<label>`, which names an `<input>`
   *  but NOT a `<button>` — HTML-AAM computes a button's name from its
   *  own contents. Without this a screen reader announces the trigger as
   *  "Sat, Sep 12, 9:00 AM, button" with no clue whether that is the gig
   *  or the shift it replaced. */
  label?: string;
}

export function DateTimeField({ value, onChange, testId, label }: DateTimeFieldProps) {
  const [open, setOpen] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const { date, time } = splitLocalInput(value);
  const selected = localDateToDate(date);
  const ms = localInputToMs(value);

  const sub = (suffix: string): string | undefined =>
    testId === undefined ? undefined : `${testId}-${suffix}`;

  // Wide enough to reach the year in play even when it is an old record
  // being corrected, not just the years around today.
  const thisYear = new Date().getFullYear();
  const pivot = selected?.getFullYear() ?? thisYear;
  const startMonth = new Date(Math.min(thisYear, pivot) - YEAR_REACH, 0);
  const endMonth = new Date(Math.max(thisYear, pivot) + YEAR_REACH, 11);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={testId}
          // The canonical value beside the human one. What the trigger
          // READS is localised — "Sat, Sep 12" in one locale, "sam. 12
          // sept." in another — so it is not something a test can assert
          // a stored moment against.
          data-value={value}
          aria-label={label}
          className={`${inputShellClasses} flex items-center justify-between gap-2 text-left`}
        >
          <span className={ms === null ? "text-slate-400" : undefined}>
            {ms === null ? "No date yet" : formatLocalMoment(ms)}
          </span>
          <span aria-hidden="true" className="text-slate-400">
            ⌄
          </span>
        </button>
      </PopoverTrigger>

      <PopoverContent
        ref={content}
        align="start"
        className="w-auto p-0"
        aria-label={label}
        // Radix focuses the first focusable child, which is the previous
        // month arrow — so a keyboard user opens a date picker and lands
        // on navigation, several tabs from any day. Land on the day
        // instead: the one already chosen, or today.
        onOpenAutoFocus={(event) => {
          const day =
            content.current?.querySelector<HTMLButtonElement>(
              "td[data-selected='true'] button",
            ) ??
            content.current?.querySelector<HTMLButtonElement>(
              "td[data-today='true'] button",
            );
          if (day === undefined || day === null) return;
          event.preventDefault();
          day.focus();
        }}
      >
        <div data-testid={sub("calendar")}>
          <Calendar
            mode="single"
            // `required` so tapping the chosen day again cannot silently
            // empty the field. Clearing is a deliberate act — the button
            // below says so.
            required
            captionLayout="dropdown"
            startMonth={startMonth}
            endMonth={endMonth}
            selected={selected ?? undefined}
            // Spread, not `defaultMonth={selected ?? undefined}`:
            // `exactOptionalPropertyTypes` rejects an explicit undefined
            // for an optional prop. Omitting it is also the honest
            // version — an empty field has no day to open on, so the
            // calendar opens on this month.
            {...(selected === null ? {} : { defaultMonth: selected })}
            onSelect={(day) => {
              onChange(joinLocalInput(dateToLocalDate(day), time || DEFAULT_TIME));
            }}
          />
        </div>

        {/* The time box takes the space that is left rather than a fixed
            width: a native time input renders its own hour/minute/AM-PM
            fields plus a clock button, and at 112px Chrome on a phone
            clipped the hour clean off. */}
        <div className="flex items-center gap-2 border-t border-border p-3">
          <Input
            type="time"
            className="min-w-0 flex-1"
            data-testid={sub("time")}
            aria-label="Time"
            // Nothing to attach a time to yet. Disabled rather than
            // hidden, so picking a day does not make the row jump.
            disabled={date === ""}
            value={time}
            onChange={(e) => onChange(joinLocalInput(date, e.target.value))}
          />
          <Button
            variant="ghost"
            size="sm"
            // sm keeps the row narrow enough for the time box; min-h-9
            // keeps the tap target honest on the phone this is built for.
            className="min-h-9 shrink-0"
            data-testid={sub("clear")}
            // Clears the whole value, never just the time: an hour with
            // no day is not a moment.
            onClick={() => onChange("")}
          >
            Clear
          </Button>
          <Button
            size="sm"
            className="min-h-9 shrink-0"
            data-testid={sub("done")}
            onClick={() => setOpen(false)}
          >
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
