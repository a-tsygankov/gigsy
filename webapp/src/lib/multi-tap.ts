/**
 * N-taps-in-a-row gesture detector (the hidden console's "3 taps on
 * the logo"). Pure logic with an injectable clock — React components
 * wire `tap` to onClick; tests drive it with a fake clock.
 */
export interface MultiTapOptions {
  /** Taps required to trigger. Default 3. */
  taps?: number;
  /** Max gap between consecutive taps. Default 600ms. */
  windowMs?: number;
  onTrigger: () => void;
  /** Injectable time source (ms). Default Date.now. */
  clock?: () => number;
}

export interface MultiTapDetector {
  tap(): void;
  reset(): void;
}

export function createMultiTapDetector(options: MultiTapOptions): MultiTapDetector {
  const taps = options.taps ?? 3;
  const windowMs = options.windowMs ?? 600;
  const clock = options.clock ?? Date.now;

  let count = 0;
  let lastTapAt = 0;

  return {
    tap(): void {
      const now = clock();
      count = now - lastTapAt <= windowMs && count > 0 ? count + 1 : 1;
      lastTapAt = now;
      if (count >= taps) {
        count = 0;
        options.onTrigger();
      }
    },
    reset(): void {
      count = 0;
      lastTapAt = 0;
    },
  };
}
