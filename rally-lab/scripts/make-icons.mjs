// Draws the app icon procedurally and writes public/icon-192.png and
// public/icon-512.png (no image tools needed). Run: npm run icons
import { writeFileSync } from 'node:fs';
import { zlibSync } from 'fflate';

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
export function encodePng(w, h, rgba) {
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw)), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function hsv(h, s, v) {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5) * 255, f(3) * 255, f(1) * 255];
}

function draw(size) {
  const rgba = new Uint8Array(size * size * 4);
  const SS = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size - 0.5; // -0.5..0.5
          const v = (y + (sy + 0.5) / SS) / size - 0.5;
          let c = [13, 17, 23];
          // stadium-shaped track loop
          const ax = Math.max(Math.abs(u) - 0.12, 0);
          const d = Math.hypot(ax, v) - 0.22;
          const ang = Math.atan2(v, u);
          if (Math.abs(d) < 0.075) c = hsv(220 + 110 * ((ang + Math.PI) / (2 * Math.PI)), 0.75, 0.95);
          if (Math.abs(Math.abs(d) - 0.075) < 0.012) c = [235, 235, 235];
          // robot: white body with a green headlight
          const rx = u - 0.0, ry = v + 0.22;
          if (Math.hypot(rx, ry) < 0.07) c = [245, 245, 245];
          if (Math.hypot(rx + 0.055, ry) < 0.022) c = [40, 230, 90];
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const o = (y * size + x) * 4;
      rgba[o] = r / (SS * SS); rgba[o + 1] = g / (SS * SS); rgba[o + 2] = b / (SS * SS); rgba[o + 3] = 255;
    }
  }
  return rgba;
}

for (const size of [192, 512]) {
  writeFileSync(new URL(`../public/icon-${size}.png`, import.meta.url), encodePng(size, size, draw(size)));
}
console.log('icons written');
