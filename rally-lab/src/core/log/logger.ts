// The logger stamps events with session time, keeps the recent ones in a ring
// buffer for the UI, and flushes batches to every sink once per second.

import { RingBuffer } from '../util/ring';
import type { Clock, LogSink } from '../types';
import type { LogEvent, LogKind } from './events';

export type SinkState = { name: string; ok: boolean | null; lastError?: string; lastOkAt?: number; pending: number };

export class Logger {
  readonly ring: RingBuffer<LogEvent>;
  private t0: number;
  private _sessionId = '';
  private batch: LogEvent[] = [];
  private sinks: LogSink[] = [];
  private sinkState = new Map<string, SinkState>();
  private listeners = new Set<(e: LogEvent) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;
  /** Events per kind in this session. */
  readonly counts = new Map<string, number>();

  constructor(private readonly clock: Clock, ringSize = 5000) {
    this.ring = new RingBuffer<LogEvent>(ringSize);
    this.t0 = clock.now();
  }

  get sessionId(): string {
    return this._sessionId;
  }

  /** Clock time at which the session started. */
  get sessionStart(): number {
    return this.t0;
  }

  /** Session time now, ms. */
  now(): number {
    return this.clock.now() - this.t0;
  }

  /** Convert a clock time to session time. */
  rel(tClock: number | undefined): number | undefined {
    return tClock === undefined ? undefined : Math.round((tClock - this.t0) * 10) / 10;
  }

  /** Start logging into a new session. Pending events of the old one are flushed first. */
  async startSession(id: string): Promise<void> {
    await this.flush();
    this._sessionId = id;
    this.t0 = this.clock.now();
    this.counts.clear();
    this.ring.clear();
  }

  log(k: LogKind | string, fields: Record<string, unknown> = {}, tClock?: number): LogEvent {
    const t = tClock === undefined ? this.now() : tClock - this.t0;
    const e: LogEvent = { t: Math.round(t * 10) / 10, k, ...fields };
    this.ring.push(e);
    this.batch.push(e);
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
    for (const cb of this.listeners) cb(e);
    return e;
  }

  subscribe(cb: (e: LogEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  addSink(sink: LogSink): void {
    this.sinks.push(sink);
    this.sinkState.set(sink.name, { name: sink.name, ok: null, pending: 0 });
  }

  sinkStates(): SinkState[] {
    return [...this.sinkState.values()];
  }

  get pendingCount(): number {
    return this.batch.length;
  }

  startAutoFlush(intervalMs = 1000): void {
    this.stopAutoFlush();
    this.timer = setInterval(() => void this.flush(), intervalMs);
  }

  stopAutoFlush(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Send the pending batch to every sink. Sinks retry on their own. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing.then(() => this.flush());
    if (this.batch.length === 0 || !this._sessionId) return Promise.resolve();
    const batch = this.batch;
    const sessionId = this._sessionId;
    this.batch = [];
    this.flushing = Promise.all(
      this.sinks.map(async (s) => {
        const st = this.sinkState.get(s.name)!;
        try {
          await s.write(sessionId, batch);
          st.ok = true;
          st.lastOkAt = this.clock.now();
          st.lastError = undefined;
        } catch (err) {
          st.ok = false;
          st.lastError = err instanceof Error ? err.message : String(err);
        }
      }),
    ).then(() => {
      this.flushing = null;
    });
    return this.flushing;
  }
}
