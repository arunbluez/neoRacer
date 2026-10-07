// RobotLink ties one transport, one write scheduler and one reply matcher
// together and logs every byte. Everything that talks to the robot goes
// through here.

import { decodeAscii } from '../protocol/ascii';
import { isQuery } from '../protocol/commands';
import { LineSplitter, parseReply, replyValue, type Reply, type ReplyType } from '../protocol/parser';
import type { Logger } from '../log/logger';
import { r1 } from '../log/events';
import type { Clock, DeviceInfo, LinkState, Transport } from '../types';
import { errorMessage, sleep } from '../util/async';
import { RingBuffer } from '../util/ring';
import type { BlockingTable } from './blocking';
import { ReplyMatcher, type MatchResult } from './matcher';
import { CHANNELS, WriteScheduler, type Channel, type SendOptions, type WriteRecord } from './scheduler';
import { LinkStats } from './stats';

export type LinkConfig = {
  minWriteGapMs: number;
  replyTimeoutMs: number;
  packWrites: boolean;
  blocking: BlockingTable;
};

export type QueryResult =
  | (MatchResult & { rec: WriteRecord })
  | { status: 'dropped' | 'error' | 'rejected'; cmd: string; rec: WriteRecord };

export type ReplyEvent = { reply: Reply; raw: string; tRx: number; rttMs?: number; cmd?: string };

export type LinkSnapshot = {
  state: LinkState;
  device?: DeviceInfo;
  transport: Transport['kind'];
  writeMode?: string;
  reconnecting: boolean;
  rttLast?: number;
  rttMed: number;
  rttP95: number;
  rttN: number;
  txps: number;
  rxps: number;
  lost: number;
  writeErrors: number;
  reconnects: number;
  queue: Record<Channel, number>;
  queueTotal: number;
  pendingReplies: number;
  busy: boolean;
  busyMs: number;
};

const BACKOFF_MS = [250, 500, 1000, 2000];
const MAX_RECONNECT_TRIES = 10;

export class RobotLink {
  readonly scheduler: WriteScheduler;
  readonly matcher: ReplyMatcher;
  readonly stats = new LinkStats();
  /** Recent parsed replies, for live views. */
  readonly replies = new RingBuffer<ReplyEvent>(4000);
  /** Latest reply of each type. */
  readonly latest = new Map<ReplyType, ReplyEvent>();

  private transport: Transport;
  private offTransport: (() => void)[] = [];
  private splitter = new LineSplitter();
  private _state: LinkState = 'disconnected';
  private _device?: DeviceInfo;
  private userDisconnect = false;
  private reconnecting = false;
  private reconnectToken = 0;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private replyListeners = new Set<(e: ReplyEvent) => void>();
  private stateListeners = new Set<(s: LinkState, info?: { reason?: string; device?: DeviceInfo }) => void>();
  private cfg: LinkConfig;

  constructor(
    transport: Transport,
    private readonly clock: Clock,
    private readonly log: Logger,
    cfg: Partial<LinkConfig> = {},
  ) {
    this.cfg = { minWriteGapMs: 30, replyTimeoutMs: 500, packWrites: false, blocking: {}, ...cfg };
    this.transport = transport;
    this.scheduler = new WriteScheduler((b) => this.transport.write(b), clock, {
      minWriteGapMs: this.cfg.minWriteGapMs,
      packWrites: this.cfg.packWrites,
      blocking: this.cfg.blocking,
    });
    this.scheduler.setEnabled(false);
    this.matcher = new ReplyMatcher(clock, this.cfg.replyTimeoutMs);
    this.scheduler.on((e) => this.onScheduler(e));
    this.matcher.onLost((r) => {
      this.stats.lost++;
      this.log.log('ble.err', { op: 'reply', message: 'timeout', cmd: r.cmd, waitedMs: Math.round(r.waitedMs) });
    });
    this.attach(transport);
  }

  get state(): LinkState {
    return this._state;
  }

  get connected(): boolean {
    return this._state === 'connected';
  }

  get device(): DeviceInfo | undefined {
    return this._device;
  }

  get transportKind(): Transport['kind'] {
    return this.transport.kind;
  }

  get config(): LinkConfig {
    return this.cfg;
  }

  configure(patch: Partial<LinkConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
    this.scheduler.setConfig({
      minWriteGapMs: this.cfg.minWriteGapMs,
      packWrites: this.cfg.packWrites,
      blocking: this.cfg.blocking,
    });
    this.matcher.defaultTimeoutMs = this.cfg.replyTimeoutMs;
  }

  /** Swap the transport (real robot vs mock). Disconnects first. */
  async setTransport(t: Transport): Promise<void> {
    if (t === this.transport) return;
    await this.disconnect();
    for (const off of this.offTransport) off();
    this.offTransport = [];
    this.transport = t;
    this.attach(t);
  }

