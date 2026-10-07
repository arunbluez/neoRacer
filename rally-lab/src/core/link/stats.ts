// Rolling link statistics for the header, Monitor and `link.stats` events.

import { RingBuffer } from '../util/ring';
import { quantile } from '../util/stats';

export type RttSample = { t: number; rtt: number; cmd: string };

export class LinkStats {
  readonly rtt = new RingBuffer<RttSample>(4000);
  private tx = new RingBuffer<number>(2000);
  private rx = new RingBuffer<number>(2000);
  lost = 0;
  writeErrors = 0;
  reconnects = 0;
  rejected = 0;
  coalesced = 0;
  garbled = 0;

  constructor(readonly windowMs = 10_000) {}

  addRtt(t: number, rtt: number, cmd: string): void {
    this.rtt.push({ t, rtt, cmd });
  }

  addTx(t: number): void {
    this.tx.push(t);
  }

  addRx(t: number): void {
    this.rx.push(t);
  }

  reset(): void {
    this.rtt.clear();
    this.tx.clear();
    this.rx.clear();
    this.lost = this.writeErrors = this.reconnects = this.rejected = this.coalesced = this.garbled = 0;
  }

  private rate(buf: RingBuffer<number>, now: number, spanMs = 2000): number {
    const recent = buf.last(Math.min(buf.size, 400));
    let n = 0;
    for (let i = recent.length - 1; i >= 0 && now - recent[i] <= spanMs; i--) n++;
    return (n * 1000) / spanMs;
  }

  /** RTT summary over the window, ms. */
  rttSummary(now: number): { last?: number; median: number; p95: number; n: number } {
    const all = this.rtt.last(Math.min(this.rtt.size, 2000));
    const xs: number[] = [];
    for (let i = all.length - 1; i >= 0 && now - all[i].t <= this.windowMs; i--) xs.push(all[i].rtt);
    xs.sort((a, b) => a - b);
    return {
      last: this.rtt.latest()?.rtt,
      median: quantile(xs, 0.5, true),
      p95: quantile(xs, 0.95, true),
      n: xs.length,
    };
  }

  txps(now: number): number {
    return this.rate(this.tx, now);
  }

  rxps(now: number): number {
    return this.rate(this.rx, now);
  }
}
