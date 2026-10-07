// Reply parsing, ported from ReactNativeApi.ts. Stricter than the original:
// a reply whose value doesn't parse is reported as `raw` (garbled), not 0.

export type Reply =
  | { type: 'dist'; cm: number }
  | { type: 'line'; code: number }
  | { type: 'compass'; degrees: number }
  | { type: 'accel'; x: number; y: number; z: number }
  | { type: 'light'; level: number }
  | { type: 'temp'; celsius: number }
  | { type: 'pong' }
  | { type: 'raw'; text: string };

export type ReplyType = Reply['type'];

/** The reply type each query produces. */
export const QUERY_REPLY: Record<string, Exclude<ReplyType, 'raw'>> = {
  '?DIST': 'dist',
  '?LINE': 'line',
  '?COMPASS': 'compass',
  '?ACCEL': 'accel',
  '?LIGHT': 'light',
  '?TEMP': 'temp',
  PING: 'pong',
};

export const LINE_LABELS: Record<number, string> = {
  0: 'both white',
  1: 'right black',
  2: 'left black',
  3: 'both black',
};

const INT = /^-?\d+$/;

function int(s: string): number | null {
  const t = s.trim();
  return INT.test(t) ? parseInt(t, 10) : null;
}

export function parseReply(packet: string): Reply {
  const clean = packet.trim();
  const colon = clean.indexOf(':');
  if (clean === 'PONG') return { type: 'pong' };
  if (colon < 0) return { type: 'raw', text: clean };
  const tag = clean.slice(0, colon);
  const body = clean.slice(colon + 1);
  switch (tag) {
    case 'DIST': {
      const cm = int(body);
      return cm === null ? { type: 'raw', text: clean } : { type: 'dist', cm };
    }
    case 'LINE': {
      const code = int(body);
      return code === null || code < 0 || code > 3 ? { type: 'raw', text: clean } : { type: 'line', code };
    }
    case 'COMPASS': {
      const degrees = int(body);
      return degrees === null ? { type: 'raw', text: clean } : { type: 'compass', degrees };
    }
    case 'ACCEL': {
      const parts = body.split(',').map(int);
      if (parts.length !== 3 || parts.some((p) => p === null)) return { type: 'raw', text: clean };
      return { type: 'accel', x: parts[0]!, y: parts[1]!, z: parts[2]! };
    }
    case 'LIGHT': {
      const level = int(body);
      return level === null ? { type: 'raw', text: clean } : { type: 'light', level };
    }
    case 'TEMP': {
      const celsius = int(body);
      return celsius === null ? { type: 'raw', text: clean } : { type: 'temp', celsius };
    }
    default:
      return { type: 'raw', text: clean };
  }
}

/** A compact value for logging: `LINE:2` -> 2, `ACCEL:1,2,3` -> [1,2,3]. */
export function replyValue(r: Reply): unknown {
  switch (r.type) {
    case 'dist': return r.cm;
    case 'line': return r.code;
    case 'compass': return r.degrees;
    case 'accel': return [r.x, r.y, r.z];
    case 'light': return r.level;
    case 'temp': return r.celsius;
    case 'pong': return null;
    case 'raw': return r.text;
  }
}

/**
 * Reassembles replies from notification chunks. Replies end with `#\n`; a
 * chunk may hold part of a reply or several replies.
 */
export class LineSplitter {
  private buf = '';
  /** Partial data older than this many chars is dropped as garbage. */
  constructor(private readonly maxPending = 256) {}

  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    let i: number;
    while ((i = this.buf.indexOf('#')) >= 0) {
      const packet = this.buf.slice(0, i).replace(/[\r\n]/g, '').trim();
      this.buf = this.buf.slice(i + 1);
      if (packet.length > 0) out.push(packet);
    }
    // Leading newlines belong to the previous reply.
    this.buf = this.buf.replace(/^[\r\n]+/, '');
    if (this.buf.length > this.maxPending) {
      out.push(this.buf);
      this.buf = '';
    }
    return out;
  }

  get pending(): string {
    return this.buf;
  }

  reset(): void {
    this.buf = '';
  }
}
