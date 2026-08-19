/**
 * shadcn/ui Calendar (react-day-picker), adapted on three points.
 *
 * - **No lucide-react.** The registry's calendar imports three chevron
 *   icons. Gigsy ships no icon set and docs/design-system.md §Iconography
 *   says to ask before adding one, so the month arrows are the Unicode
 *   characters that stand in for icons everywhere else in the app.
 * - **Tailwind v3 syntax.** The registry file is written for Tailwind v4
 *   (`shadow-xs`, `has-focus:`, `**:` variants, bare `h-[--cell-size]`);
 *   this app is on 3.4, where those emit no CSS at all and fail silently.
 *   Custom properties are therefore spelled `h-[var(--cell-size)]`.
 * - **Single-selection styling only.** The registry carries range_start /
 *   range_middle / range_end classes. Nothing in this app selects a range
 *   through this component — the two date-range filters are plain date
 *   inputs — so those classes would be untested styling for a mode that
 *   is never mounted.
 *
 * Convention for every shadcn component in this folder: write
 * `border-border` explicitly, never a bare `border` — this app has no
 * global `* { @apply border-border }` rule, so a bare `border` falls back
 * to Tailwind's stock gray-200 and never repaints in dark theme.
 */
import * as React from "react";
import { DayButton, DayPicker, getDefaultClassNames } from "react-day-picker";

import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { dateToLocalDate } from "@/lib/datetime.ts";

function Calendar({
  className,
  classNames,
  components,
  showOutsideDays = true,
  captionLayout = "label",
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  const defaults = getDefaultClassNames();

  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      captionLayout={captionLayout}
      // 2.5rem, not the registry's 2rem: seven 40px cells plus the 24px
      // of padding is 304px, which still clears a 375px phone, and 32px
      // is below any sensible thumb target.
      className={cn("bg-background p-3 [--cell-size:2.5rem]", className)}
      classNames={{
        root: cn("w-fit", defaults.root),
        months: cn("relative flex flex-col gap-4", defaults.months),
        month: cn("flex w-full flex-col gap-4", defaults.month),
        nav: cn(
          "absolute inset-x-0 top-0 flex w-full items-center justify-between gap-1",
          defaults.nav,
        ),
        button_previous: cn(
          buttonVariants({ variant: "ghost" }),
          "h-[var(--cell-size)] w-[var(--cell-size)] select-none p-0 text-base",
          "aria-disabled:opacity-50",
          defaults.button_previous,
        ),
        button_next: cn(
          buttonVariants({ variant: "ghost" }),
          "h-[var(--cell-size)] w-[var(--cell-size)] select-none p-0 text-base",
          "aria-disabled:opacity-50",
          defaults.button_next,
        ),
        month_caption: cn(
          "flex h-[var(--cell-size)] w-full items-center justify-center px-[var(--cell-size)]",
          defaults.month_caption,
        ),
        dropdowns: cn(
          "flex h-[var(--cell-size)] w-full items-center justify-center gap-1.5 text-sm font-medium",
          defaults.dropdowns,
        ),
        dropdown_root: cn(
          "relative rounded-md border border-border",
          "focus-within:border-ring focus-within:ring-2 focus-within:ring-ring",
          defaults.dropdown_root,
        ),
        // The real <select>, laid transparently over the label below it —
        // the native picker is what opens on a phone, and it is what a
        // keyboard and a test driver both reach.
        dropdown: cn("absolute inset-0 bg-popover opacity-0", defaults.dropdown),
        caption_label: cn(
          "select-none font-medium",
          captionLayout === "label" ? "text-sm" : "flex items-center gap-1 px-2 py-1 text-sm",
          defaults.caption_label,
        ),
        month_grid: cn("w-full border-collapse", defaults.month_grid),
        weekdays: cn("flex", defaults.weekdays),
        weekday: cn(
          "flex-1 select-none rounded-md text-xs font-normal text-muted-foreground",
          defaults.weekday,
        ),
        week: cn("mt-1 flex w-full", defaults.week),
        day: cn(
          "group/day relative aspect-square h-full w-full select-none p-0 text-center",
          defaults.day,
        ),
        today: cn("rounded-md bg-accent text-accent-foreground", defaults.today),
        outside: cn("text-muted-foreground", defaults.outside),
        disabled: cn("text-muted-foreground opacity-50", defaults.disabled),
        hidden: cn("invisible", defaults.hidden),
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) => (
          <span aria-hidden="true">
            {orientation === "left" ? "‹" : orientation === "right" ? "›" : "⌄"}
          </span>
        ),
        // `data-nav`, for the same reason `data-day-iso` exists below:
        // react-day-picker's own handle on these is an English
        // aria-label ("Go to the Next Month") that moves with the
        // locale, and its class names are not public API either.
        PreviousMonthButton: (buttonProps) => (
          <button type="button" data-nav="previous" {...buttonProps} />
        ),
        NextMonthButton: (buttonProps) => (
          <button type="button" data-nav="next" {...buttonProps} />
        ),
        DayButton: CalendarDayButton,
        ...components,
      }}
      {...props}
    />
  );
}

/**
 * The button inside a day cell.
 *
 * `data-day-iso` is how the tests pick a day, and it is deliberately our
 * own attribute under our own name.
 *
 * The registry writes `data-day={day.date.toLocaleDateString()}` — a
 * localised string, so not something a spec can ask for by date.
 * react-day-picker does emit a usable one of its own, `data-day` on the
 * surrounding `<td>`, formatted "yyyy-MM-dd" in local time. But it
 * appears nowhere in the package's type definitions: it is rendered
 * markup, not public API, and a major version is free to drop it. It
 * also sits on the CELL while the click handler sits on the BUTTON, so
 * a `[data-day=…]` selector silently matches an element that does
 * nothing when clicked. A distinct name on the element you actually
 * press avoids both.
 *
 * Selection styling is a different matter and does read the cell's
 * `data-selected`: a style that stops applying is visible the moment
 * anyone looks at the calendar, which a broken test hook is not.
 */
function CalendarDayButton({
  className,
  day,
  modifiers,
  ...props
}: React.ComponentProps<typeof DayButton>) {
  const ref = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (modifiers.focused) ref.current?.focus();
  }, [modifiers.focused]);

  return (
    <button
      ref={ref}
      type="button"
      data-day-iso={dateToLocalDate(day.date)}
      className={cn(
        buttonVariants({ variant: "ghost", size: "icon" }),
        "aspect-square h-auto w-full min-w-[var(--cell-size)] font-normal leading-none",
        "group-data-[selected=true]/day:bg-primary",
        "group-data-[selected=true]/day:text-primary-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { Calendar, CalendarDayButton };
