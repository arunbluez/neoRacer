// Emulates microbitapi.js closely enough to develop every screen without a
// robot: '#'-delimited commands split on ',', one handler call at a time
// with the firmware's blocking times, a small receive buffer that drops bytes
// when full, and a queue of at most 10 pending delimiter events.

import { blockMs } from '../link/blocking';
import type { Rgb } from '../protocol/commands';
import type { Clock } from '../types';
import type { SimWorld } from './world';

export type FirmwareOptions = {
  /** micro:bit UART service receive buffer, bytes. */
  rxBufferBytes: number;
  /** Max queued handler events (CODAL message bus queue). */
  maxQueuedEvents: number;
  /** Handler run time for an ordinary command, ms. */
  handlerMs: number;
};

export const DEFAULT_FIRMWARE_OPTIONS: FirmwareOptions = {
  rxBufferBytes: 20,
  maxQueuedEvents: 10,
  handlerMs: 2,
};

export class SimFirmware {
  private rx = '';
  private events = 0;
  private busy = false;
  private connected = false;
  opts: FirmwareOptions;
  /** Every command the handler ran, for tests. */
  readonly handled: { cmd: string; t: number }[] = [];
  /** Bytes dropped because the receive buffer was full. */
  droppedBytes = 0;

  constructor(
    private readonly world: SimWorld,
    private readonly clock: Clock,
    private readonly reply: (text: string) => void,
    opts: Partial<FirmwareOptions> = {},
  ) {
    this.opts = { ...DEFAULT_FIRMWARE_OPTIONS, ...opts };
  }

  onConnected(): void {
    this.connected = true;
    this.world.display = 'HAPPY';
  }

  /** The firmware's only failsafe. */
  onDisconnected(): void {
    this.connected = false;
    const t = this.clock.now();
    this.world.setMotors(0, 0, t);
    const off = { r: 0, g: 0, b: 0 };
    this.world.lights = { hlL: off, hlR: off, ugL: off, ugR: off };
    this.world.display = 'SAD';
    this.rx = '';
    this.events = 0;
  }

  /** Bytes written by the phone arrive here. */
  receive(text: string): void {
    for (const ch of text) {
      if (this.rx.length >= this.opts.rxBufferBytes - 1) {
        this.droppedBytes++;
        continue;
      }
      this.rx += ch;
      if (ch === '#' && this.events < this.opts.maxQueuedEvents) this.events++;
    }
    this.kick();
  }

  private kick(): void {
    if (this.busy || this.events === 0) return;
    this.events--;
    const i = this.rx.indexOf('#');
    // uartReadUntil('#') returns everything up to the delimiter (or all of it).
    const raw = i >= 0 ? this.rx.slice(0, i) : this.rx;
    this.rx = i >= 0 ? this.rx.slice(i + 1) : '';
    this.busy = true;
    const ms = this.run(raw.trim());
    setTimeout(() => {
      this.busy = false;
      this.kick();
    }, ms);
  }

  /** Runs one handler call; returns how long it keeps the handler busy, ms. */
  private run(rawStr: string): number {
    const t = this.clock.now();
    if (rawStr.length === 0) return 0;
    this.handled.push({ cmd: rawStr, t });
    const parts = rawStr.split(',');
    const cmd = parts[0].trim();
    const n = (k: number, dflt: number) => (parts.length > k ? parseInt(parts[k], 10) : dflt);
    const w = this.world;
    const send = (s: string, delay = 0) => setTimeout(() => this.connected && this.reply(s), delay);
    const rgbAt = (): Rgb => ({ r: n(1, 0) | 0, g: n(2, 0) | 0, b: n(3, 0) | 0 });
    const base = this.opts.handlerMs;
    // parseInt of garbage gives NaN; the firmware would pass NaN to the motors (treated as 0).
    const num = (v: number) => (Number.isFinite(v) ? v : 0);

    switch (cmd) {
      case 'F': { const s = num(n(1, 50)); w.setMotors(s, s, t); return base; }
      case 'B': { const s = num(n(1, 50)); w.setMotors(-s, -s, t); return base; }
      case 'L': { const s = num(n(1, 50)); w.setMotors(-s, s, t); return base; }
      case 'R': { const s = num(n(1, 50)); w.setMotors(s, -s, t); return base; }
      case 'S': w.setMotors(0, 0, t); return base;
      case 'ML': if (parts.length > 1) w.setMotors(num(n(1, 0)), w.cmdR, t); return base;
      case 'MR': if (parts.length > 1) w.setMotors(w.cmdL, num(n(1, 0)), t); return base;
      case 'MS': if (parts.length > 2) w.setMotors(num(n(1, 0)), num(n(2, 0)), t); return base;
      case 'HL': if (parts.length > 3) { w.lights.hlL = rgbAt(); w.lights.hlR = rgbAt(); } return base;
      case 'HLL': if (parts.length > 3) w.lights.hlL = rgbAt(); return base;
      case 'HLR': if (parts.length > 3) w.lights.hlR = rgbAt(); return base;
      case 'HO': w.lights = { hlL: { r: 0, g: 0, b: 0 }, hlR: { r: 0, g: 0, b: 0 }, ugL: { r: 0, g: 0, b: 0 }, ugR: { r: 0, g: 0, b: 0 } }; return base;
      case 'UG': if (parts.length > 3) { w.lights.ugL = rgbAt(); w.lights.ugR = rgbAt(); } return base;
      case 'UGL': if (parts.length > 3) w.lights.ugL = rgbAt(); return base;
      case 'UGR': if (parts.length > 3) w.lights.ugR = rgbAt(); return base;
      case 'UGO': w.lights.ugL = { r: 0, g: 0, b: 0 }; w.lights.ugR = { r: 0, g: 0, b: 0 }; return base;
      case 'HORN': case 'BEEP': case 'QUIET': case 'MUTE': return base + blockMs(cmd);
      case 'TONE': return parts.length > 2 ? base + Math.max(0, num(n(2, 0))) : base;
      case 'DISP':
        if (parts.length > 1) {
          const msg = parts.slice(1).join(',');
          w.display = msg;
          return base + blockMs(`DISP,${msg}`);
        }
        return base;
      case 'ICON':
        if (parts.length > 1) {
          w.display = parts[1].toUpperCase();
          return base + 600;
        }
        return base;
      case 'CLS': w.display = ''; return base;
      case '?DIST': {
        const d = w.distanceCm(t);
        // pulseIn waits for the echo: about 58 µs per cm, plus trigger overhead
        const ms = base + 1 + Math.round((d * 58) / 1000);
        send(`DIST:${d}#\n`, ms);
        return ms;
      }
      case '?LINE': send(`LINE:${w.lineCode(t)}#\n`, base); return base;
      case '?COMPASS':
        if (!w.compassCalibrated) {
          // The real robot starts the tilt calibration and blocks until someone completes it.
          w.display = 'TILT TO FILL SCREEN';
          return 24 * 3600 * 1000;
        }
        send(`COMPASS:${w.compass(t)}#\n`, base + 3);
        return base + 3;
      case '?ACCEL': { const [x, y, z] = w.accel(t); send(`ACCEL:${x},${y},${z}#\n`, base); return base; }
      case '?LIGHT': send(`LIGHT:${w.lightLevel(t)}#\n`, base); return base;
      case '?TEMP': send(`TEMP:${w.temperature()}#\n`, base); return base;
      case 'PING': send('PONG#\n', base); return base;
      default: return base;
    }
  }
}
