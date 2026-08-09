/**
 * Gigsy's only button (design system, components/core/Button). One
 * accent, one radius; `danger` is never a filled red button. There is
 * no separate link-button style — `ButtonLink` shares the recipe for
 * actions that navigate.
 */
import type { ComponentPropsWithoutRef } from "react";
import { Link, type LinkProps } from "react-router-dom";

export type ButtonVariant = "primary" | "ghost" | "danger" | "soft";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonStyleProps {
  /** Visual role. `soft` is the pale-emerald inline chip (e.g. "Sync now"). */
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  /** Full width — the default for the bottom of a form on mobile. */
  block?: boolean | undefined;
  className?: string | undefined;
}

const BASE =
  "inline-flex items-center justify-center rounded-xl transition-all duration-150 " +
  "focus:outline-none focus-visible:ring-2 disabled:opacity-50 disabled:pointer-events-none";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-emerald-600 font-semibold text-white shadow-sm hover:bg-emerald-700 hover:shadow " +
    "focus-visible:ring-emerald-500 focus-visible:ring-offset-2",
  ghost:
    "border border-slate-300 bg-white font-medium text-slate-700 hover:bg-slate-100 " +
    "focus-visible:ring-emerald-500",
  danger:
    "border border-red-200 bg-white font-medium text-red-600 hover:bg-red-50 " +
    "focus-visible:ring-red-500",
  soft:
    "border border-emerald-200 bg-emerald-50 font-semibold text-emerald-700 " +
    "hover:bg-emerald-100 focus-visible:ring-emerald-500",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "px-2 py-1 text-xs",
  md: "px-4 py-2 text-sm",
  lg: "px-4 py-3 text-sm",
};

export function buttonClasses({
  variant = "primary",
  size = "md",
  block = false,
  className = "",
}: ButtonStyleProps): string {
  // The soft chip renders at 12px with compact padding by default.
  const sizeCls = variant === "soft" && size === "md" ? "px-3 py-2 text-xs" : SIZES[size];
  return [BASE, VARIANTS[variant], sizeCls, block ? "w-full" : "", className]
    .filter(Boolean)
    .join(" ");
}

type ButtonProps = ButtonStyleProps & ComponentPropsWithoutRef<"button">;

export function Button({ variant, size, block, className, type = "button", ...rest }: ButtonProps) {
  return (
    <button type={type} className={buttonClasses({ variant, size, block, className })} {...rest} />
  );
}

type ButtonLinkProps = ButtonStyleProps & LinkProps;

export function ButtonLink({ variant, size, block, className, ...rest }: ButtonLinkProps) {
  return <Link className={buttonClasses({ variant, size, block, className })} {...rest} />;
}
