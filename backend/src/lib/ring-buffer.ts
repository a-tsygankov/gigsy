/**
 * Fixed-capacity FIFO buffer — keeps the most recent `capacity`
 * items. Backs the in-memory log buffer served by /api/debug/logs.
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
