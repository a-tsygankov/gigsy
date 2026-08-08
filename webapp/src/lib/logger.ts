/**
 * Client-side structured logging with pluggable sinks — same shape as
 * the worker's logger so the hidden console renders both feeds
 * uniformly. The app singleton writes to the devtools console AND to
 * a ring buffer the console displays.
 */
import { RingBuffer } from "./ring-buffer.ts";

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  ts: number;
  level: LogLevel;
  msg: string;
  data?: Record<string, unknown>;
}

export interface LogSink {
  write(entry: LogEntry): void;
}

export class ConsoleSink implements LogSink {
  write(entry: LogEntry): void {
    const args = entry.data ? [entry.msg, entry.data] : [entry.msg];
    if (entry.level === "error") console.error(...args);
    else if (entry.level === "warn") console.warn(...args);
    else console.info(...args);
  }
}

export class BufferSink implements LogSink {
  constructor(private readonly buffer: RingBuffer<LogEntry>) {}
  write(entry: LogEntry): void {
    this.buffer.push(entry);
  }
}

export class Logger {
  constructor(
    private readonly sinks: LogSink[],
    private readonly clock: () => number = Date.now,
  ) {}

  info(msg: string, data?: Record<string, unknown>): void {
    this.write("info", msg, data);
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.write("warn", msg, data);
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.write("error", msg, data);
  }

  private write(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    const entry: LogEntry = { ts: this.clock(), level, msg, ...(data ? { data } : {}) };
    for (const sink of this.sinks) sink.write(entry);
  }
}

/**
 * Route uncaught errors + unhandled rejections into the logger so the
 * hidden console shows crashes the user would otherwise never see on
 * a phone. Returns an uninstall function (symmetry + tests).
 */
export function installGlobalErrorCapture(
  logger: Logger,
  target: EventTarget,
): () => void {
  const onError = (event: Event): void => {
    const message = (event as ErrorEvent).message ?? "Unknown error";
    logger.error(`Uncaught error: ${message}`);
  };
  const onRejection = (event: Event): void => {
    const reason = (event as PromiseRejectionEvent).reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    logger.error(`Unhandled rejection: ${message}`);
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}

/** Recent client log lines for the hidden console. */
export const clientLogBuffer = new RingBuffer<LogEntry>(200);

/** App-wide client logger: devtools console + hidden-console buffer. */
export const appLog = new Logger([new ConsoleSink(), new BufferSink(clientLogBuffer)]);
