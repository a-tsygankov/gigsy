import { describe, it, expect } from "vitest";
import { RingBuffer } from "./ring-buffer.ts";
import {
  BufferSink,
  Logger,
  installGlobalErrorCapture,
  type LogEntry,
  type LogSink,
} from "./logger.ts";

class CapturingSink implements LogSink {
  entries: LogEntry[] = [];
  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

describe("Logger", () => {
  it("fans a structured entry out to every sink", () => {
    const a = new CapturingSink();
    const b = new CapturingSink();
    const log = new Logger([a, b], () => 42);

    log.info("hello", { k: "v" });

    const expected: LogEntry = { ts: 42, level: "info", msg: "hello", data: { k: "v" } };
    expect(a.entries).toEqual([expected]);
    expect(b.entries).toEqual([expected]);
  });

  it("BufferSink retains only the most recent entries", () => {
    const buffer = new RingBuffer<LogEntry>(2);
    const log = new Logger([new BufferSink(buffer)], () => 0);

    log.info("one");
    log.warn("two");
    log.error("three");

    expect(buffer.toArray().map((e) => [e.level, e.msg])).toEqual([
      ["warn", "two"],
      ["error", "three"],
    ]);
  });
});

describe("installGlobalErrorCapture", () => {
  it("records window 'error' events as error entries", () => {
    const sink = new CapturingSink();
    const log = new Logger([sink], () => 0);
    const target = new EventTarget();
    installGlobalErrorCapture(log, target);

    const event = Object.assign(new Event("error"), { message: "boom" });
    target.dispatchEvent(event);

    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0]?.level).toBe("error");
    expect(sink.entries[0]?.msg).toContain("boom");
  });

  it("records unhandled promise rejections", () => {
    const sink = new CapturingSink();
    const log = new Logger([sink], () => 0);
    const target = new EventTarget();
    installGlobalErrorCapture(log, target);

    const event = Object.assign(new Event("unhandledrejection"), {
      reason: new Error("nope"),
    });
    target.dispatchEvent(event);

    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0]?.level).toBe("error");
    expect(sink.entries[0]?.msg).toContain("nope");
  });

  it("returns an uninstall function", () => {
    const sink = new CapturingSink();
    const log = new Logger([sink], () => 0);
    const target = new EventTarget();
    const uninstall = installGlobalErrorCapture(log, target);

    uninstall();
    target.dispatchEvent(Object.assign(new Event("error"), { message: "late" }));

    expect(sink.entries).toHaveLength(0);
  });
});
