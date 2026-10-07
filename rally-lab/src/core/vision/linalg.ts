// Small dense linear algebra for planar homographies: 3×3 row-major matrices
// plus a Jacobi eigen-solver for the symmetric normal matrices of the DLT.

export type Pt = { x: number; y: number };
/** 3×3 matrix, row-major, length 9. */
export type Mat3 = number[];

/** Shared constant: copy it before mutating. */
export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mat3Mul(a: Mat3, b: Mat3): Mat3 {
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++) {
    const a0 = a[i * 3], a1 = a[i * 3 + 1], a2 = a[i * 3 + 2];
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a0 * b[j] + a1 * b[3 + j] + a2 * b[6 + j];
  }
  return r;
}

const frob2 = (m: Mat3) => m.reduce((s, v) => s + v * v, 0);

/** Inverse via the adjugate; null if (numerically) singular. */
export function mat3Inv(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C;
  // Compare with ‖m‖³ so the test does not depend on the overall scale.
  if (!Number.isFinite(det) || Math.abs(det) <= 1e-14 * frob2(m) ** 1.5) return null;
  const k = 1 / det;
  return [
    A * k, (c * h - b * i) * k, (b * f - c * e) * k,
    B * k, (a * i - c * g) * k, (c * d - a * f) * k,
    C * k, (b * g - a * h) * k, (a * e - b * d) * k,
  ];
}

/** Projective map: (H·[x y 1]ᵀ) divided by its third component. */
export function applyH(H: Mat3, p: Pt): Pt {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return { x: (H[0] * p.x + H[1] * p.y + H[2]) / w, y: (H[3] * p.x + H[4] * p.y + H[5]) / w };
}

/** Scale so H[8] === 1, or to unit Frobenius norm when H[8] ≈ 0. */
export function normalizeH(H: Mat3): Mat3 {
  const n = Math.sqrt(frob2(H));
  if (n === 0 || !Number.isFinite(n)) return H.slice();
  if (Math.abs(H[8]) > 1e-12 * n) {
    const h8 = H[8];
    return H.map((v, i) => (i === 8 ? 1 : v / h8));
  }
  const k = (H[8] < 0 ? -1 : 1) / n;
  return H.map((v) => v * k);
}

/**
 * H' with H'(p) = H({ x: p.x·sx, y: p.y·sy }), i.e. H·diag(sx, sy, 1).
 * With pixel centres at i + 0.5 (see rectify.ts), a frame scaled down by sx
 * maps to full resolution by plain multiplication, so no offset is needed.
 */
export function scaleHomography(H: Mat3, sx: number, sy: number): Mat3 {
  return [H[0] * sx, H[1] * sy, H[2], H[3] * sx, H[4] * sy, H[5], H[6] * sx, H[7] * sy, H[8]];
}

/**
 * Cyclic Jacobi eigen-decomposition of a symmetric n×n matrix. Returns the
 * eigenvalues ascending; vectors[k] is the unit eigenvector for values[k].
 */
export function jacobiEigen(a: number[][]): { values: number[]; vectors: number[][] } {
  const n = a.length;
  const A = a.map((row) => row.slice());
  const V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j): number => (i === j ? 1 : 0)));

  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0, all = 0;
    for (let p = 0; p < n; p++) {
      for (let q = 0; q < n; q++) {
        const v = A[p][q] * A[p][q];
        all += v;
        if (p !== q) off += v;
      }
    }
    if (off === 0 || off <= 1e-28 * all) break;

    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = A[p][q];
        if (apq === 0) continue;
        // Rotation angle φ that zeroes A[p][q]: cot 2φ = θ, t = tan φ (smaller root).
        const theta = (A[q][q] - A[p][p]) / (2 * apq);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        // A ← JᵀAJ (columns, then rows), V ← VJ.
        for (let k = 0; k < n; k++) {
          const akp = A[k][p], akq = A[k][q];
          A[k][p] = c * akp - s * akq;
          A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k], aqk = A[q][k];
          A[p][k] = c * apk - s * aqk;
          A[q][k] = s * apk + c * aqk;
        }
        A[p][q] = A[q][p] = 0;
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }

  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => A[i][i] - A[j][j]);
  return {
    values: order.map((i) => A[i][i]),
    vectors: order.map((i) => V.map((row) => row[i])),
  };
}
