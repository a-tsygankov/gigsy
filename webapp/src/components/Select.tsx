/**
 * Native select in the input shell (design system,
 * components/core/Select) — Gigsy never uses a custom dropdown.
 */
import type { ComponentPropsWithoutRef } from "react";
import { shellWith } from "./Input.tsx";

export function Select({ className = "", ...rest }: ComponentPropsWithoutRef<"select">) {
  return <select className={shellWith(className)} {...rest} />;
}
