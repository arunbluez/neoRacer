// Live sync to the laptop during development: when the Vite dev server
// answers GET /__log, event batches go to POST /__log once per second and
// files to POST /__artifact. Grey when there is no dev server, red when
// posting fails (failed batches are retried).

import type { LogEvent } from '../../core/log/events';
import type { LogSink } from '../../core/types';

export type SyncState = 'off' | 'ok' | 'failing';

const MAX_BACKLOG = 50_000;

function base(): string {
  return import.meta.env.BASE_URL.replace(/\/$/, '');
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

export class DevSync implements LogSink {
  readonly name = 'dev';
  private enabled = false;
  private _state: SyncState = 'off';
  private backlog: { sessionId: string; events: LogEvent[] }[] = [];
  private lastProbe = 0;
  private listeners = new Set<(s: SyncState) => void>();
  lastError?: string;
  sentEvents = 0;

  /** Only the dev build talks to the dev server. */
  constructor(private readonly allowed = import.meta.env.DEV) {}

  get state(): SyncState {
    return this._state;
  }

  subscribe(cb: (s: SyncState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private setState(s: SyncState): void {
    if (s === this._state) return;
    this._state = s;
    for (const cb of this.listeners) cb(s);
  }

  async probe(): Promise<boolean> {
    if (!this.allowed) return false;
    this.lastProbe = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch(`${base()}/__log`, { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(timer);
      this.enabled = res.ok && (res.headers.get('content-type') ?? '').includes('json');
    } catch {
      this.enabled = false;
    }
    this.setState(this.enabled ? 'ok' : 'off');
    return this.enabled;
  }

  async write(sessionId: string, batch: LogEvent[]): Promise<void> {
    if (!this.allowed) return;
    if (!this.enabled) {
      if (Date.now() - this.lastProbe > 10_000) void this.probe();
      return;
    }
    this.backlog.push({ sessionId, events: batch });
    let total = this.backlog.reduce((n, b) => n + b.events.length, 0);
    while (total > MAX_BACKLOG && this.backlog.length > 1) total -= this.backlog.shift()!.events.length;
    while (this.backlog.length) {
      const next = this.backlog[0];
      try {
        const res = await fetch(`${base()}/__log`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(next),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.backlog.shift();
        this.sentEvents += next.events.length;
        this.setState('ok');
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        this.setState('failing');
        throw err;
      }
    }
  }

  /** Write a file to logs/<sessionId>/<path>. JSON values are pretty-printed. */
  async artifact(sessionId: string, path: string, data: unknown): Promise<void> {
    if (!this.allowed || !this.enabled) return;
    const body = data instanceof Uint8Array
      ? { sessionId, path, encoding: 'base64', data: toBase64(data) }
      : { sessionId, path, encoding: 'utf8', data: typeof data === 'string' ? data : JSON.stringify(data, null, 2) };
    try {
      const res = await fetch(`${base()}/__artifact`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.setState('failing');
    }
  }
}
