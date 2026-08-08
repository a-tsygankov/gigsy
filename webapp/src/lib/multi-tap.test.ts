import { describe, it, expect, vi } from "vitest";
import { createMultiTapDetector } from "./multi-tap.ts";

/** Injectable clock — no fake timers needed. */
function makeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("createMultiTapDetector", () => {
  it("triggers after the configured number of rapid taps", () => {
    const onTrigger = vi.fn();
    const clock = makeClock();
    const det = createMultiTapDetector({ taps: 3, windowMs: 500, onTrigger, clock: clock.now });

    det.tap();
    clock.advance(100);
    det.tap();
    clock.advance(100);
    det.tap();

    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it("does not trigger below the tap count", () => {
    const onTrigger = vi.fn();
    const det = createMultiTapDetector({ taps: 3, windowMs: 500, onTrigger, clock: () => 0 });

    det.tap();
    det.tap();

    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("a slow tap restarts the sequence", () => {
    const onTrigger = vi.fn();
    const clock = makeClock();
    const det = createMultiTapDetector({ taps: 3, windowMs: 500, onTrigger, clock: clock.now });

    det.tap();
    clock.advance(100);
    det.tap();
    clock.advance(600); // beyond the window — sequence resets here
    det.tap();
    expect(onTrigger).not.toHaveBeenCalled();

    clock.advance(100);
    det.tap();
    clock.advance(100);
    det.tap();
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it("resets after triggering so it can fire again", () => {
    const onTrigger = vi.fn();
    const clock = makeClock();
    const det = createMultiTapDetector({ taps: 2, windowMs: 500, onTrigger, clock: clock.now });

    det.tap();
    det.tap();
    det.tap();
    det.tap();

    expect(onTrigger).toHaveBeenCalledTimes(2);
  });

  it("defaults to 3 taps within 600ms", () => {
    const onTrigger = vi.fn();
    const clock = makeClock();
    const det = createMultiTapDetector({ onTrigger, clock: clock.now });

    det.tap();
    clock.advance(200);
    det.tap();
    clock.advance(200);
    det.tap();

    expect(onTrigger).toHaveBeenCalledTimes(1);
  });
});
