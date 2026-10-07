import { useEffect, useReducer, useRef } from 'react';
import { useApp } from './appStore';

/** Re-render the component every `ms` (screens read core ring buffers this way). */
export function useTicker(ms: number, enabled = true): number {
  const [n, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!enabled) return;
    const h = setInterval(tick, ms);
    return () => clearInterval(h);
  }, [ms, enabled]);
  return n;
}

/** Re-render when lab state (session, settings, profile, runner) changes. */
export function useLabVersion(): number {
  return useApp((s) => s.version);
}

/** requestAnimationFrame loop for canvas drawing. */
export function useAnimationFrame(cb: (t: number) => void, enabled = true): void {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    if (!enabled) return;
    let h = 0;
    const loop = (t: number) => {
      ref.current(t);
      h = requestAnimationFrame(loop);
    };
    h = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(h);
  }, [enabled]);
}

export function fmt(x: number | undefined | null, digits = 0, unit = ''): string {
  if (x === undefined || x === null || !Number.isFinite(x)) return '–';
  return `${x.toFixed(digits)}${unit}`;
}

export function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}
