/**
 * Text input + textarea (design system, components/core/Input).
 * Always 16px — anything smaller makes iOS Safari zoom on focus; the
 * primary devices are phones.
 */
import type { ComponentPropsWithoutRef } from "react";

/**
 * Everything the shell sets EXCEPT its width, which is applied
 * separately by `shellWith` so a caller can replace it.
 *
 * Splitting it is not tidiness. Tailwind resolves two utilities of the
 * same property by their order in the generated stylesheet, not by
 * their order in the class attribute — so `w-full` here beat a `w-36`
 * passed in by a caller, silently, with no way to tell from the call
 * site. That shipped: the gig filter row's sort select stayed
 * full-width, refused to shrink, and pushed the page wide enough to
 * break clicks on the fixed tab bar.
 */
const SHELL_WITHOUT_WIDTH =
  "rounded-xl border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 " +
  "placeholder:text-slate-400 transition-shadow duration-150 " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:border-emerald-500";

export const inputShellClasses = `w-full ${SHELL_WITHOUT_WIDTH}`;

/**
 * Whether the caller brought a width of their own.
 *
 * Only an UNPREFIXED width counts. `sm:w-48` means "full width on a
 * phone, 48 from sm up", so dropping the default would break the phone
 * case — which is the one that matters most here.
 */
function suppliesWidth(className: string): boolean {
  return className
    .split(/\s+/)
    .some((token) => token.startsWith("w-") && !token.includes(":"));
}

/**
 * The shell plus the caller's classes, with the default width dropped
 * when the caller set one. Mirrors what `textareaClasses` already does
 * for `min-h-`.
 */
export function shellWith(className: string): string {
  return [suppliesWidth(className) ? "" : "w-full", SHELL_WITHOUT_WIDTH, className]
    .filter(Boolean)
    .join(" ");
}

export function Input({ className = "", type = "text", ...rest }: ComponentPropsWithoutRef<"input">) {
  return <input type={type} className={shellWith(className)} {...rest} />;
}

/** Same shell, 96px minimum height unless the caller sets its own. */
export function textareaClasses(className = ""): string {
  const minHeight = /(?:^|\s)min-h-/.test(className) ? "" : "min-h-24";
  return [shellWith(className), minHeight].filter(Boolean).join(" ");
}

export function Textarea({ className, ...rest }: ComponentPropsWithoutRef<"textarea">) {
  return <textarea className={textareaClasses(className)} {...rest} />;
}
