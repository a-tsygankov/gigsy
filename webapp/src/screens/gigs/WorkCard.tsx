/**
 * What actually HAPPENED, recorded as it happens.
 *
 * The counterpart to JobCard above it: that card is the agreement and
 * changes at a desk; this one is the day, and changes with one thumb
 * between two shifts. Only pay reads these fields (lib/gig-pay.ts), and
 * nothing here can move the plan — which is the fault the whole split
 * exists to fix.
 *
 * NO SAVE BUTTON, deliberately. Every control here writes the moment it
 * is used: the status select and the two moments on change, the break
 * and the override on blur or Enter — the point at which a typed value
 * has stopped moving. A Save button on a card whose controls have
 * already saved is a lie, and the version of that lie which matters is
 * the one where somebody taps Stop, walks off without pressing Save,
 * and loses the stamp. What replaces it is a visible save state below,
 * because "it saved itself" is only trustworthy if you can see it
 * happen.
 *
 * The blur/Enter pair is the one seam: a value typed and never blurred
 * — the app backgrounded mid-keystroke — is not written. That is the
 * price of not writing a partial "1" on the way to "18", and it is why
 * both events commit rather than just blur.
 */
import { useEffect, useState, type KeyboardEvent } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Button, DateTimeField, Field, Input, Select } from "../../components/index.ts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { formatDuration, formatMoney } from "../../lib/format.ts";
import { localInputToMs, msToLocalInput } from "../../lib/datetime.ts";
import { centsToInput, parseMoney } from "../../lib/money.ts";
import { expectedCents, workedMinutes, type PayableGig } from "../../lib/gig-pay.ts";
import { GIG_STATUSES, type Gig, type GigInput, type GigStatus } from "../../lib/types.ts";

/** Stamped to the current minute, not the current second: every other
 *  time in the app is minute-resolution (lib/datetime.ts), and a stored
 *  14:07:36 would render as 14:07 while pricing as something else. */
const nowToMinute = (): number => Math.floor(Date.now() / 60_000) * 60_000;

/** The controls that hold text between keystrokes. Everything else is
 *  read straight off the saved gig, because everything else commits in
 *  the same gesture that changes it. */
interface Draft {
  workStart: string;
  workEnd: string;
  breakMinutes: string;
  /** Dollars text. Hourly gigs only — see the override block below. */
  override: string;
}

function draftOf(gig: Gig): Draft {
  return {
    workStart: msToLocalInput(gig.workStartedAt),
    workEnd: msToLocalInput(gig.workEndedAt),
    breakMinutes: gig.breakMinutes !== null ? String(gig.breakMinutes) : "",
    override:
      gig.payType === "hourly" && gig.amountOfferedCents !== null
        ? centsToInput(gig.amountOfferedCents)
        : "",
  };
}

/**
 * The same three rules as backend/src/domain/schemas.ts's superRefine,
 * checked here so a mistyped log fails against the field rather than as
 * a 400 the outbox then drops (sync-engine.ts poison-drops a rejected
 * op, which loses the edit silently).
 */
export function workLogProblem(
  startMs: number | null,
  endMs: number | null,
  breakMinutes: number | null,
): string | null {
  if (endMs !== null && startMs === null) return "Work can't end without a start time.";
  if (startMs !== null && endMs !== null) {
    if (endMs <= startMs) return "Finished must be after Started.";
    if (breakMinutes !== null && breakMinutes * 60_000 >= endMs - startMs) {
      return "The break can't fill the whole shift.";
    }
  }
  return null;
}

export interface WorkCardProps {
  gig: Gig;
  /** One field's worth of change. The hub merges it over the whole gig
   *  — `putGig` replaces rather than patches (lib/gig-input.ts). */
  onCommit: (patch: GigInput) => void;
  saving: boolean;
  failed: boolean;
}

