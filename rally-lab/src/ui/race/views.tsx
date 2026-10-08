// Drawing for the auto run: the planned route and the robot over the live
// camera picture, and a top-down map of the mat.

import { useRef } from 'react';
import type { AutoRun, TrackGate } from '../../core/race/autoRun';
import type { Plan, RouteSpec } from '../../core/race/route';
import { applyH, type Pt } from '../../core/vision/linalg';
import type { HandheldFrame } from '../../core/vision/handheld';
import { useAnimationFrame } from '../hooks';
import { dot, polyline } from '../camera/views';

export const SECTION_COLORS = ['#ff6b6b', '#ffd166', '#06d6a0', '#4cc9f0', '#b388ff', '#f78c6b', '#9be564'];

/** Overlay on the live picture (frame pixels × scale). */
export function drawLiveOverlay(
  g: CanvasRenderingContext2D, scale: number, last: HandheldFrame | undefined, plan: Plan, route: RouteSpec, auto: AutoRun | undefined,
  gate?: TrackGate,
): void {
  if (!last?.corners || !last.H || !last.G) return;
  const fresh = last.matAgeMs === 0;
  polyline(g, last.corners, scale, fresh ? 'rgba(6,214,160,0.7)' : 'rgba(255,179,71,0.7)', true, 1);
  const G = last.G;
  const toImg = (p: Pt) => applyH(G, p);
  // the route, coloured by section
  const pts = plan.outline;
  let cur: Pt[] = [];
  let sec = pts[0]?.section;
  const secs = route.sections.map((s) => s.id);
  const flush = () => {
    if (cur.length > 1) polyline(g, cur, scale, SECTION_COLORS[secs.indexOf(sec ?? '') % SECTION_COLORS.length] ?? '#4cc9f0', false, 2);
  };
  for (let i = 0; i < pts.length; i += 3) {
    const p = pts[i];
    if (p.section !== sec) {
      flush();
      cur = cur.length ? [cur[cur.length - 1]] : [];
      sec = p.section;
    }
    cur.push(toImg(p));
  }
  flush();
  for (const s of plan.sectionStarts) {
    const p = pts.find((q) => q.s >= s.s);
    if (!p) continue;
    const q = toImg(p);
    dot(g, q.x * scale, q.y * scale, 4, '#fff', s.id);
  }
  const st = toImg(route.start);
  dot(g, st.x * scale, st.y * scale, 5, '#ffffff', 'start');
  // where we look for our robot
  if (gate) {
    const c = gate.center;
    const ring: Pt[] = [];
    for (let k = 0; k <= 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      ring.push(toImg({ x: c.x + gate.radiusCm * Math.cos(a), y: c.y + gate.radiusCm * Math.sin(a) }));
    }
    polyline(g, ring, scale, gate.why === 'blink' ? 'rgba(0,255,102,0.9)' : gate.why === 'lost' ? 'rgba(255,179,71,0.9)' : 'rgba(255,255,255,0.6)', true, 1.5);
    // Lost: it also looks along the route back to where it last saw the robot.
    if (gate.trail?.length) polyline(g, gate.trail.map(toImg), scale, 'rgba(255,179,71,0.55)', false, Math.max(3, (gate.trailRadiusCm ?? 10) * 0.4));
  }
  // the robot as the camera sees it
  if (last.fix) {
    dot(g, last.fix.px.x * scale, last.fix.px.y * scale, 7, 'rgba(0,255,0,0.55)');
    const q = toImg(last.fix);
    dot(g, q.x * scale, q.y * scale, 4, '#00ff66');
  }
  // the estimate and the target while running
  if (auto?.state === 'running') {
    const p = auto.est.pose;
    const a = toImg(p);
    const th = (p.headingDeg * Math.PI) / 180;
    const b = toImg({ x: p.x + 10 * Math.cos(th), y: p.y + 10 * Math.sin(th) });
    g.strokeStyle = '#ff2bd6';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(a.x * scale, a.y * scale);
    g.lineTo(b.x * scale, b.y * scale);
    g.stroke();
    dot(g, a.x * scale, a.y * scale, 5, '#ff2bd6');
    const t = auto.follower.target();
    if (t) {
      const q = toImg(t);
      dot(g, q.x * scale, q.y * scale, 3, '#ffffff');
    }
  }
}

/** Top-down map of the mat with the route, the robot and its trails. */
export function MatMap({ plan, lane, route, fixes, est, auto }: {
  plan: Plan; lane: Pt[]; route: RouteSpec; fixes: { x: number; y: number }[]; est: { x: number; y: number }[]; auto?: AutoRun;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useAnimationFrame(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = (w * route.matHeightCm) / route.matWidthCm;
    if (c.width !== Math.round(w * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.height = `${h}px`;
    }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const s = w / route.matWidthCm;
    g.fillStyle = '#1b1b20';
    g.fillRect(0, 0, w, h);
    // lane band
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = '#3c3550';
    g.lineWidth = (route.laneWidthCm + 2 * route.borderCm) * s;
    g.beginPath();
    lane.forEach((p, i) => (i ? g.lineTo(p.x * s, p.y * s) : g.moveTo(p.x * s, p.y * s)));
    g.stroke();
    // the line the robot follows
    g.lineWidth = 1.5;
    g.strokeStyle = '#8a7bd1';
    g.beginPath();
    plan.outline.forEach((p, i) => (i ? g.lineTo(p.x * s, p.y * s) : g.moveTo(p.x * s, p.y * s)));
    g.stroke();
    for (const cone of route.cones ?? []) dot(g, cone.x * s, cone.y * s, 2.5, cone.color === 'red' ? '#e63946' : '#bbb');
    if (route.bridge) {
      const b = route.bridge;
      g.strokeStyle = '#d4a373';
      g.lineWidth = 1;
      g.strokeRect(b.x0 * s, b.y0 * s, (b.x1 - b.x0) * s, (b.y1 - b.y0) * s);
    }
    for (const st of plan.sectionStarts) {
      const p = plan.outline.find((q) => q.s >= st.s);
      if (p) dot(g, p.x * s, p.y * s, 3, '#fff', st.id);
    }
    for (const l of plan.legs) if (l.kind === 'spin') dot(g, l.x * s, l.y * s, 1.5, '#ffd166');
    dot(g, route.start.x * s, route.start.y * s, 4, '#ffffff', 'start');
    g.fillStyle = 'rgba(0,255,102,0.55)';
    for (const p of fixes.slice(-300)) g.fillRect(p.x * s - 1, p.y * s - 1, 2, 2);
    g.fillStyle = 'rgba(255,43,214,0.8)';
    for (const p of est.slice(-1500)) g.fillRect(p.x * s - 0.75, p.y * s - 0.75, 1.5, 1.5);
    if (auto?.state === 'running') {
      const p = auto.est.pose;
      const th = (p.headingDeg * Math.PI) / 180;
      g.strokeStyle = '#ff2bd6';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(p.x * s, p.y * s);
      g.lineTo((p.x + 12 * Math.cos(th)) * s, (p.y + 12 * Math.sin(th)) * s);
      g.stroke();
      dot(g, p.x * s, p.y * s, 4, '#ff2bd6');
    }
  });
  return <canvas ref={ref} style={{ width: '100%', display: 'block', borderRadius: 8 }} />;
}
