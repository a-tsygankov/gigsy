/**
 * A visible native file chooser (design system, components/core/
 * FilePicker).
 *
 * Money → Payments had this inline for its proof-of-payment photo, and
 * it was the right control for a reason the capture screen learned the
 * hard way: a VISIBLE `<input type="file">` with no `capture` attribute
 * is what the OS turns into "camera / photo library / files". A hidden
 * input behind a button with `capture="environment"` forces the camera,
 * and on many phones that means no way to pick a flyer already in the
 * library or a PDF booking sheet. So the control moved here, where both
 * screens can share one (docs/superpowers/specs/2026-09-18-gig-batches-
 * design.md).
 *
 * The styling is the Tailwind `file:` pseudo-element recipe, which is
 * the only way to make the native button look like `Button` without
 * replacing the input — and replacing it is exactly what must not
 * happen, because the OS sheet only comes from the real thing. The text
 * beside the button ("No file chosen", the chosen name) is the
 * browser's, and is left alone.
 *
 * What it does NOT do:
 *
 *   - Reset itself. A file input keeps its selection until something
 *     clears it, and whether to clear is the screen's call: Payments
 *     clears it after the photo is handed to the queue (so the preview
 *     stops showing a file the queue now owns), while Capture navigates
 *     away and never needs to. `ref` forwards to the input for a screen
 *     that wants to write `value = ""`.
 *   - Call `onFile` for an empty selection. A cancelled picker fires
 *     `change` with no files in some browsers; that is not a choice,
 *     and the screen's state should not be touched by it.
 */
import { forwardRef } from "react";

export interface FilePickerProps {
  /** The `accept` attribute — a MIME pattern and/or extensions, e.g.
   *  "image/*,.pdf". What the OS sheet offers is advisory: a file of
   *  another type can still arrive, so the screen validates too. */
  accept: string;
  /** The first file chosen. Never called with nothing. */
  onFile: (file: File) => void;
  testId?: string;
  disabled?: boolean;
  className?: string;
  /** The input's accessible name. Unlike `Input`, this is rarely inside
   *  a `Field`, so nothing else names it. */
  label?: string;
}

/** The recipe is the identity of the control — every chooser in the app
 *  is this one, so there is no second copy to drift. */
const filePickerClasses =
  "block w-full text-xs text-slate-500 file:mr-3 file:rounded-xl " +
  "file:border-0 file:bg-emerald-600 file:px-3 file:py-2 " +
  "file:text-xs file:font-semibold file:text-on-accent " +
  "hover:file:bg-emerald-700 disabled:opacity-50";

export const FilePicker = forwardRef<HTMLInputElement, FilePickerProps>(function FilePicker(
  { accept, onFile, testId, disabled, className = "", label },
  ref,
) {
  return (
    <input
      ref={ref}
      type="file"
      accept={accept}
      data-testid={testId}
      aria-label={label}
      disabled={disabled}
      className={[filePickerClasses, className].filter(Boolean).join(" ")}
      onChange={(e) => {
        const file = e.target.files?.[0];
        if (file !== undefined) onFile(file);
      }}
    />
  );
});