  onReply(cb: (e: ReplyEvent) => void): () => void {
    this.replyListeners.add(cb);
    return () => this.replyListeners.delete(cb);
  }

  onState(cb: (s: LinkState, info?: { reason?: string; device?: DeviceInfo }) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  async connect(): Promise<DeviceInfo> {
    this.userDisconnect = false;
    this.reconnectToken++;
    const t0 = this.clock.now();
    this.setState('connecting');
    this.log.log('ble.state', { state: 'connecting', transport: this.transport.kind });
    try {
      const dev = await this.transport.connect();
      this.onConnected(dev, t0, 'connect');
      return dev;
    } catch (err) {
      this.log.log('ble.err', { op: 'connect', message: errorMessage(err) });
      this.setState('disconnected', { reason: errorMessage(err) });
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.userDisconnect = true;
    this.reconnectToken++;
    this.reconnecting = false;
    if (this._state === 'disconnected') return;
    try {
      await this.transport.disconnect();
    } catch (err) {
      this.log.log('ble.err', { op: 'disconnect', message: errorMessage(err) });
    }
    // The transport's own state event may already have handled it.
    if (this.state !== 'disconnected') this.onDisconnected('user');
  }

  send(command: string, opts: SendOptions = {}): Promise<WriteRecord> {
    return this.scheduler.send(command, opts);
  }

  /** Stop the motors through the safety channel. */
  stop(): Promise<WriteRecord> {
    return this.scheduler.send('S', { ch: 'safety' });
  }

  /** Send a query and wait for its reply (or its timeout). */
  async query(command: string, opts: SendOptions = {}): Promise<QueryResult> {
    const rec = await this.scheduler.send(command, { ch: 'query', ...opts });
    if (rec.status !== 'done') {
      const status = rec.status === 'error' ? 'error' : rec.status === 'rejected' ? 'rejected' : 'dropped';
      return { status, cmd: command, rec };
    }
    const m = await this.matcher.wait(rec.id, rec.cmds[0]);
    return { ...m, rec };
  }

  /** Wait for the replies of every query inside a sent (possibly packed) write. */
  async repliesOf(rec: WriteRecord): Promise<MatchResult[]> {
    const seen = new Map<string, number>();
    const waits: Promise<MatchResult>[] = [];
    for (const c of rec.cmds) {
      if (!isQuery(c)) continue;
      const nth = seen.get(c) ?? 0;
      seen.set(c, nth + 1);
      waits.push(this.matcher.wait(rec.id, c, nth));
    }
    return Promise.all(waits);
  }

  snapshot(): LinkSnapshot {
    const now = this.clock.now();
    const rtt = this.stats.rttSummary(now);
    const queue = this.scheduler.depths();
    return {
      state: this._state,
      device: this._device,
      transport: this.transport.kind,
      writeMode: this.transport.writeMode,
      reconnecting: this.reconnecting,
      rttLast: rtt.last,
      rttMed: rtt.median,
      rttP95: rtt.p95,
      rttN: rtt.n,
      txps: this.stats.txps(now),
      rxps: this.stats.rxps(now),
      lost: this.stats.lost,
      writeErrors: this.stats.writeErrors,
      reconnects: this.stats.reconnects,
      queue,
      queueTotal: CHANNELS.reduce((n, ch) => n + queue[ch], 0),
      pendingReplies: this.matcher.pending,
      busy: this.scheduler.isBusy(now),
      busyMs: Math.max(0, this.scheduler.busyUntil - now),
    };
  }

  private attach(t: Transport): void {
    this.offTransport.push(
      t.onData((chunk, tMs) => this.onData(chunk, tMs)),
      t.onState((s, reason) => {
        if (s === 'disconnected' && this._state !== 'disconnected' && !this.reconnecting) {
          this.onDisconnected(this.userDisconnect ? 'user' : reason ?? 'gattserverdisconnected');
        }
      }),
    );
  }

  private setState(s: LinkState, info?: { reason?: string; device?: DeviceInfo }): void {
    this._state = s;
    for (const cb of this.stateListeners) cb(s, info);
  }

  private onConnected(dev: DeviceInfo, t0: number, how: 'connect' | 'reconnect'): void {
    this._device = dev;
    this.splitter.reset();
    this.scheduler.setEnabled(true);
    const durMs = Math.round(this.clock.now() - t0);
    this.log.log('ble.state', {
      state: 'connected', reason: how, durMs, name: dev.name, id: dev.id,
      transport: this.transport.kind, writeMode: this.transport.writeMode,
    });
    this.setState('connected', { device: dev });
    this.startStats();
  }

  private onDisconnected(reason: string): void {
    const tDrop = this.clock.now();
    this.scheduler.setEnabled(false);
    this.matcher.cancelAll();
    this.splitter.reset();
    this.stopStats();
    this.log.log('ble.state', { state: 'disconnected', reason });
    this.setState('disconnected', { reason });
    if (!this.userDisconnect && this.transport.reconnect) void this.reconnectLoop(tDrop);
  }

  private async reconnectLoop(tDrop: number): Promise<void> {
    const token = ++this.reconnectToken;
    this.reconnecting = true;
    this.setState('connecting', { reason: 'reconnect' });
    for (let i = 0; i < MAX_RECONNECT_TRIES; i++) {
      await sleep(BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)]);
      if (token !== this.reconnectToken) return;
      this.log.log('ble.state', { state: 'connecting', reason: 'reconnect', attempt: i + 1 });
      try {
        const dev = await this.transport.reconnect!();
        if (token !== this.reconnectToken) return;
        this.reconnecting = false;
        this.stats.reconnects++;
        this.onConnected(dev, tDrop, 'reconnect');
        return;
      } catch (err) {
        this.log.log('ble.err', { op: 'reconnect', message: errorMessage(err), attempt: i + 1 });
      }
    }
    if (token !== this.reconnectToken) return;
    this.reconnecting = false;
    this.log.log('ble.state', { state: 'disconnected', reason: 'reconnect failed', durMs: Math.round(this.clock.now() - tDrop) });
    this.setState('disconnected', { reason: 'reconnect failed' });
  }

