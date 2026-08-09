/**
 * Text input + textarea (design system, components/core/Input).
 * Always 16px — anything smaller makes iOS Safari zoom on focus; the
 * primary devices are phones.
 */
import type { ComponentPropsWithoutRef } from "react";

export const inputShellClasses =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 " +
  "placeholder:text-slate-400 transition-shadow duration-150 " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:border-emerald-500";

export function Input({ className = "", type = "text", ...rest }: ComponentPropsWithoutRef<"input">) {
  return <input type={type} className={`${inputShellClasses} ${className}`.trim()} {...rest} />;
}

/** Same shell, 96px minimum height unless the caller sets its own. */
export function textareaClasses(className = ""): string {
  const minHeight = /(?:^|\s)min-h-/.test(className) ? "" : "min-h-24";
  return [inputShellClasses, minHeight, className].filter(Boolean).join(" ");
}

export function Textarea({ className, ...rest }: ComponentPropsWithoutRef<"textarea">) {
  return <textarea className={textareaClasses(className)} {...rest} />;
}
