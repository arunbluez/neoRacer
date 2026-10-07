// Small statistics helpers used by link stats, tests and reports.

export function sorted(xs: readonly number[]): number[] {
  return [...xs].sort((a, b) => a - b);
}

/** Linear-interpolated quantile, q in 0..1. NaN for an empty list. */
export function quantile(xs: readonly number[], q: number, alreadySorted = false): number {
  if (xs.length === 0) return NaN;
  const s = alreadySorted ? xs : sorted(xs);
  const pos = (s.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export const median = (xs: readonly number[]) => quantile(xs, 0.5);
export const p95 = (xs: readonly number[]) => quantile(xs, 0.95);

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation. */
export function std(xs: readonly number[]): number {
  if (xs.length < 2) return xs.length === 1 ? 0 : NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

export function min(xs: readonly number[]): number {
  return xs.length ? Math.min(...xs) : NaN;
}

export function max(xs: readonly number[]): number {
  return xs.length ? Math.max(...xs) : NaN;
}

export type Summary = { n: number; min: number; median: number; p95: number; max: number; mean: number; std: number };

export function summarize(xs: readonly number[]): Summary {
  const s = sorted(xs);
  return {
    n: s.length,
    min: s.length ? s[0] : NaN,
    median: quantile(s, 0.5, true),
    p95: quantile(s, 0.95, true),
    max: s.length ? s[s.length - 1] : NaN,
    mean: mean(s),
    std: std(s),
  };
}

export function histogram<T extends string | number>(xs: readonly T[]): Record<string, number> {
  const h: Record<string, number> = {};
  for (const x of xs) h[String(x)] = (h[String(x)] ?? 0) + 1;
  return h;
}

/** Most frequent value and its share (0..1). */
export function mode<T extends string | number>(xs: readonly T[]): { value: T | undefined; share: number } {
  let best: T | undefined;
  let bestN = 0;
  const counts = new Map<T, number>();
  for (const x of xs) {
    const n = (counts.get(x) ?? 0) + 1;
    counts.set(x, n);
    if (n > bestN) {
      bestN = n;
      best = x;
    }
  }
  return { value: best, share: xs.length ? bestN / xs.length : 0 };
}

/** Circular mean of angles in degrees, 0..360. */
export function circularMeanDeg(xs: readonly number[]): number {
  let sx = 0;
  let sy = 0;
  for (const a of xs) {
    sx += Math.cos((a * Math.PI) / 180);
    sy += Math.sin((a * Math.PI) / 180);
  }
  const m = (Math.atan2(sy, sx) * 180) / Math.PI;
  return (m + 360) % 360;
}

/** Circular standard deviation in degrees. */
export function circularStdDeg(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  let sx = 0;
  let sy = 0;
  for (const a of xs) {
    sx += Math.cos((a * Math.PI) / 180);
    sy += Math.sin((a * Math.PI) / 180);
  }
  const r = Math.min(1, Math.hypot(sx, sy) / xs.length);
  return (Math.sqrt(-2 * Math.log(Math.max(r, 1e-12))) * 180) / Math.PI;
}

/** Least-squares line y = a + b x. */
export function linearFit(xs: readonly number[], ys: readonly number[]): { a: number; b: number; r2: number } {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return { a: n ? ys[0] : NaN, b: NaN, r2: NaN };
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
    syy += (ys[i] - my) ** 2;
  }
  const b = sxx === 0 ? NaN : sxy / sxx;
  const a = my - b * mx;
  const r2 = sxx === 0 || syy === 0 ? NaN : (sxy * sxy) / (sxx * syy);
  return { a, b, r2 };
}

export function round(x: number, digits = 1): number {
  if (!Number.isFinite(x)) return x;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