  private onScheduler(e: Parameters<Parameters<WriteScheduler['on']>[0]>[0]): void {
    const rec = e.rec;
    if (e.phase === 'sent') {
      for (const c of rec.cmds) {
        if (isQuery(c)) this.matcher.expect(c, rec.id, rec.tEnq, rec.tSent!, rec.replyTimeoutMs);
      }
      return;
    }
    const cmd = rec.cmds.length === 1 ? rec.cmds[0] : rec.payload;
    if (e.phase === 'done') {
      this.stats.addTx(rec.tDone!);
      const fields: Record<string, unknown> = {
        cmd, ch: rec.ch, bytes: rec.bytes,
        tEnq: this.log.rel(rec.tEnq), tSent: this.log.rel(rec.tSent), tDone: this.log.rel(rec.tDone),
      };
      if (rec.packId !== undefined) fields.packId = rec.packId;
      if (rec.mergedFrom) fields.mergedFrom = rec.mergedFrom;
      if (rec.blockMs > 0) fields.blockMs = rec.blockMs;
      if (rec.status === 'error') fields.err = rec.error;
      this.log.log('ble.tx', fields, rec.tDone);
      if (rec.status === 'error') {
        this.stats.writeErrors++;
        this.matcher.markFailed(rec.id);
        this.log.log('ble.err', { op: 'write', message: rec.error, cmd });
      } else {
        this.matcher.markDone(rec.id, rec.tDone!);
      }
      return;
    }
    // dropped: coalesced, cleared or rejected — never went out.
    if (rec.status === 'coalesced') this.stats.coalesced++;
    if (rec.status === 'rejected') this.stats.rejected++;
    this.log.log('ble.drop', { cmd, ch: rec.ch, status: rec.status, ...(rec.error ? { message: rec.error } : {}) });
    if (rec.status === 'rejected' && rec.error !== 'not connected') {
      this.log.log('ble.err', { op: 'write', message: rec.error, cmd });
    }
  }

  private onData(chunk: Uint8Array, tRx: number): void {
    this.stats.addRx(tRx);
    for (const raw of this.splitter.push(decodeAscii(chunk))) {
      this.log.log('ble.rx', { raw }, tRx);
      const reply = parseReply(raw);
      const m = this.matcher.onReply(reply, tRx);
      const ev: ReplyEvent = { reply, raw, tRx, rttMs: m?.rttMs, cmd: m?.cmd };
      if (m) this.stats.addRtt(tRx, m.rttMs, m.cmd);
      if (reply.type === 'raw') this.stats.garbled++;
      const fields: Record<string, unknown> = { type: reply.type, value: replyValue(reply) };
      if (m) {
        fields.rttMs = r1(m.rttMs);
        if (m.early) fields.early = true;
      }
      this.log.log('sensor', fields, tRx);
      this.replies.push(ev);
      this.latest.set(reply.type, ev);
      for (const cb of this.replyListeners) cb(ev);
    }
  }

  private startStats(): void {
    this.stopStats();
    this.statsTimer = setInterval(() => {
      const s = this.snapshot();
      this.log.log('link.stats', {
        rttMed: r1(s.rttMed), rttP95: r1(s.rttP95), txps: r1(s.txps), rxps: r1(s.rxps),
        lost: s.lost, errors: s.writeErrors, queue: s.queue, busy: s.busy,
      });
    }, 1000);
  }

  private stopStats(): void {
    if (this.statsTimer !== null) clearInterval(this.statsTimer);
    this.statsTimer = null;
  }
}
