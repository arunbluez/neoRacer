// How long each command keeps the firmware's single handler busy. While it is
// busy, further commands wait in a small receive buffer and may be dropped,
// so the scheduler holds every channel except `safety` for this long.

import { cmdArgs, cmdName } from '../protocol/commands';

/**
 * Overrides measured by T1.5, keyed by command name. Special keys:
 * - `TONE`: overhead added to the tone's duration.
 * - `DISP_BASE`, `DISP_PER_CHAR`: linear model of scrolling time.
 */
export type BlockingTable = Record<string, number>;

export const DEFAULT_BLOCKING: BlockingTable = {
  ICON: 600,
  HORN: 200,
  BEEP: 100,
};

/** Firmware scroll speed: 150 ms per column, 6 columns per character, plus 5 to scroll out. */
export function defaultDispMs(text: string): number {
  return (text.length * 6 + 5) * 150;
}

export function blockMs(command: string, overrides: BlockingTable = {}): number {
  const name = cmdName(command);
  const args = cmdArgs(command);
  switch (name) {
    case 'TONE': {
      const dur = args.length > 1 ? parseInt(args[1], 10) : 0;
      return (Number.isFinite(dur) ? Math.max(0, dur) : 0) + (overrides.TONE ?? 0);
    }
    case 'DISP': {
      if (args.length === 0) return 0;
      const text = args.join(',');
      if (overrides.DISP_PER_CHAR !== undefined) {
        return Math.max(0, (overrides.DISP_BASE ?? 0) + overrides.DISP_PER_CHAR * text.length);
      }
      return defaultDispMs(text);
    }
    case 'ICON':
      if (args.length === 0) return 0;
      return overrides.ICON ?? DEFAULT_BLOCKING.ICON;
    default:
      return overrides[name] ?? DEFAULT_BLOCKING[name] ?? 0;
  }
}
