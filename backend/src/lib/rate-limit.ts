/**
 * A fixed-window counter, for the one endpoint that has no login in
 * front of it (Phase 12's /api/a/:token).
 *
 * Stated plainly, because overclaiming here would be worse than not
 * having it: this counts per isolate, and Workers runs many. A
 * determined scraper spread across enough connections will get more
 * than `limit` through. It is a speed bump against someone hammering
 * one link, not a guarantee.
 *
 * The actual defence is that the token is 128 random bits and can be
 * revoked. This limiter exists so that *knowing* a link does not also
 * buy an unmetered feed of someone's schedule.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** How long until the window rolls over. Only meaningful when
   *  `allowed` is false; it becomes the Retry-After header. */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  check(key: string, now: number): RateLimitDecision;
}

export interface RateLimitOptions {
  /** Requests per window, per key. */
  limit: number;
  windowMs: number;
  /** Above this many tracked keys, expired ones are swept. Bounds
   *  memory when the key space is attacker-chosen. */
  maxKeys?: number;
}

interface Window {
  count: number;
  resetAt: number;
}

const DEFAULT_MAX_KEYS = 10_000;

export function fixedWindowLimiter(options: RateLimitOptions): RateLimiter {
  const windows = new Map<string, Window>();
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;

  return {
    check(key: string, now: number): RateLimitDecision {
      const existing = windows.get(key);

      if (existing === undefined || existing.resetAt <= now) {
        if (windows.size >= maxKeys) {
          for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
          // Still full of live windows: refuse rather than grow without
          // bound. Under that much pressure, refusing IS the point.
          if (windows.size >= maxKeys) {
            return { allowed: false, retryAfterSeconds: Math.ceil(options.windowMs / 1000) };
          }
        }
        windows.set(key, { count: 1, resetAt: now + options.windowMs });
        return { allowed: true, retryAfterSeconds: 0 };
      }

      if (existing.count >= options.limit) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
        };
      }

      existing.count++;
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}
