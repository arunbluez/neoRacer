// A poller sends a set of queries at fixed rates through the `query` channel.
// The channel drops unsent duplicates, so a slow link never builds a backlog.

import type { PollerEntry } from '../settings';
import type { RobotLink } from './link';

export class Poller {
  private timers: ReturnType<typeof setInterval>[] = [];
  private _entries: PollerEntry[] = [];
  private _source = 'none';

  constructor(private readonly link: Pick<RobotLink, 'send' | 'connected'>) {}

  get entries(): PollerEntry[] {
    return this._entries;
  }

  /** Who set the current entries (a screen or a test). */
  get source(): string {
    return this._source;
  }

  /** Replace the polled queries. Returns the previous set so callers can restore it. */
  set(entries: PollerEntry[], source = 'ui'): { entries: PollerEntry[]; source: string } {
    const prev = { entries: this._entries, source: this._source };
    this.clearTimers();
    this._entries = entries.filter((e) => e.hz > 0 && e.cmd.trim().length > 0);
    this._source = source;
    for (const e of this._entries) {
      const period = Math.max(5, 1000 / e.hz);
      this.timers.push(setInterval(() => {
        if (this.link.connected) void this.link.send(e.cmd, { ch: 'query' });
      }, period));
    }
    return prev;
  }

  stop(): void {
    this.set([], 'stopped');
  }

  private clearTimers(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
