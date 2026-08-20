/**
 * Billing an hourly gig something other than rate × time.
 *
 * `amountOfferedCents` means two different things depending on pay type
 * (lib/gig-pay.ts): on a fixed gig it IS the agreed fee, and the job
 * form owns it; on an hourly gig it is an override of the computed
 * figure. This control only ever exists for the second case — which is
 * why it takes `computed` rather than a whole gig: it has one job, and
 * the arithmetic is the work card's.
 *
 * It shows what it replaces. An override with the computed figure
 * hidden is a number nobody can check, and the spec's own phrasing —
 * "Computed $189.17 · Override" — is a statement of both.
 */
import { Button, Field, Input } from "../../components/index.ts";
import { centsToInput } from "../../lib/money.ts";
import { formatMoney } from "../../lib/format.ts";
import type { KeyboardEvent } from "react";

export interface HourlyOverrideProps {
  /** Dollars text, "" when there is no override. */
  value: string;
  onChange: (value: string) => void;
  /** Write it, or clear it back to computed. */
  onCommit: () => void;
  onClear: () => void;
  /** Rate × time, or null while there is not enough to compute one. */
  computed: number | null;
}

export function HourlyOverride({
  value,
  onChange,
  onCommit,
  onClear,
  computed,
}: HourlyOverrideProps) {
  const commitOnEnter = (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onCommit();
    }
  };

  return (
    <div className="rounded-xl bg-slate-50 p-3">
      {/* Clear sits OUTSIDE the Field: `Field` renders a <label>, and a
          button inside one competes with the label's own
          click-to-focus behaviour. */}
      <div className="flex items-end gap-2">
        <Field label="Override ($)">
          <Input
            data-testid="gig-override"
            inputMode="decimal"
            className="w-32"
            placeholder={computed === null ? "0.00" : centsToInput(computed)}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onCommit}
            onKeyDown={commitOnEnter}
          />
        </Field>
        {value !== "" && (
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11"
            data-testid="gig-override-clear"
            onClick={onClear}
          >
            Clear
          </Button>
        )}
      </div>
      <p className="mt-1 text-xs text-slate-500" data-testid="gig-computed-pay">
        {computed === null
          ? "Add a rate and a duration, or log the time worked, and the computed amount appears here."
          : value.trim() === ""
            ? `Computed ${formatMoney(computed)} from the rate and the time. Enter an amount to bill something else.`
            : `Computed ${formatMoney(computed)} · overridden. Clear this to go back to the computed amount.`}
      </p>
    </div>
  );
}
