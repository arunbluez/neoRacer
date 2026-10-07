import { describe, it, expect } from 'vitest';
import { IDENTITY, applyH, jacobiEigen, mat3Inv, mat3Mul, normalizeH, scaleHomography } from './linalg';

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('mat3', () => {
  it('inverts and round-trips', () => {
    const r = rng(1);
    for (let k = 0; k < 20; k++) {
      const m = Array.from({ length: 9 }, () => r() * 20 - 10);
      const inv = mat3Inv(m);
      expect(inv).not.toBeNull();
      const p = mat3Mul(m, inv!);
      p.forEach((v, i) => expect(v).toBeCloseTo(IDENTITY[i], 9));
    }
  });

  it('returns null for singular matrices', () => {
    expect(mat3Inv([1, 2, 3, 2, 4, 6, 0, 1, 1])).toBeNull();
    expect(mat3Inv([0, 0, 0, 0, 0, 0, 0, 0, 0])).toBeNull();
  });

  it('applies, normalises and scales homographies', () => {
    const H = [2, 0.1, 5, -0.2, 1.5, 7, 0.001, 0.002, 2];
    const N = normalizeH(H);
    expect(N[8]).toBe(1);
    const p = { x: 13, y: -4 };
    expect(applyH(N, p).x).toBeCloseTo(applyH(H, p).x, 12);
    expect(applyH(N, p).y).toBeCloseTo(applyH(H, p).y, 12);
    const S = scaleHomography(H, 2, 3);
    const q = applyH(S, p), q2 = applyH(H, { x: 26, y: -12 });
    expect(q.x).toBeCloseTo(q2.x, 12);
    expect(q.y).toBeCloseTo(q2.y, 12);
    const Z = normalizeH([1, 0, 0, 0, 1, 0, 1, 0, 0]); // H[8] = 0: unit Frobenius norm instead
    expect(Math.hypot(...Z)).toBeCloseTo(1, 12);
  });
});

describe('jacobiEigen', () => {
  it('solves a known 2×2 matrix', () => {
    const { values, vectors } = jacobiEigen([[2, 1], [1, 2]]);
    expect(values[0]).toBeCloseTo(1, 12);
    expect(values[1]).toBeCloseTo(3, 12);
    expect(Math.abs(vectors[0][0] * Math.SQRT2)).toBeCloseTo(1, 12);
    expect(vectors[0][0]).toBeCloseTo(-vectors[0][1], 12);
    expect(vectors[1][0]).toBeCloseTo(vectors[1][1], 12);
  });

  it('decomposes a random symmetric matrix', () => {
    const r = rng(7), n = 6;
    const a = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    for (let i = 0; i < n; i++) for (let j = i; j < n; j++) a[i][j] = a[j][i] = r() * 10 - 5;
    const { values, vectors } = jacobiEigen(a);
    for (let k = 1; k < n; k++) expect(values[k]).toBeGreaterThanOrEqual(values[k - 1]);
    const trace = a.reduce((s, row, i) => s + row[i], 0);
    expect(values.reduce((s, v) => s + v, 0)).toBeCloseTo(trace, 10);
    for (let k = 0; k < n; k++) {
      const v = vectors[k];
      for (let i = 0; i < n; i++) {
        const av = a[i].reduce((s, x, j) => s + x * v[j], 0);
        expect(av).toBeCloseTo(values[k] * v[i], 9);
      }
      for (let m = 0; m < n; m++) {
        const d = v.reduce((s, x, i) => s + x * vectors[m][i], 0);
        expect(d).toBeCloseTo(k === m ? 1 : 0, 10);
      }
    }
  });
});
