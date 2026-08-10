/**
 * Startup screen shown while the session is being restored.
 *
 * The rule here: never look frozen. A bare spinner gives the user no
 * way to tell "working" from "hung", so this states what it is doing,
 * escalates the wording as time passes, and after a few seconds offers
 * a way out instead of an indefinite wait.
 */
import { useEffect, useState } from "react";
import { Button } from "./Button.tsx";

/** Wording escalates with the wait. */
const STAGES = [
  { after: 0, message: "Restoring your session…" },
  { after: 3_000, message: "Still working — the connection looks slow." },
  { after: 7_000, message: "The server isn't answering." },
] as const;

const ESCAPE_AFTER_MS = 7_000;

export function Splash({
  onSkip,
  skipLabel,
}: {
  /** Offered once the wait becomes unreasonable. Omitted when there is
   * nothing sensible to skip to. */
  onSkip?: (() => void) | undefined;
  skipLabel?: string | undefined;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => setElapsed(Date.now() - started), 500);
    return () => clearInterval(id);
  }, []);

  const stage = [...STAGES].reverse().find((s) => elapsed >= s.after) ?? STAGES[0];
  const showSkip = onSkip !== undefined && elapsed >= ESCAPE_AFTER_MS;

  return (
    <div
      className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-slate-50 p-6"
      data-testid="splash"
    >
      <p className="select-none text-3xl font-bold tracking-tight text-slate-900">
        Gigsy
      </p>

      {/* Indeterminate bar: honest about not knowing the duration,
          while still visibly moving. */}
      <div
        className="h-1 w-48 overflow-hidden rounded-full bg-slate-200"
        role="progressbar"
        aria-label="Restoring your session"
      >
        <div className="h-full w-1/3 animate-[gigsy-slide_1.4s_ease-in-out_infinite] rounded-full bg-emerald-600" />
      </div>

      <p className="text-center text-sm text-slate-500" data-testid="splash-status">
        {stage.message}
      </p>

      {showSkip && (
        <Button variant="ghost" onClick={onSkip} data-testid="splash-skip">
          {skipLabel ?? "Continue offline"}
        </Button>
      )}

      <style>
        {`@keyframes gigsy-slide {
            0% { transform: translateX(-100%); }
            100% { transform: translateX(300%); }
          }`}
      </style>
    </div>
  );
}
