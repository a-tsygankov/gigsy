/**
 * What actually HAPPENED, recorded as it happens.
 *
 * The counterpart to JobCard above it: that card is the agreement and
 * changes at a desk; this one is the day, and changes with one thumb
 * between two shifts. Only pay reads these fields (lib/gig-pay.ts), and
 * nothing here can move the plan — which is the fault the whole split
 * exists to fix.
 *
 * NO SAVE BUTTON, deliberately. Every control here writes: the status
 * select and the two moments on change, the break and the override on
 * blur or Enter — the point at which a typed value has stopped moving.
 * A Save button on a card whose controls have already saved is a lie,
 * and the version of that lie which matters is the one where somebody
 * taps Stop, walks off without pressing Save, and loses the stamp.
 *
 * What replaces it is a save state below that names four different
 * situations, because "it saved itself" is only trustworthy if you can
 * see it happen — and because an idle line that reads the same before
 * the first write and after a successful one tells you nothing.
 *
 * Blur and Enter are not the only commit points, and the extra ones
 * are not belt-and-braces — see useCommitOnLeave.ts for what blur
 * misses and why `onFlush` is separate from `onCommit`.
 */
import { useEffect, useState, type KeyboardEvent } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Button, DateTimeField, Field, Input, Select } from "../../components/index.ts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { HourlyOverride } from "./HourlyOverride.tsx";
import { useCommitOnLeave } from "./useCommitOnLeave.ts";
import { formatDuration, formatMoney } from "../../lib/format.ts";
import { localInputToMs, msToLocalInput } from "../../lib/datetime.ts";
import { centsToInput, parseMoney } from "../../lib/money.ts";
import { workLogProblem } from "../../lib/work-log.ts";
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
  /** Dollars text. Hourly gigs only — see HourlyOverride.tsx. */
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

const breakOf = (draft: Draft): number | null =>
  draft.breakMinutes.trim() === "" ? null : Number(draft.breakMinutes);

/**
 * What is typed but not yet written, as a patch — or null when the two
 * blur-committed fields already match the record.
 *
 * This is what "dirty" means on this card, and what the unmount and
 * `pagehide` flushes send.
 *
 * Only VALID differences count, and the two fields fail differently. An
 * override of "12x" or "1.234" is not money at all (`parseMoney`
 * returns null) and a zero one is refused by
 * OfflineDataService.assertPositive, so neither is flushed. A break
 * goes through the same `workLogProblem` the blur path uses, which is
 * where 18.5 and 2000 are caught. Flushing either kind would write
 * something the server rejects, and sync-engine drops a rejected op
 * with only a warn — the silent loss this card exists not to cause.
 */
function pendingPatch(draft: Draft, gig: Gig): GigInput | null {
  const patch: GigInput = {};
  const startMs = localInputToMs(draft.workStart);
  const endMs = localInputToMs(draft.workEnd);
  const nextBreak = breakOf(draft);
  if (nextBreak !== gig.breakMinutes && workLogProblem(startMs, endMs, nextBreak) === null) {
    patch.workStartedAt = startMs;
    patch.workEndedAt = endMs;
    patch.breakMinutes = nextBreak;
  }
  if (gig.payType === "hourly") {
    const text = draft.override.trim();
    const cents = text === "" ? null : parseMoney(text);
    const usable = text === "" || (cents !== null && cents > 0);
    if (usable && cents !== gig.amountOfferedCents) patch.amountOfferedCents = cents;
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

export interface WorkCardProps {
  gig: Gig;
  /** One field's worth of change, written now. The hub merges it over
   *  the current record — `putGig` replaces rather than patches
   *  (lib/gig-input.ts). */
  onCommit: (patch: GigInput) => void;
  /** The same write, issued from unmount or `pagehide`, when this
   *  component is going away and cannot render the result. Separate
   *  because it must not depend on anything this card owns. */
  onFlush: (patch: GigInput) => void;
  saving: boolean;
  failed: boolean;
  /** When the last successful write landed, or null if none has this
   *  session. */
  savedAt: number | null;
}

export function WorkCard({
  gig,
  onCommit,
  onFlush,
  saving,
  failed,
  savedAt,
}: WorkCardProps) {
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

  // Leaving the screen with a break still in the box has to write it —
  // see useCommitOnLeave for the two exits and why blur alone is not
  // enough. It sometimes writes the same patch TWICE: blur commits, the
  // navigation lands before the saved record comes back, and the draft
  // still differs from the gig this card was rendered with. Accepted
  // rather than guarded — the write is idempotent, and tracking
  // in-flight writes to save one redundant op is a lot of machinery to
  // protect against being right twice.
  useCommitOnLeave(() => pendingPatch(draft, gig), onFlush);

  const startMs = localInputToMs(draft.workStart);
  const endMs = localInputToMs(draft.workEnd);
  const breakMinutes = breakOf(draft);
  const isHourly = gig.payType === "hourly";
  const overrideCents = draft.override.trim() === "" ? null : parseMoney(draft.override);
  const dirty = pendingPatch(draft, gig) !== null;

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
    const found = workLogProblem(nextStart, nextEnd, breakOf(next));
    setProblem(found);
    if (found !== null) return;
    onCommit({
      workStartedAt: nextStart,
      workEndedAt: nextEnd,
      breakMinutes: breakOf(next),
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

  const commitBreakOnEnter = (event: KeyboardEvent): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitWorkLog(draft);
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
            onKeyDown={commitBreakOnEnter}
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

        {/* An override is a claim about what THIS gig earned, which is
            why it lives here and not on the job form: that form states
            how the work is priced, not what it made. The form does
            still touch the same column — it nulls it when a gig is
            switched from fixed to hourly, so a fee typed as a fee
            cannot become an override nobody meant to set — but it
            preserves whatever this control wrote on a gig that was
            already hourly (GigEdit.tsx's `submit`). */}
        {isHourly && (
          <HourlyOverride
            value={draft.override}
            onChange={(v) => setDraft({ ...draft, override: v })}
            onCommit={commitOverride}
            onClear={() => {
              setDraft({ ...draft, override: "" });
              setProblem(null);
              onCommit({ amountOfferedCents: null });
            }}
            computed={computed}
          />
        )}

        {problem !== null && (
          <p className="text-xs text-red-600" data-testid="work-error">
            {problem}
          </p>
        )}
        {/* The receipt for a card with no Save button: saving, failed,
            dirty, saved-at, and never-written — five, because one idle
            string could not tell "nothing written yet" from "written
            and saved", which is the question this line exists to
            answer. `dirty` is the one that earns its place twice over:
            it is what says a typed break has not been committed, in the
            seconds before a blur, a flush, or nothing at all. */}
        <p className="text-xs text-slate-500" data-testid="work-save-state">
          {saving
            ? "Saving…"
            : failed
              ? "Couldn't save that change — nothing was stored."
              : dirty
                ? "Not saved yet — press Enter, or tap outside the box."
                : savedAt !== null
                  ? `Saved at ${new Date(savedAt).toLocaleTimeString(undefined, {
                      hour: "numeric",
                      minute: "2-digit",
                    })}`
                  : "Saved as you go — there is nothing to press."}
        </p>
      </CardContent>
    </Card>
  );
}
