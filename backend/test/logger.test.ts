/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { RingBuffer } from "../src/lib/ring-buffer.ts";
import {
  BufferSink,
  Logger,
  type LogEntry,
  type LogSink,
} from "../src/logger.ts";

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
    const log = new Logger([a, b], () => 1234);

    log.info("hello", { path: "/x" });

    const expected: LogEntry = {
      ts: 1234,
      level: "info",
      msg: "hello",
      data: { path: "/x" },
    };
    expect(a.entries).toEqual([expected]);
    expect(b.entries).toEqual([expected]);
  });

  it("records the level for warn and error", () => {
    const sink = new CapturingSink();
    const log = new Logger([sink], () => 0);

    log.warn("careful");
    log.error("boom");

    expect(sink.entries.map((e) => e.level)).toEqual(["warn", "error"]);
  });

  it("BufferSink retains the most recent entries in its ring buffer", () => {
    const buffer = new RingBuffer<LogEntry>(2);
    const log = new Logger([new BufferSink(buffer)], () => 0);

    log.info("one");
    log.info("two");
    log.info("three");

    expect(buffer.toArray().map((e) => e.msg)).toEqual(["two", "three"]);
  });
});
