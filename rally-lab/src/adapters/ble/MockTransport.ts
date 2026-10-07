// A simulated robot behind the Transport interface: link latency, jitter
// and loss on top of the firmware emulation and 2D world in core/sim.
// It uses no browser APIs, so unit tests run it too.

import { decodeAscii, encodeAscii } from '../../core/protocol/ascii';
import { SimFirmware, type FirmwareOptions } from '../../core/sim/firmware';
import { rng, SimWorld } from '../../core/sim/world';
import type { Clock, DeviceInfo, LinkState, Transport } from '../../core/types';

export type MockLinkOptions = {
  name: string;
  /** One-way latency phone -> robot and robot -> phone, ms. */
  latencyMs: number;
  jitterMs: number;
  /** Probability that a reply is lost. */
  lossRate: number;
  /** Time for a GATT write to resolve, ms. */
  writeMs: number;
  /** Minimum spacing between indications (one per connection event), ms. */
  indicationGapMs: number;
  connectMs: number;
  seed: number;
  firmware?: Partial<FirmwareOptions>;
};

export const DEFAULT_MOCK_OPTIONS: MockLinkOptions = {
  name: 'BBC micro:bit [mocky]',
  latencyMs: 12,
  jitterMs: 6,
  lossRate: 0,
  writeMs: 4,
  indicationGapMs: 7.5,
  connectMs: 400,
  seed: 7,
};

export class MockTransport implements Transport {
  readonly kind = 'mock' as const;
  readonly writeMode = 'withoutResponse' as const;
  readonly world: SimWorld;
  readonly firmware: SimFirmware;
  opts: MockLinkOptions;
  private dataCbs = new Set<(chunk: Uint8Array, t: number) => void>();
  private stateCbs = new Set<(s: LinkState, reason?: string) => void>();
  private connected = false;
  private nextIndicationAt = 0;
  private lastDeliverAt = 0;
  private rand: () => number;
  /** Bumped on every connect/disconnect so stale timers do nothing. */
  private epoch = 0;

  constructor(private readonly clock: Clock, opts: Partial<MockLinkOptions> = {}, world?: SimWorld) {
    this.opts = { ...DEFAULT_MOCK_OPTIONS, ...opts };
    this.rand = rng(this.opts.seed);
    this.world = world ?? new SimWorld(clock.now());
    this.firmware = new SimFirmware(this.world, clock, (text) => this.indicate(text), this.opts.firmware);
  }

  get isConnected(): boolean {
    return this.connected;
  }

  private jitter(): number {
    return this.opts.latencyMs + (this.rand() * 2 - 1) * this.opts.jitterMs;
  }

  async connect(): Promise<DeviceInfo> {
    const epoch = ++this.epoch;
    this.emitState('connecting');
    await new Promise<void>((r) => setTimeout(r, this.opts.connectMs));
    if (epoch !== this.epoch) throw new Error('connect cancelled');
    this.connected = true;
    this.firmware.onConnected();
    this.emitState('connected');
    return { name: this.opts.name, id: 'mock-device' };
  }

  reconnect(): Promise<DeviceInfo> {
    return this.connect();
  }

  async disconnect(): Promise<void> {
    this.drop('user');
  }

  /** Simulate the link dropping (out of range, robot reset). */
  simulateDrop(reason = 'gattserverdisconnected'): void {
    this.drop(reason);
  }

  private drop(reason: string): void {
    if (!this.connected) return;
    this.epoch++;
    this.connected = false;
    this.firmware.onDisconnected();
    this.emitState('disconnected', reason);
  }

  write(bytes: Uint8Array): Promise<void> {
    if (!this.connected) return Promise.reject(new Error('GATT Server is disconnected'));
    const epoch = this.epoch;
    const text = decodeAscii(bytes);
    // Writes arrive in order even with jitter.
    const at = Math.max(this.clock.now() + this.jitter(), this.lastDeliverAt + 0.1);
    this.lastDeliverAt = at;
    setTimeout(() => {
      if (epoch === this.epoch && this.connected) this.firmware.receive(text);
    }, at - this.clock.now());
    return new Promise((resolve) => setTimeout(resolve, this.opts.writeMs));
  }

  private indicate(text: string): void {
    if (!this.connected) return;
    if (this.rand() < this.opts.lossRate) return;
    const epoch = this.epoch;
    const now = this.clock.now();
    const at = Math.max(now + this.jitter(), this.nextIndicationAt);
    this.nextIndicationAt = at + this.opts.indicationGapMs;
    setTimeout(() => {
      if (epoch !== this.epoch) return;
      const t = this.clock.now();
      for (const cb of this.dataCbs) cb(encodeAscii(text), t);
    }, at - now);
  }

  onData(cb: (chunk: Uint8Array, tMs: number) => void): () => void {
    this.dataCbs.add(cb);
    return () => this.dataCbs.delete(cb);
  }

  onState(cb: (s: LinkState, reason?: string) => void): () => void {
    this.stateCbs.add(cb);
    return () => this.stateCbs.delete(cb);
  }

  private emitState(s: LinkState, reason?: string): void {
    for (const cb of this.stateCbs) cb(s, reason);
  }
}
