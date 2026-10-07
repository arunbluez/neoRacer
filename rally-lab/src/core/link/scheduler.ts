// The write scheduler is the only thing that writes to the robot. It keeps
// exactly one GATT write in flight, spaces writes by `minWriteGapMs`, orders
// them by channel priority, coalesces where newer commands make older unsent
// ones pointless, and holds traffic while the firmware is blocked.

import { encodeAscii } from '../protocol/ascii';
import {
  applyMotor, cmdName, isQuery, LIGHT_COMMANDS, MAX_WRITE_BYTES, MOTOR_COMMANDS,
  type MotorState,
} from '../protocol/commands';
import type { Clock } from '../types';
import { blockMs, type BlockingTable } from './blocking';

export type Channel = 'safety' | 'motor' | 'query' | 'light' | 'oneshot' | 'raw';
/** Highest priority first. */
export const CHANNELS: Channel[] = ['safety', 'motor', 'query', 'light', 'oneshot', 'raw'];

export function classify(command: string): Channel {
  const name = cmdName(command);
  if (name === 'S') return 'safety';
  if (MOTOR_COMMANDS.includes(name)) return 'motor';
  if (isQuery(command)) return 'query';
  if (LIGHT_COMMANDS.includes(name)) return 'light';
  return 'oneshot';
}

export type SendOptions = {
  /** Defaults to classify(command). */
  ch?: Channel;
  /** Send the text exactly as given (it may hold several '#'-terminated commands). Raw channel only. */
  literal?: boolean;
  /** Ignore the blocking hold (used by tests that measure it). */
  bypassHold?: boolean;
  /** Never pack this command with others. */
  noPack?: boolean;
  /** How long to wait for the reply of a query (defaults to the link setting). */
  replyTimeoutMs?: number;
};

export type WriteStatus = 'queued' | 'sending' | 'done' | 'coalesced' | 'cleared' | 'rejected' | 'error';

export type WriteRecord = {
  id: number;
  /** Text on the wire, terminators included. */
  payload: string;
  /** Commands in this payload, without terminators. */
  cmds: string[];
  ch: Channel;
  bytes: number;
  tEnq: number;
  tSent?: number;
  tDone?: number;
  status: WriteStatus;
  error?: string;
  /** Set when several commands went out in one write. */
  packId?: number;
  blockMs: number;
  bypassHold: boolean;
  noPack: boolean;
  literal: boolean;
  /** Set on a motor write that absorbed ML/MR commands. */
  mergedFrom?: string[];
  replyTimeoutMs?: number;
};

export type SchedulerConfig = {
  minWriteGapMs: number;
  packWrites: boolean;
  holdPadMs: number;
  blocking: BlockingTable;
};

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  minWriteGapMs: 30,
  packWrites: false,
  holdPadMs: 20,
  blocking: {},
};

export type SchedulerEvent =
  | { phase: 'sent'; rec: WriteRecord }
  | { phase: 'done'; rec: WriteRecord }
  | { phase: 'dropped'; rec: WriteRecord };

type Item = { rec: WriteRecord; resolve: (r: WriteRecord) => void; promise: Promise<WriteRecord> };

export type WriteFn = (bytes: Uint8Array) => Promise<void>;

/** Light commands each new light command makes pointless if still unsent. */
const LIGHT_SUPERSEDES: Record<string, string[]> = {
  HL: ['HL', 'HLL', 'HLR'],
  HLL: ['HLL'],
  HLR: ['HLR'],
  UG: ['UG', 'UGL', 'UGR'],
  UGL: ['UGL'],
  UGR: ['UGR'],
  UGO: ['UG', 'UGL', 'UGR', 'UGO'],
  HO: LIGHT_COMMANDS,
};

export class WriteScheduler {
  private cfg: SchedulerConfig;
  private queues: Record<Channel, Item[]> = {
    safety: [], motor: [], query: [], light: [], oneshot: [], raw: [],
  };
  private inFlight: Item[] | null = null;
  private lastSentAt = -Infinity;
  private holdUntil = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAt = Infinity;
  private nextId = 1;
  private nextPackId = 1;
  private enabled = true;
  private listeners = new Set<(e: SchedulerEvent) => void>();
  /** Wheel speeds after the last motor write that went out. */
  private sentMotor: MotorState = { l: 0, r: 0 };

