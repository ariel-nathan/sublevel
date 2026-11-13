import type { Aabb, Brush, PropSpawn } from "../core/api";
import { PROP_SPECS } from "../core/props";

/** Plain-number axis-aligned box, used internally for speed. */
export interface Box {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

export function boxOf(b: Aabb | Brush): Box {
  return {
    x0: b.min.x,
    y0: b.min.y,
    z0: b.min.z,
    x1: b.max.x,
    y1: b.max.y,
    z1: b.max.z,
  };
}

/** True if the boxes overlap by more than `eps` on every axis. */
export function boxesOverlap(a: Box, b: Box, eps = 0): boolean {
  return (
    a.x0 < b.x1 - eps &&
    a.x1 > b.x0 + eps &&
    a.y0 < b.y1 - eps &&
    a.y1 > b.y0 + eps &&
    a.z0 < b.z1 - eps &&
    a.z1 > b.z0 + eps
  );
}

/** World-space bounds of a prop (conservative for any yaw). */
export function propBox(prop: PropSpawn): Box {
  const h = PROP_SPECS[prop.kind].halfExtents;
  const c = Math.abs(Math.cos(prop.yaw));
  const s = Math.abs(Math.sin(prop.yaw));
  const ex = c * h.x + s * h.z;
  const ez = s * h.x + c * h.z;
  const p = prop.position;
  return {
    x0: p.x - ex,
    x1: p.x + ex,
    y0: p.y - h.y,
    y1: p.y + h.y,
    z0: p.z - ez,
    z1: p.z + ez,
  };
}

export function containsPoint(
  b: Box,
  x: number,
  y: number,
  z: number,
): boolean {
  return (
    x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && z >= b.z0 && z <= b.z1
  );
}

/**
 * Segment (origin to origin + dir * maxT) against a box using the slab test.
 * A segment that starts inside the box is not counted as blocked, since it
 * cannot see out of the geometry it is embedded in anyway.
 */
export function segmentHitsBox(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxT: number,
  b: Box,
): boolean {
  let tmin = 0;
  let tmax = maxT;
  let inside = true;
  if (Math.abs(dx) < 1e-12) {
    if (ox < b.x0 || ox > b.x1) return false;
  } else {
    const inv = 1 / dx;
    let t0 = (b.x0 - ox) * inv;
    let t1 = (b.x1 - ox) * inv;
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > 0) inside = false;
    if (t0 > tmin) tmin = t0;
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return false;
  }
  if (Math.abs(dy) < 1e-12) {
    if (oy < b.y0 || oy > b.y1) return false;
  } else {
    const inv = 1 / dy;
    let t0 = (b.y0 - oy) * inv;
    let t1 = (b.y1 - oy) * inv;
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > 0) inside = false;
    if (t0 > tmin) tmin = t0;
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return false;
  }
  if (Math.abs(dz) < 1e-12) {
    if (oz < b.z0 || oz > b.z1) return false;
  } else {
    const inv = 1 / dz;
    let t0 = (b.z0 - oz) * inv;
    let t1 = (b.z1 - oz) * inv;
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > 0) inside = false;
    if (t0 > tmin) tmin = t0;
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return false;
  }
  return !inside;
}

/** Uniform grid over boxes for point-in-any-box queries. */
export class BoxIndex {
  private readonly cell = 1;
  private readonly map = new Map<number, number[]>();

  constructor(private readonly boxes: readonly Box[]) {
    boxes.forEach((b, n) => {
      for (let i = Math.floor(b.x0); i <= Math.floor(b.x1); i++) {
        for (let j = Math.floor(b.y0); j <= Math.floor(b.y1); j++) {
          for (let k = Math.floor(b.z0); k <= Math.floor(b.z1); k++) {
            const key = this.key(i, j, k);
            const list = this.map.get(key);
            if (list) list.push(n);
            else this.map.set(key, [n]);
          }
        }
      }
    });
  }

  private key(i: number, j: number, k: number): number {
    return ((i + 512) * 1024 + (j + 512)) * 1024 + (k + 512);
  }

  /** Indices of the boxes that overlap the region (with positive volume). */
  overlapping(r: Box): number[] {
    const out: number[] = [];
    for (let i = Math.floor(r.x0); i <= Math.floor(r.x1); i++) {
      for (let j = Math.floor(r.y0); j <= Math.floor(r.y1); j++) {
        for (let k = Math.floor(r.z0); k <= Math.floor(r.z1); k++) {
          const list = this.map.get(this.key(i, j, k));
          if (!list) continue;
          for (const n of list) {
            if (!out.includes(n) && boxesOverlap(this.boxes[n], r)) out.push(n);
          }
        }
      }
    }
    return out;
  }

