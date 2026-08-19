/**
 * Covers the `@/` alias as much as `cn` itself.
 *
 * The import below deliberately goes through the alias rather than a
 * relative path: ui/card.tsx is currently the only file that uses `@/`,
 * and nothing renders or imports it yet, so a typo in vitest.config.ts
 * or vite.config.ts would sail past `test`, `typecheck` and `build`
 * alike. This file fails instead.
 */
import { describe, it, expect } from "vitest";
import { cn } from "@/lib/utils.ts";

describe("cn", () => {
  /**
   * The reason tailwind-merge is here at all. Tailwind resolves two
   * utilities of the same property by their order in the generated
   * stylesheet, not by their order in the class attribute — so a
   * caller's override loses to the component's default at random (see
   * components/Input.tsx, which hand-rolls its own escape from exactly
   * this). tailwind-merge drops the earlier one so the last wins.
   */
  it("lets a later utility beat an earlier one for the same property", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
    expect(cn("text-slate-500", "text-slate-900")).toBe("text-slate-900");
    expect(cn("w-full", "w-36")).toBe("w-36");
  });

  it("keeps utilities that do not compete", () => {
    expect(cn("rounded-xl", "border-border", "bg-card")).toBe(
      "rounded-xl border-border bg-card",
    );
  });

  it("takes the conditional forms clsx accepts", () => {
    expect(cn("p-2", false && "p-4", null, undefined)).toBe("p-2");
    expect(cn(["p-2", "shadow"], { "bg-card": true, "bg-muted": false })).toBe(
      "p-2 shadow bg-card",
    );
  });
});