  constructor(
    private readonly write: WriteFn,
    private readonly clock: Clock,
    cfg: Partial<SchedulerConfig> = {},
  ) {
    this.cfg = { ...DEFAULT_SCHEDULER_CONFIG, ...cfg };
  }

  get config(): SchedulerConfig {
    return this.cfg;
  }

  setConfig(patch: Partial<SchedulerConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
    this.pump();
  }

  on(cb: (e: SchedulerEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Accept writes (connected) or reject them (disconnected). Disabling clears the queues. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.clear();
      this.holdUntil = -Infinity;
      this.sentMotor = { l: 0, r: 0 };
    } else {
      this.pump();
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Busy (holding for a blocking command) until this clock time. */
  get busyUntil(): number {
    return this.holdUntil;
  }

  isBusy(now = this.clock.now()): boolean {
    return now < this.holdUntil;
  }

  get motorState(): MotorState {
    return this.sentMotor;
  }

  depths(): Record<Channel, number> {
    const d = {} as Record<Channel, number>;
    for (const ch of CHANNELS) d[ch] = this.queues[ch].length;
    return d;
  }

  get depth(): number {
    return CHANNELS.reduce((n, ch) => n + this.queues[ch].length, 0) + (this.inFlight ? 1 : 0);
  }

  get writing(): boolean {
    return this.inFlight !== null;
  }

  send(command: string, opts: SendOptions = {}): Promise<WriteRecord> {
    const literal = !!opts.literal;
    const ch: Channel = literal ? 'raw' : opts.ch ?? classify(command);
    const payload = literal ? (command.endsWith('#') ? command : command + '#') : command.trim() + '#';
    const cmds = payload.split('#').map((c) => c.trim()).filter((c) => c.length > 0);
    const rec: WriteRecord = {
      id: this.nextId++,
      payload,
      cmds,
      ch,
      bytes: payload.length,
      tEnq: this.clock.now(),
      status: 'queued',
      blockMs: cmds.reduce((ms, c) => ms + blockMs(c, this.cfg.blocking), 0),
      bypassHold: !!opts.bypassHold,
      noPack: !!opts.noPack || literal,
      literal,
      replyTimeoutMs: opts.replyTimeoutMs,
    };

    if (!this.enabled) return Promise.resolve(this.finish(rec, 'rejected', 'not connected'));
    if (cmds.length === 0) return Promise.resolve(this.finish(rec, 'rejected', 'empty command'));
    if (rec.bytes > MAX_WRITE_BYTES) {
      return Promise.resolve(this.finish(rec, 'rejected', `${rec.bytes} bytes exceeds the ${MAX_WRITE_BYTES}-byte write limit`));
    }

    const q = this.queues[ch];
    let item: Item;
    switch (ch) {
      case 'safety': {
        // Stop makes any unsent motor command pointless.
        for (const old of this.queues.motor.splice(0)) this.drop(old, 'coalesced');
        const dup = q.find((i) => i.rec.payload === payload);
        if (dup) return dup.promise;
        item = this.makeItem(rec);
        q.push(item);
        break;
      }
      case 'motor': {
        const old = q.shift();
        if (old) {
          const name = cmdName(command);
          if (name === 'ML' || name === 'MR') {
            // ML/MR keep the other wheel; fold them into one MS so nothing is lost.
            const merged = applyMotor(command, applyMotor(old.rec.cmds[0], this.sentMotor));
            const text = `MS,${merged.l},${merged.r}`;
            rec.payload = text + '#';
            rec.cmds = [text];
            rec.bytes = rec.payload.length;
            rec.mergedFrom = [...(old.rec.mergedFrom ?? old.rec.cmds), command];
          }
          this.drop(old, 'coalesced');
        }
        item = this.makeItem(rec);
        q.push(item);
        break;
      }
      case 'query': {
        const dup = q.find((i) => i.rec.payload === payload && i.rec.bypassHold === rec.bypassHold);
        if (dup) return dup.promise;
        item = this.makeItem(rec);
        q.push(item);
        break;
      }
      case 'light': {
        const kills = LIGHT_SUPERSEDES[cmdName(command)] ?? [cmdName(command)];
        for (let i = q.length - 1; i >= 0; i--) {
          if (kills.includes(cmdName(q[i].rec.cmds[0]))) this.drop(q.splice(i, 1)[0], 'coalesced');
        }
        item = this.makeItem(rec);
        q.push(item);
        break;
      }
      default:
        item = this.makeItem(rec);
        q.push(item);
    }
    this.pump();
    return item.promise;
  }

  /** Drop everything unsent. */
  clear(ch?: Channel): void {
    for (const c of ch ? [ch] : CHANNELS) {
      for (const old of this.queues[c].splice(0)) this.drop(old, 'cleared');
    }
  }

  private makeItem(rec: WriteRecord): Item {
    let resolve!: (r: WriteRecord) => void;
    const promise = new Promise<WriteRecord>((r) => (resolve = r));
    return { rec, resolve, promise };
  }

  private finish(rec: WriteRecord, status: WriteStatus, error?: string): WriteRecord {
    rec.status = status;
    if (error) rec.error = error;
    this.emit({ phase: 'dropped', rec });
    return rec;
  }

  private drop(item: Item, status: 'coalesced' | 'cleared'): void {
    item.resolve(this.finish(item.rec, status));
  }

  private emit(e: SchedulerEvent): void {
    for (const cb of this.listeners) cb(e);
  }

  private eligible(item: Item, held: boolean): boolean {
    return !held || item.rec.ch === 'safety' || item.rec.bypassHold;
  }

  /** The channel whose head goes next, or null. */
  private pickChannel(held: boolean): Channel | null {
    for (const ch of CHANNELS) {
      const head = this.queues[ch][0];
      if (head && this.eligible(head, held)) return ch;
    }
    return null;
  }

  private arm(at: number): void {
    if (this.timer !== null && this.timerAt <= at) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timerAt = at;
    const delay = Math.max(0, at - this.clock.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerAt = Infinity;
      this.pump();
    }, delay);
  }

  private pump(): void {
    if (this.inFlight || !this.enabled) return;
    const now = this.clock.now();
    const held = now < this.holdUntil;
    const ch = this.pickChannel(held);
    if (ch === null) {
      // Something is waiting for the hold to end.
      if (held && this.depth > 0) this.arm(this.holdUntil);
      return;
    }
    const earliest = this.lastSentAt + this.cfg.minWriteGapMs;
    if (now < earliest) {
      this.arm(earliest);
      return;
    }

    const batch = [this.queues[ch].shift()!];
    if (this.cfg.packWrites && !batch[0].rec.noPack && batch[0].rec.blockMs === 0) {
      let bytes = batch[0].rec.bytes;
      for (;;) {
        const next = this.pickChannel(held);
        if (next === null) break;
        const head = this.queues[next][0];
        if (head.rec.noPack || bytes + head.rec.bytes > MAX_WRITE_BYTES) break;
        batch.push(this.queues[next].shift()!);
        bytes += head.rec.bytes;
        if (head.rec.blockMs > 0) break; // nothing may follow a blocking command in one write
      }
    }
    this.startWrite(batch, now);
  }

  private startWrite(batch: Item[], now: number): void {
    this.inFlight = batch;
    this.lastSentAt = now;
    const packId = batch.length > 1 ? this.nextPackId++ : undefined;
    for (const item of batch) {
      item.rec.tSent = now;
      item.rec.status = 'sending';
      item.rec.packId = packId;
      for (const c of item.rec.cmds) {
        if (MOTOR_COMMANDS.includes(cmdName(c)) || c === 'S') this.sentMotor = applyMotor(c, this.sentMotor);
      }
      this.emit({ phase: 'sent', rec: item.rec });
    }
    const payload = batch.map((i) => i.rec.payload).join('');
    let settled = false;
    const settle = (err?: unknown) => {
      if (settled) return;
      settled = true;
      const tDone = this.clock.now();
      this.inFlight = null;
      const block = batch.reduce((ms, i) => ms + i.rec.blockMs, 0);
      if (!err && block > 0) this.holdUntil = Math.max(this.holdUntil, tDone + block + this.cfg.holdPadMs);
      for (const item of batch) {
        item.rec.tDone = tDone;
        item.rec.status = err ? 'error' : 'done';
        if (err) item.rec.error = err instanceof Error ? err.message : String(err);
        this.emit({ phase: 'done', rec: item.rec });
        item.resolve(item.rec);
      }
      this.pump();
    };
    try {
      this.write(encodeAscii(payload)).then(() => settle(), (e: unknown) => settle(e ?? new Error('write failed')));
    } catch (err) {
      settle(err ?? new Error('write failed'));
    }
  }
}
