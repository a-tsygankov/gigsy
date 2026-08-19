/** shadcn's class merger. Tailwind resolves competing utilities by
 *  stylesheet order, not attribute order (see components/Input.tsx for
 *  what that cost us), and this is what makes a caller's class actually
 *  win. */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
