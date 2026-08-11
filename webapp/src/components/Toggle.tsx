/**
 * An on/off switch (design system, components/core).
 *
 * A real `<input type="checkbox">` under the paint, not a div with a
 * click handler: that is what gets it keyboard focus, screen-reader
 * semantics, and form behaviour for free. The visible track is drawn
 * from the input's own `:checked` state via `peer-*`, so the two can
 * never disagree — the failure mode of hand-rolled switches.
 *
 * 44px of tap target at minimum, because phones are the primary
 * surface and a 20px switch is a miss waiting to happen.
 *
 * The wrapper is a `<label>`, and that is the whole reason this works.
 * The input is `sr-only` — 1×1px — and the switch you can see is a
 * sibling `<span>`. Without the label association, tapping the switch
 * hit nothing at all: every toggle in the app could only be operated
 * by tapping its separate text label, which on the settings rows was
 * big enough to hide the bug and on the working-hours rows was a
 * three-letter day name. Reported as "why can't I switch Sun".
 *
 * Wrapping rather than `htmlFor` because `id` is optional here, and a
 * control whose tappability depends on the caller remembering to pass
 * one is the same bug waiting to come back.
 */
export function Toggle({
  id,
  checked,
  onChange,
  disabled = false,
  label,
  "data-testid": testId,
}: {
  id?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** For assistive tech when the visible label lives elsewhere (in a
   *  SettingRow, say) and cannot be associated by `htmlFor`. */
  label?: string;
  "data-testid"?: string;
}) {
  return (
    <label
      className={`inline-flex h-11 items-center ${
        disabled ? "cursor-not-allowed" : "cursor-pointer"
      }`}
    >
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        data-testid={testId}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        aria-hidden="true"
        className={[
          "relative h-6 w-11 rounded-full transition-colors",
          "bg-slate-300 peer-checked:bg-emerald-600",
          "peer-disabled:opacity-40",
          // Focus lives on the hidden input, so the ring has to be
          // drawn here or keyboard users get no indication at all.
          "peer-focus-visible:ring-2 peer-focus-visible:ring-emerald-500",
          "peer-focus-visible:ring-offset-2",
        ].join(" ")}
      >
        <span
          className={[
            "absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow",
            "transition-transform peer-checked:translate-x-5",
            checked ? "translate-x-5" : "translate-x-0",
          ].join(" ")}
        />
      </span>
    </label>
  );
}
