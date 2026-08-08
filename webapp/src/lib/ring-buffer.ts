/**
 * Fixed-capacity FIFO buffer — keeps the most recent `capacity`
 * items. Backs the client-side log history shown in the hidden
 * console. (Mirrors backend/src/lib/ring-buffer.ts — the tiers
 * deploy separately, so the ~20 lines are duplicated rather than
 * coupled through a shared package this early.)
 */
export class RingBuffer<T> {
  private items: T[] = [];

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`RingBuffer capacity must be a positive integer, got ${capacity}`);
    }
  }

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity);
    }
  }

  /** Items oldest → newest. */
  toArray(): T[] {
    return [...this.items];
  }

  get size(): number {
    return this.items.length;
  }
}
