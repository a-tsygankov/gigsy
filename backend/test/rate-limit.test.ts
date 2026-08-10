/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * The fixed-window limiter behind the public availability endpoint.
 *
 * Time is passed in rather than read, so the window's edges are
 * assertable instead of waited for.
 */
import { describe, it, expect } from "vitest";
import { fixedWindowLimiter } from "../src/lib/rate-limit.ts";

const WINDOW = 60_000;
const T0 = 1_000_000;

describe("fixedWindowLimiter", () => {
  it("allows up to the limit", () => {
    const limiter = fixedWindowLimiter({ limit: 3, windowMs: WINDOW });

    expect(limiter.check("a", T0).allowed).toBe(true);
    expect(limiter.check("a", T0).allowed).toBe(true);
    expect(limiter.check("a", T0).allowed).toBe(true);
  });

  it("refuses the one after", () => {
    const limiter = fixedWindowLimiter({ limit: 2, windowMs: WINDOW });
    limiter.check("a", T0);
    limiter.check("a", T0);

    expect(limiter.check("a", T0).allowed).toBe(false);
  });

  it("says how long to wait, rounded up to a usable second", () => {
    const limiter = fixedWindowLimiter({ limit: 1, windowMs: WINDOW });
    limiter.check("a", T0);

    const decision = limiter.check("a", T0 + 30_000);

    expect(decision.retryAfterSeconds).toBe(30);
  });

  it("never advises a wait of zero seconds", () => {
    // Retry-After: 0 invites an immediate retry, which is the loop the
    // limiter is there to break.
    const limiter = fixedWindowLimiter({ limit: 1, windowMs: WINDOW });
    limiter.check("a", T0);

    expect(limiter.check("a", T0 + WINDOW - 1).retryAfterSeconds).toBe(1);
  });

  it("starts over once the window has passed", () => {
    const limiter = fixedWindowLimiter({ limit: 1, windowMs: WINDOW });
    limiter.check("a", T0);

    expect(limiter.check("a", T0 + WINDOW).allowed).toBe(true);
  });

  it("keeps keys apart", () => {
    const limiter = fixedWindowLimiter({ limit: 1, windowMs: WINDOW });
    limiter.check("a", T0);

    expect(limiter.check("b", T0).allowed).toBe(true);
    expect(limiter.check("a", T0).allowed).toBe(false);
  });

  it("sweeps expired keys rather than growing without bound", () => {
    // The key space is the caller's IP, which is attacker-chosen.
    const limiter = fixedWindowLimiter({ limit: 5, windowMs: WINDOW, maxKeys: 4 });
    for (let i = 0; i < 4; i++) limiter.check(`old-${i}`, T0);

    // A window later the old keys are dead, so a new one still fits.
    expect(limiter.check("fresh", T0 + WINDOW).allowed).toBe(true);
  });

  it("refuses rather than grow when every tracked window is live", () => {
    const limiter = fixedWindowLimiter({ limit: 5, windowMs: WINDOW, maxKeys: 2 });
    limiter.check("a", T0);
    limiter.check("b", T0);

    // Under that much pressure from distinct keys, refusing is the
    // point — the alternative is unbounded memory.
    expect(limiter.check("c", T0).allowed).toBe(false);
  });
});