  /** True if the point lies inside (or on the boundary of) any box. */
  inside(x: number, y: number, z: number): boolean {
    const list = this.map.get(
      this.key(Math.floor(x), Math.floor(y), Math.floor(z)),
    );
    if (!list) return false;
    for (const n of list) {
      if (containsPoint(this.boxes[n], x, y, z)) return true;
    }
    return false;
  }

  /** True if the point lies strictly inside any box. */
  insideStrict(x: number, y: number, z: number): boolean {
    const list = this.map.get(
      this.key(Math.floor(x), Math.floor(y), Math.floor(z)),
    );
    if (!list) return false;
    for (const n of list) {
      const b = this.boxes[n];
      if (x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1 && z > b.z0 && z < b.z1)
        return true;
    }
    return false;
  }
}

/**
 * Uniform grid over boxes for "which boxes might touch this region?":
 * `forEachNear` calls back once with every box whose closed extent shares a
 * grid cell with the closed query region (a superset of the boxes touching
 * it), in no particular order. Callers apply their own exact test.
 */
export class BoxGrid {
  private readonly map = new Map<number, number[]>();
  private readonly stamp: Uint32Array;
  private tick = 0;

  constructor(
    boxes: readonly Box[],
    private readonly cell = 1,
  ) {
    this.stamp = new Uint32Array(boxes.length);
    boxes.forEach((b, n) => {
      const c = this.cell;
      for (let i = Math.floor(b.x0 / c); i <= Math.floor(b.x1 / c); i++) {
        for (let j = Math.floor(b.y0 / c); j <= Math.floor(b.y1 / c); j++) {
          for (let k = Math.floor(b.z0 / c); k <= Math.floor(b.z1 / c); k++) {
            const key = BoxGrid.key(i, j, k);
            const list = this.map.get(key);
            if (list) list.push(n);
            else this.map.set(key, [n]);
          }
        }
      }
    });
  }

  private static key(i: number, j: number, k: number): number {
    return ((i + 2048) * 4096 + (j + 2048)) * 4096 + (k + 2048);
  }

  /** Every box near the region lo..hi (each once). */
  forEachNear(
    lo: readonly number[],
    hi: readonly number[],
    fn: (n: number) => void,
  ): void {
    const c = this.cell;
    const t = ++this.tick;
    for (let i = Math.floor(lo[0] / c); i <= Math.floor(hi[0] / c); i++) {
      for (let j = Math.floor(lo[1] / c); j <= Math.floor(hi[1] / c); j++) {
        for (let k = Math.floor(lo[2] / c); k <= Math.floor(hi[2] / c); k++) {
          const list = this.map.get(BoxGrid.key(i, j, k));
          if (!list) continue;
          for (const n of list) {
            if (this.stamp[n] === t) continue;
            this.stamp[n] = t;
            fn(n);
          }
        }
      }
    }
  }
}

/**
 * True if the union of the indexed boxes covers the whole region. Exact: the
 * region is cut at every box boundary that crosses it and each piece's centre
 * is tested.
 */
export function regionCovered(
  index: BoxIndex,
  boxes: readonly Box[],
  r: Box,
): boolean {
  const ids = index.overlapping(r);
  if (ids.length === 0) return false;
  const xs = [r.x0, r.x1];
  const ys = [r.y0, r.y1];
  const zs = [r.z0, r.z1];
  for (const n of ids) {
    const b = boxes[n];
    if (b.x0 > r.x0 && b.x0 < r.x1) xs.push(b.x0);
    if (b.x1 > r.x0 && b.x1 < r.x1) xs.push(b.x1);
    if (b.y0 > r.y0 && b.y0 < r.y1) ys.push(b.y0);
    if (b.y1 > r.y0 && b.y1 < r.y1) ys.push(b.y1);
    if (b.z0 > r.z0 && b.z0 < r.z1) zs.push(b.z0);
    if (b.z1 > r.z0 && b.z1 < r.z1) zs.push(b.z1);
  }
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  zs.sort((a, b) => a - b);
  for (let i = 0; i < xs.length - 1; i++) {
    if (xs[i + 1] - xs[i] < 1e-9) continue;
    const x = (xs[i] + xs[i + 1]) / 2;
    for (let j = 0; j < ys.length - 1; j++) {
      if (ys[j + 1] - ys[j] < 1e-9) continue;
      const y = (ys[j] + ys[j + 1]) / 2;
      for (let k = 0; k < zs.length - 1; k++) {
        if (zs[k + 1] - zs[k] < 1e-9) continue;
        const z = (zs[k] + zs[k + 1]) / 2;
        if (!ids.some((n) => containsPoint(boxes[n], x, y, z))) return false;
      }
    }
  }
  return true;
}

/** The box grown by `d` on every side. */
export function grow(b: Box, d: number): Box {
  return {
    x0: b.x0 - d,
    y0: b.y0 - d,
    z0: b.z0 - d,
    x1: b.x1 + d,
    y1: b.y1 + d,
    z1: b.z1 + d,
  };
}
