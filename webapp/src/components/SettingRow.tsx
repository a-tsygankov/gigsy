/**
 * A single setting: what it is, what it does, and its control.
 *
 * Every setting on the screen has the same three parts, so the shape is
 * a component rather than repeated markup — thirteen hand-built rows
 * drift, and the explanation is the part that gets dropped first. The
 * description is required for exactly that reason: a setting nobody can
 * explain is a setting nobody should ship.
 *
 * The control sits below the text on narrow screens and beside it from
 * `sm` up, because a toggle squeezed next to two lines of prose at
 * 375px leaves neither readable — and phones are the primary surface.
 */
import type { ReactNode } from "react";

export function SettingRow({
  label,
  description,
  control,
  htmlFor,
  "data-testid": testId,
}: {
  label: string;
  description: string;
  control: ReactNode;
  /** Set when the control is a real form element, so the label targets
   *  it and the tap area covers both. */
  htmlFor?: string;
  "data-testid"?: string;
}) {
  const Label = htmlFor === undefined ? "div" : "label";

  return (
    <div
      className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
      data-testid={testId}
    >
      <div className="min-w-0 flex-1">
        <Label
          className="block text-sm font-medium text-slate-900"
          {...(htmlFor === undefined ? {} : { htmlFor })}
        >
          {label}
        </Label>
        <p className="mt-0.5 text-xs text-slate-500">{description}</p>
      </div>
      <div className="shrink-0 sm:pt-0.5">{control}</div>
    </div>
  );
}

/**
 * Which surface a group is drawn on. `card` is every group on the
 * Settings screen; `help` is the one that isn't a setting at all —
 * see --surface-help in src/styles/tokens/semantic.css. A prop rather
 * than a second component, because the only thing that differs is the
 * three colours below, and a fork would drift on the other twelve.
 */
export type SettingGroupTone = "card" | "help";

const TONES: Record<SettingGroupTone, { shell: string; description: string }> = {
  card: { shell: "border-slate-200 bg-white", description: "text-slate-500" },
  // slate-600, not slate-500: the tinted surface costs the muted step
  // its contrast (see HelpMenu.tsx).
  help: { shell: "border-sky-200 bg-sky-100", description: "text-slate-600" },
};

/**
 * Settings grouped under a heading, hairline-separated.
 *
 * Separators come from the group rather than the row so the last row
 * has no trailing rule — a detail that looks like a bug when a hand-
 * built list gets it wrong.
 */
export function SettingGroup({
  title,
  description,
  children,
  tone = "card",
  "data-testid": testId,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  tone?: SettingGroupTone;
  "data-testid"?: string;
}) {
  return (
    <section
      className={`rounded-2xl border p-4 shadow-sm ${TONES[tone].shell}`}
      data-testid={testId}
    >
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      {description !== undefined && (
        <p className={`mt-0.5 text-xs ${TONES[tone].description}`}>{description}</p>
      )}
      <div className="mt-1 divide-y divide-slate-100">{children}</div>
    </section>
  );
}
