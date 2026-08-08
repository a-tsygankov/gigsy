/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { RingBuffer } from "../src/lib/ring-buffer.ts";

describe("RingBuffer", () => {
  it("returns items in insertion order", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    expect(buf.toArray()).toEqual([1, 2]);
  });

  it("drops the oldest items beyond capacity", () => {
    const buf = new RingBuffer<number>(3);
    for (const n of [1, 2, 3, 4, 5]) buf.push(n);
    expect(buf.toArray()).toEqual([3, 4, 5]);
  });

  it("reports its size up to capacity", () => {
    const buf = new RingBuffer<string>(2);
    expect(buf.size).toBe(0);
    buf.push("a");
    expect(buf.size).toBe(1);
    buf.push("b");
    buf.push("c");
    expect(buf.size).toBe(2);
  });

  it("rejects a non-positive capacity", () => {
    expect(() => new RingBuffer(0)).toThrow();
  });
});
