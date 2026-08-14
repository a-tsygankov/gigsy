/**
 * The unavailable message, wherever the user ends up.
 *
 * A failed scenario can navigate before it fails — "Open Settings"
 * starts on "/", not "/settings" — so a message rendered only inside
 * HelpSection (mounted solely on "/settings") would land on a screen
 * nobody is looking at. Spec §10 requires the message to reach the
 * user with a way back to the menu, so this is rendered by
 * HelpProvider at the app root instead, the same place UpdateBar lives
 * and for the same reason: whichever screen the user happens to be
 * standing on when this fires is the screen it has to reach.
 *
 * Takes its state as props rather than calling `useHelp()` itself —
 * this file and HelpProvider.tsx would otherwise import each other,
 * and there is nothing here that the caller doesn't already have.
 */
import { Button } from "../../components/index.ts";

export function HelpUnavailableBanner({
  message,
  onBackToHelp,
  onDismiss,
}: {
  message: string;
  onBackToHelp: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      // Not `status`: spec §10 treats this as a dead end the user must
      // back out of, not a routine progress update, so it should
      // interrupt the way an assistive-tech announcement of a failure
      // ought to.
      role="alert"
      data-testid="help-unavailable"
      // Same shell as UpdateBar, the app's other app-root notice — one
      // z-step above it (UpdateBar is z-50) because the two competing
      // for the same strip of screen is a real, if rare, possibility,
      // and whichever one the user was actively mid-action on should
      // win.
      className="fixed inset-x-0 bottom-0 z-[51] border-t border-slate-200 bg-white/95
                 px-4 py-3 backdrop-blur pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
    >
      <div className="mx-auto flex max-w-lg items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-slate-700">{message}</p>
        <Button
          variant="soft"
          size="sm"
          data-testid="help-unavailable-back"
          onClick={onBackToHelp}
        >
          Back to Help
        </Button>
        <Button
          variant="ghost"
          size="sm"
          data-testid="help-unavailable-dismiss"
          onClick={onDismiss}
        >
          Close
        </Button>
      </div>
    </div>
  );
}
