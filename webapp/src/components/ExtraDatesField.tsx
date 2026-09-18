/**
 * "Also on" — the extra dates a gig happens, one `DateTimeField` per
 * row (design system, components/core/ExtraDatesField).
 *
 * A booking sheet or a forwarded email often lists several shifts —
 * same client, same venue, same fee, different dates — and the manual
 * form has the same shape from the other side: one description, N
 * dates, N gigs (docs/superpowers/specs/2026-09-18-gig-batches-
 * design.md). This is the N. It sits under the primary "Date & time"
 * on both screens that create gigs (GigEdit.tsx for a new gig,
 * DraftReview.tsx for a captured one), and what it holds goes through
 * `collectGigDates` (lib/gig-dates.ts) before anything is written.
 *
 * Deliberately dumb: it owns no state and applies no rules. Blank rows
 * are kept here and ignored on save; duplicates are kept here and
 * refused on save — because the save is where a message can be shown
 * beside a button, and a row that vanishes as you type is a row you
 * cannot fix.
 *
 * Not a `Field`: that wraps its children in one `<label>`, which is
 * right for one control and wrong for a list of them with buttons.
 * The heading repeats `Field`'s label voice (12px uppercase) so the
 * block reads as one more field on the form, and each row's
 * `DateTimeField` names itself ("Also on 2") for a screen reader.
 */
import { Button, DateTimeField } from "./index.ts";

export interface ExtraDatesFieldProps {
  /** One `DateTimeField` string per row ("YYYY-MM-DDTHH:mm" or ""). */
  values: string[];
  onChange: (values: string[]) => void;
  /** The block's own id. Rows suffix it: `${testId}-${i}` is the row's
   *  DateTimeField (and so `-${i}-calendar`, `-${i}-time` inside its
   *  popover), `${testId}-remove-${i}` its Remove button, and
   *  `${testId}-add` the button that appends a row. */
  testId: string;
  /** The heading. "Also on" is what both forms say; it is a prop so the
   *  component is not tied to that wording. */
  label?: string;
}

export function ExtraDatesField({
  values,
  onChange,
  testId,
  label = "Also on",
}: ExtraDatesFieldProps) {
  const update = (index: number, value: string) =>
    onChange(values.map((v, i) => (i === index ? value : v)));
  const remove = (index: number) => onChange(values.filter((_, i) => i !== index));
  const add = () => onChange([...values, ""]);

  return (
    <div data-testid={testId}>
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <p className="mb-2 text-xs text-slate-500">
        Add a date for each extra time this same gig happens — one gig is
        created per date, all otherwise identical.
      </p>
      {values.length > 0 && (
        <ul className="mb-2 space-y-2">
          {values.map((value, i) => (
            // Index keys, on purpose: rows have no identity of their own
            // beyond their position, and removing one is meant to shift
            // the rest up — a stable key per row would keep a removed
            // row's popover state alive on the wrong date.
            <li key={i} className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <DateTimeField
                  testId={`${testId}-${i}`}
                  label={`${label} ${i + 1}`}
                  value={value}
                  onChange={(v) => update(i, v)}
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                // 44px tall like DateTimeField's own Done/Clear: the tap
                // minimum docs/design-system.md sets, beside a row that
                // is already that tall.
                className="min-h-11 shrink-0"
                data-testid={`${testId}-remove-${i}`}
                aria-label={`Remove date ${i + 1}`}
                onClick={() => remove(i)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button variant="soft" data-testid={`${testId}-add`} onClick={add}>
        + Add another date
      </Button>
    </div>
  );
}