export function WorkCard({ gig, onCommit, saving, failed }: WorkCardProps) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(gig));
  const [problem, setProblem] = useState<string | null>(null);
  const reduced = useReducedMotion();

  // Re-seed from the record whenever it changes — after our own save,
  // and after a sync pull brings another device's edit. Deliberately the
  // same shape GigEdit uses: the cost is that a pull landing mid-typing
  // replaces uncommitted text, and the alternative (never re-seeding)
  // shows a stale figure after a stamp lands, which is worse on a card
  // whose whole job is to be current.
  useEffect(() => {
    setDraft(draftOf(gig));
  }, [gig]);

  const startMs = localInputToMs(draft.workStart);
  const endMs = localInputToMs(draft.workEnd);
  const breakMinutes = draft.breakMinutes.trim() === "" ? null : Number(draft.breakMinutes);
  const isHourly = gig.payType === "hourly";
  const overrideCents = draft.override.trim() === "" ? null : parseMoney(draft.override);

  /**
   * Priced from the draft, not from the saved record.
   *
   * The saved `expectedCents` column is the server's and is nulled by
   * every local write (lib/local-store.ts), so reading it here would
   * blank the figure at the exact moment a stamp lands. Deriving gives
   * the same number by the same formula, and gives it while the value
   * is still being typed.
   */
  const draftPay: PayableGig = {
    payType: gig.payType,
    hourlyRateCents: gig.hourlyRateCents,
    // On a fixed gig this IS the fee and belongs to the job form; on an
    // hourly one it is the override below, and nothing else may set it.
    amountOfferedCents: isHourly ? overrideCents : gig.amountOfferedCents,
    durationMinutes: gig.durationMinutes,
    workStartedAt: startMs,
    workEndedAt: endMs,
    breakMinutes,
  };
  const worked = workedMinutes(draftPay);
  const expected = expectedCents(draftPay);
  const payLine =
    expected === null
      ? null
      : worked !== null
        ? `Worked ${formatDuration(worked)} → ${formatMoney(expected)}`
        : `Expected ${formatMoney(expected)}`;

  /** What rate × time says on its own, so the override can be shown
   *  beside the figure it replaced rather than instead of it. */
  const computed = isHourly ? expectedCents({ ...draftPay, amountOfferedCents: null }) : null;

  function commitWorkLog(next: Draft): void {
    const nextStart = localInputToMs(next.workStart);
    const nextEnd = localInputToMs(next.workEnd);
    const nextBreak = next.breakMinutes.trim() === "" ? null : Number(next.breakMinutes);
    const found = workLogProblem(nextStart, nextEnd, nextBreak);
    setProblem(found);
    if (found !== null) return;
    onCommit({
      workStartedAt: nextStart,
      workEndedAt: nextEnd,
      breakMinutes: nextBreak,
    });
  }

  /** Change and write in one move — what a stamp, a status or a picked
   *  moment does. */
  function change(patch: Partial<Draft>): void {
    const next = { ...draft, ...patch };
    setDraft(next);
    commitWorkLog(next);
  }

  function commitOverride(): void {
    const text = draft.override.trim();
    if (text === "") {
      setProblem(null);
      onCommit({ amountOfferedCents: null });
      return;
    }
    const cents = parseMoney(text);
    if (cents === null) {
      setProblem("That override isn't a valid dollar value.");
      return;
    }
    if (cents <= 0) {
      // OfflineDataService.assertPositive throws on a zero or negative
      // amount, so this would fail the write rather than store one.
      setProblem("The override must be greater than zero — clear it to go back to computed.");
      return;
    }
    setProblem(null);
    onCommit({ amountOfferedCents: cents });
  }

  const commitOnEnter = (commit: () => void) => (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    }
  };

  return (
    <Card data-testid="gig-work-card">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm">Work</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0">
        <Field label="Status">
          <Select
            data-testid="gig-status"
            value={gig.status}
            onChange={(e) => onCommit({ status: e.target.value as GigStatus })}
          >
            {GIG_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>

        {/* The two-tap path, for the moment it actually happens. Start
            is disabled once a start exists and Stop once an end does:
            a second tap would silently overwrite a real stamp with
            "now", and the fields below are how a stamp gets corrected. */}
        <div className="flex gap-2">
          <Button
            data-testid="work-start"
            className="flex-1"
            // Read off the draft, not the saved record: the save is a
            // round trip through the query cache, and a button that
            // stays live for those few frames can be double-tapped into
            // overwriting the stamp it just took.
            disabled={startMs !== null}
            onClick={() => change({ workStart: msToLocalInput(nowToMinute()) })}
          >
            Start
          </Button>
          <Button
            data-testid="work-stop"
            variant="ghost"
            className="flex-1"
            disabled={startMs === null || endMs !== null}
            onClick={() => change({ workEnd: msToLocalInput(nowToMinute()) })}
          >
            Stop
          </Button>
        </div>

        {/* Editable underneath the buttons on purpose: a stamp you took
            twenty minutes late has to be correctable, and this is the
            field the pay is computed from. */}
        <Field label="Started">
          <DateTimeField
            testId="gig-work-start"
            label="Started"
            value={draft.workStart}
            onChange={(v) => change({ workStart: v })}
          />
        </Field>
        <Field label="Finished">
          <DateTimeField
            testId="gig-work-end"
            label="Finished"
            value={draft.workEnd}
            onChange={(v) => change({ workEnd: v })}
          />
        </Field>
        <Field label="Off-time breaks (minutes)">
          <Input
            type="number"
            min={0}
            inputMode="numeric"
            className="w-24"
            data-testid="gig-break"
            placeholder="0"
            value={draft.breakMinutes}
            onChange={(e) => setDraft({ ...draft, breakMinutes: e.target.value })}
            onBlur={() => commitWorkLog(draft)}
            onKeyDown={commitOnEnter(() => commitWorkLog(draft))}
          />
        </Field>

        {payLine !== null && (
          <p className="text-sm font-medium text-slate-700">
            {/* Keyed on the figure so it replays when a stamp lands —
                the one number on this card that changes without being
                typed, and the reason to look at it. `useReducedMotion`
                is motion's own read of the system setting
                (docs/design-system.md on motion tokens); when it is on,
                the element still remounts and simply appears. */}
            <motion.span
              key={expected ?? "none"}
              data-testid="gig-expected-pay"
              initial={reduced === true ? false : { opacity: 0, y: -3 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.15 }}
              className="inline-block"
            >
              {payLine}
            </motion.span>
          </p>
        )}

        {/* ── The hourly override ──
            An override is a claim about what THIS gig earned, which is
            why it lives here and not on the job form: the job form says
            how the work is priced, and `submit()` there still forces
            this field to null on an hourly gig so a fee typed before
            the pay type was switched cannot ride along unseen.
            Rendered for hourly gigs only — on a fixed gig the same
            column IS the agreed fee, and the job form owns it. */}
        {isHourly && (
          <div className="rounded-xl bg-slate-50 p-3">
            {/* Clear sits OUTSIDE the Field: `Field` renders a <label>,
                and a button inside one competes with the label's own
                click-to-focus behaviour. */}
            <div className="flex items-end gap-2">
              <Field label="Override ($)">
                <Input
                  data-testid="gig-override"
                  inputMode="decimal"
                  className="w-32"
                  placeholder={computed === null ? "0.00" : centsToInput(computed)}
                  value={draft.override}
                  onChange={(e) => setDraft({ ...draft, override: e.target.value })}
                  onBlur={commitOverride}
                  onKeyDown={commitOnEnter(commitOverride)}
                />
              </Field>
              {draft.override !== "" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="min-h-11"
                  data-testid="gig-override-clear"
                  onClick={() => {
                    setDraft({ ...draft, override: "" });
                    setProblem(null);
                    onCommit({ amountOfferedCents: null });
                  }}
                >
                  Clear
                </Button>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-500" data-testid="gig-computed-pay">
              {computed === null
                ? "Add a rate and a duration, or log the time worked, and the computed amount appears here."
                : draft.override.trim() === ""
                  ? `Computed ${formatMoney(computed)} from the rate and the time. Enter an amount to bill something else.`
                  : `Computed ${formatMoney(computed)} · overridden. Clear this to go back to the computed amount.`}
            </p>
          </div>
        )}

        {problem !== null && (
          <p className="text-xs text-red-600" data-testid="work-error">
            {problem}
          </p>
        )}
        {/* The receipt for a card with no Save button. Always mounted so
            a test — and a person — can tell "saved" from "never tried". */}
        <p className="text-xs text-slate-500" data-testid="work-save-state">
          {saving
            ? "Saving…"
            : failed
              ? "Couldn't save that change — nothing was stored."
              : "Saved as you go — there is nothing to press."}
        </p>
      </CardContent>
    </Card>
  );
}
