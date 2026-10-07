// Shared camera views: the live picture with an overlay, and a still image
// with an overlay, both reporting taps in image pixels.

import { useEffect, useRef, type PointerEvent as RPointerEvent } from 'react';
import { drawImageBuf } from '../../adapters/camera/imageIo';
import type { ImageBuf } from '../../core/vision/rectify';
import { useAnimationFrame } from '../hooks';
import { cameraController } from './controller';

export type Draw = (g: CanvasRenderingContext2D, scale: number, w: number, h: number) => void;

function sizeOverlay(c: HTMLCanvasElement): { w: number; h: number; dpr: number } {
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  return { w, h, dpr };
}

/**
 * The live camera picture. Taps and drawing use processed-frame pixels
 * (procWidth wide); `scale` converts them to display pixels.
 */
export function LiveView({ draw, onTap }: { draw?: Draw; onTap?: (x: number, y: number) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const src = cameraController.source;

  useEffect(() => {
    const h = host.current;
    if (!h || !src) return;
    const el = src.preview;
    el.style.width = '100%';
    el.style.display = 'block';
    h.prepend(el);
    return () => {
      if (el.parentElement === h) h.removeChild(el);
    };
  }, [src]);

  useAnimationFrame(() => {
    const c = overlay.current;
    const f = cameraController.lastFrame;
    if (!c || !f) return;
    const { w, h, dpr } = sizeOverlay(c);
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    draw?.(g, w / f.width, w, h);
  }, !!src);

  const tap = (e: RPointerEvent) => {
    const f = cameraController.lastFrame;
    if (!onTap || !f || !overlay.current) return;
    const r = overlay.current.getBoundingClientRect();
    const s = f.width / r.width;
    onTap((e.clientX - r.left) * s, (e.clientY - r.top) * s);
  };

  if (!src) return <div className="card muted">Camera is off. Start it in Setup.</div>;
  return (
    <div className="video-wrap" ref={host}>
      <canvas className="overlay" ref={overlay} onPointerDown={tap} />
    </div>
  );
}

/** A still image with an overlay; pointer handlers get image pixel coordinates. */
export function StillView({ img, draw, onDown, onMove, onUp, redrawKey }: {
  img: ImageBuf;
  draw?: Draw;
  onDown?: (x: number, y: number, e: RPointerEvent) => void;
  onMove?: (x: number, y: number, e: RPointerEvent) => void;
  onUp?: (x: number, y: number, e: RPointerEvent) => void;
  redrawKey?: unknown;
}) {
  const base = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (base.current) drawImageBuf(base.current, img);
  }, [img]);
  useEffect(() => {
    const c = overlay.current;
    if (!c) return;
    const { w, h, dpr } = sizeOverlay(c);
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    draw?.(g, w / img.width, w, h);
  });
  const at = (e: RPointerEvent, cb?: (x: number, y: number, e: RPointerEvent) => void) => {
    if (!cb || !overlay.current) return;
    const r = overlay.current.getBoundingClientRect();
    const s = img.width / r.width;
    cb((e.clientX - r.left) * s, (e.clientY - r.top) * s, e);
  };
  return (
    <div className="video-wrap" data-k={String(redrawKey ?? '')}>
      <canvas ref={base} style={{ width: '100%', display: 'block' }} />
      <canvas
        className="overlay"
        ref={overlay}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          at(e, onDown);
        }}
        onPointerMove={(e) => at(e, onMove)}
        onPointerUp={(e) => at(e, onUp)}
      />
    </div>
  );
}

export function polyline(g: CanvasRenderingContext2D, pts: { x: number; y: number }[], scale: number, color: string, close = true, width = 2) {
  if (pts.length < 2) return;
  g.strokeStyle = color;
  g.lineWidth = width;
  g.beginPath();
  g.moveTo(pts[0].x * scale, pts[0].y * scale);
  for (const p of pts.slice(1)) g.lineTo(p.x * scale, p.y * scale);
  if (close) g.closePath();
  g.stroke();
}

export function dot(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, label?: string) {
  g.fillStyle = color;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
  if (label) {
    g.font = 'bold 13px system-ui';
    g.fillStyle = '#fff';
    g.strokeStyle = '#000';
    g.lineWidth = 3;
    g.strokeText(label, x + r + 3, y - r - 2);
    g.fillText(label, x + r + 3, y - r - 2);
  }
}

/** Speed (cm/s) to a colour from blue (slow) to red (fast). */
export function speedColor(v: number, vmax = 60): string {
  const t = Math.max(0, Math.min(1, v / vmax));
  return `hsl(${240 - 240 * t}, 90%, 55%)`;
}
