/**
 * Screen time, measured rather than guessed.
 *
 * Gigsy previously left no trace of how long anyone actually used it:
 * the analytics console had to infer time from gaps between API
 * requests, which undercounts reading, undercounts thinking, and
 * undercounts offline work to nothing at all. This watches the Page
 * Visibility API instead and reports the intervals during which the
 * app was genuinely on screen.
 *
 * Three things make it harder than adding a listener:
 *
 * 1. **Offline.** Gigsy is offline-first; a user can work for an hour
 *    with no connection. Intervals are therefore queued in
 *    localStorage with their original timestamps and flushed whenever
 *    the network returns, not posted as they happen.
 *
 * 2. **The app is killed, not closed.** Phones discard background
 *    tabs without firing anything reliable. So the OPEN interval is
 *    persisted too, and extended on a heartbeat: a kill loses at most
 *    one heartbeat of time, and the next launch closes the orphan at
 *    its last known beat rather than discarding it or — far worse —
 *    counting the hours the phone spent in a pocket.
 *
 * 3. **`visibilitychange` is not enough on its own.** iOS in
 *    particular is unreliable about firing it on app switch, so
 *    `pagehide` closes the interval too, and `blur`/`focus` track
 *    the desktop case where the window is still "visible" but the
 *    user has clicked away to something else. Closing twice is
 *    harmless; never closing is not.
 *
 * Nothing here runs for a signed-out user, and signing out drops the
 * queue: presence belongs to whoever was using the app, and a device
 * that changes hands must not hand the previous person's time to the
 * next one.
 */
import { appLog } from "./logger.ts";

const QUEUE_KEY = "gigsy.presence.queue";
const OPEN_KEY = "gigsy.presence.open";

/**
 * How often the open interval is extended.
 *
 * The upper bound on time lost when the OS kills the app without
 * warning. Thirty seconds trades a little accuracy for very few
 * writes; it is not a network call, only a localStorage update.
 */
export const HEARTBEAT_MS = 30_000;

/** Shorter than this is a flick through the tab strip, not use. The
 *  server applies the same floor — this just avoids the round trip. */
const MIN_INTERVAL_MS = 1000;

/** Queue ceiling. A month offline should not grow without bound; the
 *  oldest go first, because recent presence is the more useful. */
const MAX_QUEUED = 500;

export interface PresenceInterval {
  /**
   * Generated when the interval is queued, and kept across retries.
   *
   * The server stores it as the row key and ignores a repeat, so a
   * flush whose response was lost cannot be counted twice. Double
   * counting is the worst failure mode available here: it is invisible
   * and it looks plausible.
   */
  id: string;
  startedAt: number;
  endedAt: number;
}

/** What `start` needs from the outside world, so tests can drive it. */
export interface PresenceDeps {
  now: () => number;
  /** Injected so tests get stable ids. */
  newId?: () => string;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  send: (intervals: PresenceInterval[]) => Promise<unknown>;
  /** Whether there is a session to attribute time to. */
  isSignedIn: () => boolean;
  isOnline: () => boolean;
}

function readJson<T>(
  storage: PresenceDeps["storage"],
  key: string,
  fallback: T,
): T {
  try {
    const raw = storage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    // Private mode, disabled storage, or something else wrote garbage
    // here. Presence is not worth breaking the app over.
    return fallback;
  }
}

function writeJson(
  storage: PresenceDeps["storage"],
  key: string,
  value: unknown,
): void {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    /* see readJson */
  }
}

/**
 * Removal has to be guarded too, and forgetting that is not a
 * theoretical concern: `close()` runs from a visibilitychange handler,
 * so a browser with storage disabled would have thrown an uncaught
 * error every time the user switched away from the app.
 */
function removeKey(storage: PresenceDeps["storage"], key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    /* see readJson */
  }
}

/**
 * Tracks visibility and reports it.
 *
 * Exported as a class so the wiring below stays a one-liner and the
 * tests can step through it without timers or a DOM.
 */
export class PresenceTracker {
  private openStart: number | null = null;
  /**
   * The flush in progress, if any.
   *
   * Single-flight, and not merely an optimisation: two concurrent
   * flushes both read the same queue, both send it, and the interval
   * is recorded twice. That is not hypothetical — it appeared the
   * first time this ran in a browser, where two listeners raced on one
   * event and produced two identical rows minutes apart in arrival
   * time. The server-side id makes it harmless; this makes it rare.
   */
  private inFlight: Promise<void> | null = null;

  constructor(private readonly deps: PresenceDeps) {}

  private nextId(): string {
    return (this.deps.newId ?? (() => crypto.randomUUID()))();
  }

