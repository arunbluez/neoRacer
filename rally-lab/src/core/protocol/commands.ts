// Command builders for the Cutebot UART firmware (microbitapi.js).
// Every builder returns the command text without the trailing '#'.

export const MAX_WRITE_BYTES = 20;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
const speed = (v: number) => clamp(v, -100, 100);
const unitSpeed = (v: number) => clamp(v, 1, 100);
const byte = (v: number) => clamp(v, 0, 255);

export type Rgb = { r: number; g: number; b: number };
export type IconName = 'HAPPY' | 'SAD' | 'HEART' | 'YES' | 'NO' | 'SKULL';
export const ICONS: IconName[] = ['HAPPY', 'SAD', 'HEART', 'YES', 'NO', 'SKULL'];

const rgb = (name: string, c: Rgb) => `${name},${byte(c.r)},${byte(c.g)},${byte(c.b)}`;
// F, B, L and R default to 50 in the firmware, so the bare form is shorter.
const withSpeed = (name: string, s?: number) =>
  s === undefined || unitSpeed(s) === 50 ? name : `${name},${unitSpeed(s)}`;

export const cmd = {
  forward: (s?: number) => withSpeed('F', s),
  backward: (s?: number) => withSpeed('B', s),
  left: (s?: number) => withSpeed('L', s),
  right: (s?: number) => withSpeed('R', s),
  stop: () => 'S',
  motorLeft: (v: number) => `ML,${speed(v)}`,
  motorRight: (v: number) => `MR,${speed(v)}`,
  motors: (l: number, r: number) => `MS,${speed(l)},${speed(r)}`,

  headlights: (c: Rgb) => rgb('HL', c),
  headlightLeft: (c: Rgb) => rgb('HLL', c),
  headlightRight: (c: Rgb) => rgb('HLR', c),
  lightsOff: () => 'HO',
  underglow: (c: Rgb) => rgb('UG', c),
  underglowLeft: (c: Rgb) => rgb('UGL', c),
  underglowRight: (c: Rgb) => rgb('UGR', c),
  underglowOff: () => 'UGO',

  horn: () => 'HORN',
  beep: () => 'BEEP',
  tone: (freqHz: number, ms: number) => `TONE,${clamp(freqHz, 1, 20000)},${clamp(ms, 1, 60000)}`,
  quiet: () => 'QUIET',
  mute: () => 'MUTE',

  display: (text: string) => `DISP,${text.replace(/#/g, '')}`,
  icon: (name: IconName) => `ICON,${name}`,
  cls: () => 'CLS',

  dist: () => '?DIST',
  line: () => '?LINE',
  compass: () => '?COMPASS',
  accel: () => '?ACCEL',
  light: () => '?LIGHT',
  temp: () => '?TEMP',
  ping: () => 'PING',
} as const;

/** The command name: text before the first comma, trimmed (as the firmware does). */
export function cmdName(command: string): string {
  const i = command.indexOf(',');
  return (i < 0 ? command : command.slice(0, i)).trim();
}

/** Arguments after the name, as the firmware splits them. */
export function cmdArgs(command: string): string[] {
  const parts = command.split(',');
  return parts.slice(1);
}

export const QUERY_COMMANDS = ['?DIST', '?LINE', '?COMPASS', '?ACCEL', '?LIGHT', '?TEMP', 'PING'] as const;
export type QueryCommand = (typeof QUERY_COMMANDS)[number];

export function isQuery(command: string): command is QueryCommand {
  return (QUERY_COMMANDS as readonly string[]).includes(cmdName(command));
}

export const MOTOR_COMMANDS = ['F', 'B', 'L', 'R', 'ML', 'MR', 'MS'];
export const LIGHT_COMMANDS = ['HL', 'HLL', 'HLR', 'UG', 'UGL', 'UGR', 'HO', 'UGO'];

/** Bytes on the wire for one command, including the '#' terminator. */
export function wireLength(command: string): number {
  return command.length + 1;
}

export type MotorState = { l: number; r: number };

/**
 * Wheel speeds after a motor command, given the state before it. Mirrors the
 * firmware: ML/MR keep the other wheel, F/B/L/R default to 50, malformed
 * ML/MS leave the state untouched.
 */
export function applyMotor(command: string, prev: MotorState): MotorState {
  const name = cmdName(command);
  const args = cmdArgs(command).map((a) => parseInt(a, 10));
  const s = args.length > 0 ? args[0] : 50;
  switch (name) {
    case 'F': return { l: s, r: s };
    case 'B': return { l: -s, r: -s };
    case 'L': return { l: -s, r: s };
    case 'R': return { l: s, r: -s };
    case 'S': return { l: 0, r: 0 };
    case 'ML': return args.length > 0 ? { l: args[0], r: prev.r } : prev;
    case 'MR': return args.length > 0 ? { l: prev.l, r: args[0] } : prev;
    case 'MS': return args.length > 1 ? { l: args[0], r: args[1] } : prev;
    default: return prev;
  }
}
