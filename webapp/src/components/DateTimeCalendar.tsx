/**
 * The calendar inside `DateTimeField`, in a module of its own so it can
 * arrive on first open instead of on first paint.
 *
 * That is the entire reason this file is separate from DateTimeField:
 * react-day-picker plus the date-fns it depends on are ~290 kB of the
 * main chunk, and only three screens can open a picker at all — so
 * every other screen was paying to ship a calendar it cannot show.
 * Nothing may import this statically, or it lands back in the main
 * chunk and the split silently stops working.
 *
 * The default export is what `React.lazy` wants.
 */
import { useEffect, useRef } from "react";
import { Calendar } from "@/components/ui/calendar.tsx";
import { dateToLocalDate } from "../lib/datetime.ts";

export interface DateTimeCalendarProps {
  /** The chosen day, or null when the field is empty. */
  selected: Date | null;
  /** How far the month and year dropdowns reach. */
  startMonth: Date;
  endMonth: Date;
  /** Hands back "YYYY-MM-DD" — the caller owns the time half. */
  onSelectDay: (date: string) => void;
  /** Whether this panel should still claim focus now that it has
   *  arrived. See the effect below. */
  shouldTakeFocus: () => boolean;
  /** Explicitly `| undefined`: DateTimeField's own testId is optional and
   *  passed straight through, and `exactOptionalPropertyTypes` treats a
   *  missing prop and an undefined one as different things. */
  testId?: string | undefined;
}

export default function DateTimeCalendar({
  selected,
  startMonth,
  endMonth,
  onSelectDay,
  shouldTakeFocus,
  testId,
}: DateTimeCalendarProps) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // The cold-open focus path. DateTimeField moves focus onto a day
    // when the popover opens, but on the very first open this module is
    // still loading and there is no day to move it to — so it parks
    // focus on the panel instead and this takes over on arrival.
    // `shouldTakeFocus` is what stops that being a focus steal: if the
    // user has already tabbed to the time box while the chunk was in
    // flight, it returns false and focus is left where they put it.
    if (!shouldTakeFocus()) return;
    const day =
      root.current?.querySelector<HTMLButtonElement>("td[data-selected='true'] button") ??
      root.current?.querySelector<HTMLButtonElement>("td[data-today='true'] button");
    day?.focus();
    // Mount only: this is about the panel arriving, not about the day
    // changing afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={root} data-testid={testId}>
      <Calendar
        mode="single"
        // `required` so tapping the chosen day again cannot silently
        // empty the field. Clearing is a deliberate act — the Clear
        // button says so.
        required
        captionLayout="dropdown"
        startMonth={startMonth}
        endMonth={endMonth}
        selected={selected ?? undefined}
        // Spread, not `defaultMonth={selected ?? undefined}`:
        // `exactOptionalPropertyTypes` rejects an explicit undefined for
        // an optional prop. Omitting it is also the honest version — an
        // empty field has no day to open on, so the calendar opens on
        // this month.
        {...(selected === null ? {} : { defaultMonth: selected })}
        onSelect={(day) => onSelectDay(dateToLocalDate(day))}
      />
    </div>
  );
}