  /**
   * Close an interval left open by a previous run.
   *
   * The end is the last heartbeat, NOT now: the time between the app
   * being killed and being reopened is not screen time, and counting
   * it would turn an overnight gap into ten hours of use.
   */
  recoverOrphan(): void {
    const open = readJson<{ startedAt: number; lastBeat: number } | null>(
      this.deps.storage,
      OPEN_KEY,
      null,
    );
    if (open === null) return;
    removeKey(this.deps.storage, OPEN_KEY);
    this.enqueue({
      id: this.nextId(),
      startedAt: open.startedAt,
      endedAt: open.lastBeat,
    });
  }

  /** The app came on screen. */
  open(): void {
    if (this.openStart !== null) return;
    if (!this.deps.isSignedIn()) return;
    const now = this.deps.now();
    this.openStart = now;
    writeJson(this.deps.storage, OPEN_KEY, { startedAt: now, lastBeat: now });
  }

  /** Still on screen — extend the persisted interval. */
  beat(): void {
    if (this.openStart === null) return;
    writeJson(this.deps.storage, OPEN_KEY, {
      startedAt: this.openStart,
      lastBeat: this.deps.now(),
    });
  }

  /** The app went off screen. Idempotent: several events can race to
   *  report the same departure, and only the first should count. */
  close(): void {
    if (this.openStart === null) return;
    const startedAt = this.openStart;
    this.openStart = null;
    removeKey(this.deps.storage, OPEN_KEY);
    this.enqueue({ id: this.nextId(), startedAt, endedAt: this.deps.now() });
  }

  private enqueue(interval: PresenceInterval): void {
    if (interval.endedAt - interval.startedAt < MIN_INTERVAL_MS) return;
    const queue = readJson<PresenceInterval[]>(this.deps.storage, QUEUE_KEY, []);
    queue.push(interval);
    writeJson(this.deps.storage, QUEUE_KEY, queue.slice(-MAX_QUEUED));
  }

  /**
   * Send what is queued.
   *
   * The queue is cleared only on success. A failed flush leaves it
   * intact for the next attempt, which is the entire point of writing
   * it down — dropping it on a 500 would lose exactly the offline
   * sessions this exists to capture.
   */
  flush(): Promise<void> {
    this.inFlight ??= this.runFlush().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runFlush(): Promise<void> {
    if (!this.deps.isSignedIn() || !this.deps.isOnline()) return;
    const queue = readJson<PresenceInterval[]>(this.deps.storage, QUEUE_KEY, []);
    if (queue.length === 0) return;

    try {
      await this.deps.send(queue);
      // Re-read rather than assuming: an interval may have been queued
      // while the request was in flight, and writing [] would eat it.
      const after = readJson<PresenceInterval[]>(this.deps.storage, QUEUE_KEY, []);
      writeJson(this.deps.storage, QUEUE_KEY, after.slice(queue.length));
    } catch (error) {
      appLog.warn("presence flush failed, keeping the queue", {
        queued: queue.length,
        error: String(error),
      });
    }
  }

  /** Sign-out: the next person on this device is not this one. */
  discard(): void {
    this.openStart = null;
    removeKey(this.deps.storage, OPEN_KEY);
    removeKey(this.deps.storage, QUEUE_KEY);
  }

  /** Testing seam. */
  isOpen(): boolean {
    return this.openStart !== null;
  }
}

/**
 * Wire a tracker to the browser. Returns a teardown for tests.
 *
 * `visibilitychange` is the primary signal; `pagehide` and `blur`
 * back it up because iOS does not reliably fire the first when the
 * app is switched away from.
 */
export function startPresence(
  tracker: PresenceTracker,
  win: Window = window,
  doc: Document = document,
): () => void {
  const onVisible = (): void => {
    if (doc.visibilityState === "visible") {
      tracker.open();
      void tracker.flush();
    } else {
      tracker.close();
      void tracker.flush();
    }
  };
  const onHide = (): void => {
    tracker.close();
    void tracker.flush();
  };
  // Paired with onHide's `blur`. Without this, the first time the user
  // clicked another window tracking would stop until the next
  // visibilitychange — which on desktop might be never.
  const onFocus = (): void => {
    if (doc.visibilityState === "visible") tracker.open();
  };
  const onOnline = (): void => void tracker.flush();

  tracker.recoverOrphan();
  onVisible();
  void tracker.flush();

  const beat = win.setInterval(() => tracker.beat(), HEARTBEAT_MS);
  doc.addEventListener("visibilitychange", onVisible);
  win.addEventListener("pagehide", onHide);
  win.addEventListener("blur", onHide);
  win.addEventListener("focus", onFocus);
  win.addEventListener("online", onOnline);

  return () => {
    win.clearInterval(beat);
    doc.removeEventListener("visibilitychange", onVisible);
    win.removeEventListener("pagehide", onHide);
    win.removeEventListener("blur", onHide);
    win.removeEventListener("online", onOnline);
  };
}
