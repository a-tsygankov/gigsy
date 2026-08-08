/**
 * Structured logging with pluggable sinks (single responsibility per
 * sink; Logger only fans out). The app-wide singleton writes to the
 * console (Workers Logs ingests the JSON lines) AND to a per-isolate
 * ring buffer that /api/debug/logs exposes to the hidden console.
 *
 * The buffer is per-isolate and in-memory: it resets on isolate
 * recycle and each isolate has its own — best-effort recent history,
 * which is exactly what a debug console needs, not an audit log.
 */
import { RingBuffer } from "./lib/ring-buffer.ts";

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
    const line = JSON.stringify(entry);
    if (entry.level === "error") console.error(line);
    else if (entry.level === "warn") console.warn(line);
    else console.log(line);
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

/** Recent log lines for the debug console (capacity is a tuning knob,
 * not a contract). */
export const logBuffer = new RingBuffer<LogEntry>(200);

/** App-wide logger: console + debug buffer. */
export const log = new Logger([new ConsoleSink(), new BufferSink(logBuffer)]);
