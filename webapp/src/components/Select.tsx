/**
 * Native select in the input shell (design system,
 * components/core/Select) — Gigsy never uses a custom dropdown.
 */
import type { ComponentPropsWithoutRef } from "react";
import { inputShellClasses } from "./Input.tsx";

export function Select({ className = "", ...rest }: ComponentPropsWithoutRef<"select">) {
  return <select className={`${inputShellClasses} ${className}`.trim()} {...rest} />;
}
