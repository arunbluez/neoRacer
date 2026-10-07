import { useEffect, useRef } from 'react';

/** A tiny canvas line chart. `points` are [x, y]; x is usually time. */
export function Sparkline({ points, color = '#58a6ff', min, max, height = 48, refLine }: {
  points: [number, number][];
  color?: string;
  min?: number;
  max?: number;
  height?: number;
  refLine?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth * dpr;
    const h = height * dpr;
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, w, h);
    if (points.length < 2) return;
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]).filter(Number.isFinite);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const y0 = min ?? Math.min(...ys);
    const y1 = Math.max(max ?? Math.max(...ys), y0 + 1e-6);
    const sx = (x: number) => ((x - x0) / Math.max(1e-9, x1 - x0)) * (w - 2) + 1;
    const sy = (y: number) => h - 2 - ((y - y0) / (y1 - y0)) * (h - 4);
    if (refLine !== undefined && refLine >= y0 && refLine <= y1) {
      g.strokeStyle = '#30363d';
      g.lineWidth = dpr;
      g.beginPath();
      g.moveTo(0, sy(refLine));
      g.lineTo(w, sy(refLine));
      g.stroke();
    }
    g.strokeStyle = color;
    g.lineWidth = 1.5 * dpr;
    g.beginPath();
    let started = false;
    for (const [x, y] of points) {
      if (!Number.isFinite(y)) continue;
      if (!started) g.moveTo(sx(x), sy(y));
      else g.lineTo(sx(x), sy(y));
      started = true;
    }
    g.stroke();
  });
  return <canvas ref={ref} className="spark" style={{ height }} />;
}
