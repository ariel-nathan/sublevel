/**
 * Coplanar-overlap detection: two surfaces in the same plane facing the same
 * way z-fight wherever they overlap. Pure; used by the tests of this module
 * and of the world objects.
 */
import type { FaceCells } from "./meshgen";
import { forEachVisibleCell } from "./meshgen";

/** An axis-aligned rectangle facing along +/- one axis. */
export interface FaceRect {
  /** Who owns it, for reports (e.g. "brush 12 lab_wall" or "door_a slab"). */
  owner: string;
  /** Normal axis (0 x, 1 y, 2 z) and direction. */
  axis: 0 | 1 | 2;
  sign: 1 | -1;
  plane: number;
  /** Extent on the axes (axis+1)%3 and (axis+2)%3. */
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

/** The six faces of a box as rects. */
export function boxRects(
  owner: string,
  min: { x: number; y: number; z: number },
  max: { x: number; y: number; z: number },
  skip: readonly string[] = [],
): FaceRect[] {
  const lo = [min.x, min.y, min.z];
  const hi = [max.x, max.y, max.z];
  const out: FaceRect[] = [];
  for (const axis of [0, 1, 2] as const) {
    const a = (axis + 1) % 3;
    const b = (axis + 2) % 3;
    for (const sign of [1, -1] as const) {
      const name = `${sign > 0 ? "p" : "n"}${"xyz"[axis]}`;
      if (skip.includes(name)) continue;
      out.push({
        owner,
        axis,
        sign,
        plane: sign > 0 ? hi[axis] : lo[axis],
        a0: lo[a],
        a1: hi[a],
        b0: lo[b],
        b1: hi[b],
      });
    }
  }
  return out;
}

/** Every emitted level face cell as a rect, owned by its brush. */
export function levelRects(
  faces: readonly FaceCells[],
  label: (brush: number) => string = (n) => `brush ${n}`,
): FaceRect[] {
  const out: FaceRect[] = [];
  for (const f of faces) {
    const a = (f.n + 1) % 3;
    const b = (f.n + 2) % 3;
    forEachVisibleCell(f, (c) => {
      out.push({
        owner: label(f.brush),
        axis: f.n,
        sign: f.sign,
        plane: f.plane,
        a0: Math.min(c[0][a], c[2][a]),
        a1: Math.max(c[0][a], c[2][a]),
        b0: Math.min(c[0][b], c[2][b]),
        b1: Math.max(c[0][b], c[2][b]),
      });
    });
  }
  return out;
}

export interface Overlap {
  a: string;
  b: string;
  axis: "x" | "y" | "z";
  sign: 1 | -1;
  plane: number;
  /** Overlap area in square metres. */
  area: number;
  /** Bounds of the overlapping region on the two in-plane axes. */
  region: [number, number, number, number];
}

/**
 * Pairs of rects with different owners that lie in the same plane (within
 * `tolerance`), face the same way and overlap. Areas are summed per owner
 * pair and plane; pairs at or under `minArea` are left out. With `against`,
 * only pairs with one rect from each list are considered.
 */
export function coplanarOverlaps(
  rects: readonly FaceRect[],
  against?: readonly FaceRect[],
  tolerance = 5e-4,
  minArea = 1e-4,
): Overlap[] {
  const self = against === undefined;
  const groups = new Map<string, { a: FaceRect[]; b: FaceRect[] }>();
  const put = (r: FaceRect, side: "a" | "b", d: number) => {
    const key = `${r.axis}|${r.sign}|${Math.round(r.plane / tolerance) + d}`;
    let g = groups.get(key);
    if (!g) {
      g = { a: [], b: [] };
      groups.set(key, g);
    }
    g[side].push(r);
  };
  for (const r of rects) put(r, "a", 0);
  // Neighbouring buckets catch planes that straddle a bucket boundary.
  for (const r of against ?? rects) for (const d of [-1, 0, 1]) put(r, "b", d);
  const found = new Map<string, Overlap>();
  for (const [key, g] of groups) {
    for (const r of g.a) {
      for (const s of g.b) {
        if (r.owner === s.owner) continue;
        // Each unordered pair once when a list is checked against itself.
        if (self && r.owner > s.owner) continue;
        if (Math.abs(r.plane - s.plane) > tolerance) continue;
        const a0 = Math.max(r.a0, s.a0);
        const a1 = Math.min(r.a1, s.a1);
        const b0 = Math.max(r.b0, s.b0);
        const b1 = Math.min(r.b1, s.b1);
        if (a1 <= a0 || b1 <= b0) continue;
        const pairKey = `${r.owner}|${s.owner}|${key}`;
        const prev = found.get(pairKey);
        const area = (a1 - a0) * (b1 - b0);
        if (prev) {
          prev.area += area;
          prev.region = [
            Math.min(prev.region[0], a0),
            Math.max(prev.region[1], a1),
            Math.min(prev.region[2], b0),
            Math.max(prev.region[3], b1),
          ];
        } else {
          found.set(pairKey, {
            a: r.owner,
            b: s.owner,
            axis: "xyz"[r.axis] as "x" | "y" | "z",
            sign: r.sign,
            plane: r.plane,
            area,
            region: [a0, a1, b0, b1],
          });
        }
      }
    }
  }
  return [...found.values()].filter((o) => o.area > minArea);
}

/** One line per overlap, naming the in-plane axes. */
export function describeOverlap(o: Overlap): string {
  const n = "xyz".indexOf(o.axis);
  const a = "xyz"[(n + 1) % 3];
  const b = "xyz"[(n + 2) % 3];
  const r = o.region.map((x) => x.toFixed(3));
  return `${o.a} / ${o.b}: plane ${o.axis}=${o.plane.toFixed(3)} facing ${o.sign > 0 ? "+" : "-"}${o.axis}, ${a} ${r[0]}..${r[1]}, ${b} ${r[2]}..${r[3]}, ${(o.area * 1e4).toFixed(1)} cm2`;
}
