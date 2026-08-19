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
import { Suspense, lazy, useRef, useState } from "react";
import { Button, Input } from "./index.ts";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { inputShellClasses } from "./Input.tsx";
import {
  formatLocalMoment,
  joinLocalInput,
  localDateToDate,
  localInputToMs,
  splitLocalInput,
} from "../lib/datetime.ts";

/** The calendar is fetched on demand — see DateTimeCalendar.tsx for why.
 *  Named so the trigger can warm it before the popover needs it; the
 *  module registry makes the second call free. */
const importCalendar = () => import("./DateTimeCalendar.tsx");
const DateTimeCalendar = lazy(importCalendar);

/** The calendar's own footprint, reserved before it arrives.
 *
 *  Seven 40px day cells plus 12px of padding either side is 304px wide;
 *  a six-week month is 362px tall — 24 padding + 40 caption + 16 gap +
 *  18 weekday row + six 44px weeks (40 plus a 4px margin), all measured
 *  against the built app rather than reasoned about. Held as a MINIMUM,
 *  so two things stay still: the panel does not resize when the real
 *  calendar replaces the placeholder, and it does not resize when you
 *  page from a five-week month into a six-week one. */
const CALENDAR_BOX = "min-h-[362px] min-w-[304px]";

/** Shown only on a cold first open, and sized by CALENDAR_BOX above, so
 *  it holds the panel's shape rather than collapsing it. The pulse is
 *  the same one ListSkeleton uses, so a placeholder looks like a
 *  placeholder wherever it appears. */
function CalendarPlaceholder() {
  return (
    <div className="p-3" aria-hidden data-testid="datetime-calendar-loading">
      <div className="h-[338px] animate-pulse rounded-md bg-slate-200/70" />
    </div>
  );
}

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

  const spoken = ms === null ? "No date yet" : formatLocalMoment(ms);

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
          // An explicit name, because every implicit route to one here
          // is wrong. `Field` wraps its children in a `<label>`, and a
          // wrapping label beats an element's own contents in the
          // accessible-name algorithm — so the button announced
          // "Date & time" and the moment was simply absent, which is
          // worse than the two native inputs this replaced. Naming it
          // with the label ALONE (an `aria-label={label}`) has the same
          // fault. Verified against Chromium's own computation, not
          // reasoned about: the name reads
          // "Date & time, Sat, Sep 12, 2:07 PM".
          aria-label={label === undefined ? spoken : `${label}, ${spoken}`}
          // Start fetching the calendar as the finger goes down or the
          // field takes focus, so the module is nearly always there by
          // the time the panel opens and the placeholder below is never
          // seen. Both, because a keyboard never sends a pointer event.
          onPointerDown={() => void importCalendar()}
          onFocus={() => void importCalendar()}
          className={`${inputShellClasses} flex items-center justify-between gap-2 text-left`}
        >
          <span className={ms === null ? "text-slate-400" : undefined}>{spoken}</span>
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
        tabIndex={-1}
        // Radix focuses the first focusable child, which is the previous
        // month arrow — so a keyboard user opens a date picker and lands
        // on navigation, several tabs from any day. Land on the day
        // instead: the one already chosen, or today.
        //
        // On a cold first open there is no day yet — the calendar module
        // is still in flight — so focus parks on the panel and
        // DateTimeCalendar's mount effect finishes the job.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const day =
            content.current?.querySelector<HTMLButtonElement>(
              "td[data-selected='true'] button",
            ) ??
            content.current?.querySelector<HTMLButtonElement>(
              "td[data-today='true'] button",
            );
          (day ?? content.current)?.focus();
        }}
      >
        <div className={CALENDAR_BOX}>
          <Suspense fallback={<CalendarPlaceholder />}>
            <DateTimeCalendar
              testId={sub("calendar")}
              selected={selected}
              startMonth={startMonth}
              endMonth={endMonth}
              shouldTakeFocus={() => document.activeElement === content.current}
              onSelectDay={(day) => {
                onChange(joinLocalInput(day, time || DEFAULT_TIME));
              }}
            />
          </Suspense>
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
            // An emptied time box falls back to the default rather than
            // emitting "2026-09-14T", which is not a moment: it reads
            // back as null, so the trigger would say "No date yet" while
            // the calendar still showed the day highlighted, and saving
            // would lose the day silently. Same rule as picking a day
            // before a time — a date that cannot be stored without one
            // gets a visible guess, never a dropped day.
            onChange={(e) => onChange(joinLocalInput(date, e.target.value || DEFAULT_TIME))}
          />
          <Button
            variant="ghost"
            size="sm"
            // `sm` for its padding, which keeps the row narrow enough
            // for the time box beside it — but 44px tall, the tap
            // minimum docs/design-system.md sets, since height costs
            // this row nothing.
            className="min-h-11 shrink-0"
            data-testid={sub("clear")}
            // Clears the whole value, never just the time: an hour with
            // no day is not a moment.
            onClick={() => onChange("")}
          >
            Clear
          </Button>
          <Button
            size="sm"
            className="min-h-11 shrink-0"
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
