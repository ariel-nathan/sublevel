/**
 * Translational sweeps of an axis-aligned box against an oriented box, and
 * minimum-penetration queries. Both use the 15 separating axes of the box
 * pair: the Minkowski sum of two boxes is bounded by exactly those planes,
 * so the sweep is exact for pure translation.
 */
import { IDENTITY, type Box } from "./body";

export interface SweepHit {
  /** Fraction of the displacement at first contact, 0..1. */
  t: number;
  /** Unit normal of the surface hit, facing the moving box. */
  nx: number;
  ny: number;
  nz: number;
}

export interface Penetration {
  /** Signed separation along the least-penetrating axis; negative = overlap. */
  sep: number;
  /** Unit direction that moves the box out of the other one. */
  nx: number;
  ny: number;
  nz: number;
}

const axes = new Float64Array(15 * 3);

function isIdentity(r: Float64Array): boolean {
  if (r === IDENTITY) {
    return true;
  }
  return (
    Math.abs(r[0] - 1) < 1e-9 &&
    Math.abs(r[4] - 1) < 1e-9 &&
    Math.abs(r[8] - 1) < 1e-9 &&
    Math.abs(r[1]) < 1e-9 &&
    Math.abs(r[2]) < 1e-9 &&
    Math.abs(r[3]) < 1e-9
  );
}

/** Fills `axes` with candidate unit axes; returns how many. */
function buildAxes(B: Box): number {
  axes.fill(0, 0, 9);
  axes[0] = 1;
  axes[4] = 1;
  axes[8] = 1;
  if (isIdentity(B.r)) {
    return 3;
  }
  const r = B.r;
  let n = 3;
  for (let j = 0; j < 3; j++) {
    axes[n * 3] = r[j];
    axes[n * 3 + 1] = r[3 + j];
    axes[n * 3 + 2] = r[6 + j];
    n++;
  }
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const bx = r[j];
      const by = r[3 + j];
      const bz = r[6 + j];
      // cross(e_i, b)
      let lx = 0;
      let ly = 0;
      let lz = 0;
      if (i === 0) {
        ly = -bz;
        lz = by;
      } else if (i === 1) {
        lx = bz;
        lz = -bx;
      } else {
        lx = -by;
        ly = bx;
      }
      const len = Math.sqrt(lx * lx + ly * ly + lz * lz);
      if (len < 1e-4) {
        continue;
      }
      axes[n * 3] = lx / len;
      axes[n * 3 + 1] = ly / len;
      axes[n * 3 + 2] = lz / len;
      n++;
    }
  }
  return n;
}

function radiusB(B: Box, lx: number, ly: number, lz: number): number {
  const r = B.r;
  return (
    B.hx * Math.abs(r[0] * lx + r[3] * ly + r[6] * lz) +
    B.hy * Math.abs(r[1] * lx + r[4] * ly + r[7] * lz) +
    B.hz * Math.abs(r[2] * lx + r[5] * ly + r[8] * lz)
  );
}

/**
 * Sweeps the AABB (centre c, half extents e) by displacement d against B.
 * A box that already overlaps B by less than `overlapTolerance` reports a
 * hit at t = 0 if it moves further in; deeper overlaps are ignored (the
 * caller resolves them by depenetration).
 */
export function sweepBox(
  cx: number,
  cy: number,
  cz: number,
  ex: number,
  ey: number,
  ez: number,
  dx: number,
  dy: number,
  dz: number,
  B: Box,
  overlapTolerance: number,
): SweepHit | null {
  const n = buildAxes(B);
  const ox = B.px - cx;
  const oy = B.py - cy;
  const oz = B.pz - cz;
  let tEnter = -Infinity;
  let tExit = Infinity;
  let enx = 0;
  let eny = 0;
  let enz = 0;
  let maxSep = -Infinity;
  let snx = 0;
  let sny = 0;
  let snz = 0;
  for (let k = 0; k < n; k++) {
    const lx = axes[k * 3];
    const ly = axes[k * 3 + 1];
    const lz = axes[k * 3 + 2];
    const c = ox * lx + oy * ly + oz * lz;
    const v = dx * lx + dy * ly + dz * lz;
    const R =
      ex * Math.abs(lx) +
      ey * Math.abs(ly) +
      ez * Math.abs(lz) +
      radiusB(B, lx, ly, lz);
    const sep = Math.abs(c) - R;
    if (sep > maxSep) {
      maxSep = sep;
      const s = c >= 0 ? -1 : 1;
      snx = lx * s;
      sny = ly * s;
      snz = lz * s;
    }
    if (Math.abs(v) < 1e-12) {
      if (sep >= 0) {
        return null;
      }
      continue;
    }
    let t0 = (c - R) / v;
    let t1 = (c + R) / v;
    if (t0 > t1) {
      const tmp = t0;
      t0 = t1;
      t1 = tmp;
    }
    if (t0 > tEnter) {
      tEnter = t0;
      const s = v > 0 ? -1 : 1;
      enx = lx * s;
      eny = ly * s;
      enz = lz * s;
    }
    if (t1 < tExit) {
      tExit = t1;
    }
  }
  if (maxSep < 0) {
    // Already overlapping.
    if (maxSep > -overlapTolerance && dx * snx + dy * sny + dz * snz < 0) {
      return { t: 0, nx: snx, ny: sny, nz: snz };
    }
    return null;
  }
  if (tEnter > tExit || tEnter > 1 || tEnter < 0) {
    return null;
  }
  return { t: tEnter, nx: enx, ny: eny, nz: enz };
}

/** Least-penetration axis between the AABB and B. */
export function penetration(
  cx: number,
  cy: number,
  cz: number,
  ex: number,
  ey: number,
  ez: number,
  B: Box,
): Penetration {
  const n = buildAxes(B);
  const ox = B.px - cx;
  const oy = B.py - cy;
  const oz = B.pz - cz;
  let best: Penetration = { sep: -Infinity, nx: 0, ny: 1, nz: 0 };
  for (let k = 0; k < n; k++) {
    const lx = axes[k * 3];
    const ly = axes[k * 3 + 1];
    const lz = axes[k * 3 + 2];
    const c = ox * lx + oy * ly + oz * lz;
    const R =
      ex * Math.abs(lx) +
      ey * Math.abs(ly) +
      ez * Math.abs(lz) +
      radiusB(B, lx, ly, lz);
    const sep = Math.abs(c) - R;
    if (sep > best.sep) {
      const s = c >= 0 ? -1 : 1;
      best = { sep, nx: lx * s, ny: ly * s, nz: lz * s };
    }
  }
  return best;
}
