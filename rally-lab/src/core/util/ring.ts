// Fixed-size ring buffer for high-rate data (packets, samples, poses). Screens
// read it at a low rate instead of pushing every item through React state.

export class RingBuffer<T> {
  private buf: (T | undefined)[];
  private head = 0; // next write position
  private count = 0;
  /** Total items ever pushed; lets readers detect what is new. */
  total = 0;

  constructor(readonly capacity: number) {
    this.buf = new Array(capacity);
  }

  push(item: T): void {
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    this.total++;
  }

  get size(): number {
    return this.count;
  }

  /** Oldest first. */
  toArray(): T[] {
    const out: T[] = [];
    const start = (this.head - this.count + this.capacity) % this.capacity;
    for (let i = 0; i < this.count; i++) out.push(this.buf[(start + i) % this.capacity] as T);
    return out;
  }

  /** The last n items, oldest first. */
  last(n: number): T[] {
    const k = Math.min(n, this.count);
    const out: T[] = [];
    for (let i = k; i > 0; i--) out.push(this.buf[(this.head - i + this.capacity) % this.capacity] as T);
    return out;
  }

  /** Items pushed after the reader had seen `seenTotal` items. */
  since(seenTotal: number): T[] {
    const fresh = Math.min(this.total - seenTotal, this.count);
    return fresh > 0 ? this.last(fresh) : [];
  }

  latest(): T | undefined {
    return this.count ? this.buf[(this.head - 1 + this.capacity) % this.capacity] : undefined;
  }

  clear(): void {
    this.buf = new Array(this.capacity);
    this.head = 0;
    this.count = 0;
  }
}
