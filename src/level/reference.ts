/**
 * Reference versions of the level pipeline as it was before it was made to
 * scale (plain dense voxel flood, every light against every blocker, every
 * brush face against every brush), kept only so that tests can prove the
 * fast versions give identical results (pipeline.test.ts). Not used by the
 * game.
 */
import type { Brush, Color, LightDef } from "../core/api";
import { BOX_FACES } from "../core/mesh";
import type { AirGrid } from "./airgrid";
import {
  BoxIndex,
  boxOf,
  containsPoint,
  regionCovered,
  segmentHitsBox,
  type Box,
} from "./geometry";
import { GRID, isSeeThrough, type FaceCells } from "./meshgen";

/**
 * Voxel flood fill of the open air reachable from a seed point. Used to drop
 * faces that no one can ever see (the outside of every wall, closed-off gaps).
 *
 * Rasterisation is conservative towards air: a voxel is solid only if the
 * union of the brushes covers all of it (tested exactly), so thin gaps and
 * partly filled voxels next to a surface count as air. `air` boxes (door
 * volumes: space a moving slab may occupy) are always air, whatever brushes
 * say. The fill takes every air voxel connected to the seed, not only those
 * a player could stand in, so anything visible from reachable air is kept.
 */
export class DenseAirGrid {
  private readonly res: number;
  private readonly ox: number;
  private readonly oy: number;
  private readonly oz: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly nz: number;
  /** 0 air, 1 solid, 2 reached, 3 partly covered (pending). */
  private readonly cells: Uint8Array;

  constructor(
    boxes: readonly Box[],
    seed: { x: number; y: number; z: number },
    res = 0.1,
    air: readonly Box[] = [],
  ) {
    this.res = res;
    let x0 = Infinity;
    let y0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let z1 = -Infinity;
    for (const b of boxes) {
      x0 = Math.min(x0, b.x0);
      y0 = Math.min(y0, b.y0);
      z0 = Math.min(z0, b.z0);
      x1 = Math.max(x1, b.x1);
      y1 = Math.max(y1, b.y1);
      z1 = Math.max(z1, b.z1);
    }
    const margin = 0.5;
    this.ox = x0 - margin;
    this.oy = y0 - margin;
    this.oz = z0 - margin;
    this.nx = Math.ceil((x1 - x0 + 2 * margin) / res);
    this.ny = Math.ceil((y1 - y0 + 2 * margin) / res);
    this.nz = Math.ceil((z1 - z0 + 2 * margin) / res);
    this.cells = new Uint8Array(this.nx * this.ny * this.nz);
    const { cells } = this;

    // Voxels wholly inside one brush are solid; voxels a brush only partly
    // covers are settled below against the union of all brushes.
    const eps = 1e-7;
    const span = (lo: number, hi: number, o: number, n: number) => ({
      full0: Math.max(0, Math.ceil((lo - o) / res - eps)),
      full1: Math.min(n - 1, Math.floor((hi - o) / res + eps) - 1),
      part0: Math.max(0, Math.floor((lo - o) / res + eps)),
      part1: Math.min(n - 1, Math.ceil((hi - o) / res - eps) - 1),
    });
    for (const b of boxes) {
      const sx = span(b.x0, b.x1, this.ox, this.nx);
      const sy = span(b.y0, b.y1, this.oy, this.ny);
      const sz = span(b.z0, b.z1, this.oz, this.nz);
      for (let k = sz.part0; k <= sz.part1; k++) {
        const kFull = k >= sz.full0 && k <= sz.full1;
        for (let j = sy.part0; j <= sy.part1; j++) {
          const jFull = kFull && j >= sy.full0 && j <= sy.full1;
          let idx = this.index(sx.part0, j, k);
          for (let i = sx.part0; i <= sx.part1; i++, idx++) {
            if (jFull && i >= sx.full0 && i <= sx.full1) cells[idx] = 1;
            else if (cells[idx] === 0) cells[idx] = 3;
          }
        }
      }
    }
    const index = new BoxIndex(boxes);
    const plane = this.nx * this.ny;
    for (let idx = 0; idx < cells.length; idx++) {
      if (cells[idx] !== 3) continue;
      const i = idx % this.nx;
      const j = Math.floor(idx / this.nx) % this.ny;
      const k = Math.floor(idx / plane);
      const vx = this.ox + i * res;
      const vy = this.oy + j * res;
      const vz = this.oz + k * res;
      const voxel = {
        x0: vx,
        y0: vy,
        z0: vz,
        x1: vx + res,
        y1: vy + res,
        z1: vz + res,
      };
      cells[idx] = regionCovered(index, boxes, voxel) ? 1 : 0;
    }
    // Door volumes are air whatever overlaps them.
    for (const b of air) {
      const sx = span(b.x0, b.x1, this.ox, this.nx);
      const sy = span(b.y0, b.y1, this.oy, this.ny);
      const sz = span(b.z0, b.z1, this.oz, this.nz);
      for (let k = sz.part0; k <= sz.part1; k++) {
        for (let j = sy.part0; j <= sy.part1; j++) {
          for (let i = sx.part0; i <= sx.part1; i++) {
            cells[this.index(i, j, k)] = 0;
          }
        }
      }
    }

    // Flood fill from the seed.
    const start = this.indexAt(seed.x, seed.y, seed.z);
    if (start < 0 || cells[start] !== 0) {
      throw new Error("AirGrid: seed point is not in open air");
    }
    const queue = new Int32Array(cells.length);
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    cells[start] = 2;
    const sx = 1;
    const sy = this.nx;
    const sz = plane;
    const { nx, ny, nz } = this;
    while (head < tail) {
      const idx = queue[head++];
      const i = idx % nx;
      const j = Math.floor(idx / nx) % ny;
      const k = Math.floor(idx / sz);
      if (i > 0 && cells[idx - sx] === 0) {
        cells[idx - sx] = 2;
        queue[tail++] = idx - sx;
      }
      if (i < nx - 1 && cells[idx + sx] === 0) {
        cells[idx + sx] = 2;
        queue[tail++] = idx + sx;
      }
      if (j > 0 && cells[idx - sy] === 0) {
        cells[idx - sy] = 2;
        queue[tail++] = idx - sy;
      }
      if (j < ny - 1 && cells[idx + sy] === 0) {
        cells[idx + sy] = 2;
        queue[tail++] = idx + sy;
      }
      if (k > 0 && cells[idx - sz] === 0) {
        cells[idx - sz] = 2;
        queue[tail++] = idx - sz;
      }
      if (k < nz - 1 && cells[idx + sz] === 0) {
        cells[idx + sz] = 2;
        queue[tail++] = idx + sz;
      }
    }
    this.reachedCount = tail;
    // Reaching the grid margin means the level leaks.
    this.leaks = this.touchesBorder();
  }

  /** Number of air cells reached by the flood fill. */
  readonly reachedCount: number;
  /** True if the flood fill reached the outer border of the grid. */
  readonly leaks: boolean;

  private index(i: number, j: number, k: number): number {
    return i + this.nx * (j + this.ny * k);
  }

  private indexAt(x: number, y: number, z: number): number {
    const i = Math.floor((x - this.ox) / this.res);
    const j = Math.floor((y - this.oy) / this.res);
    const k = Math.floor((z - this.oz) / this.res);
    if (
      i < 0 ||
      j < 0 ||
      k < 0 ||
      i >= this.nx ||
      j >= this.ny ||
      k >= this.nz
    ) {
      return -1;
    }
    return this.index(i, j, k);
  }

  private touchesBorder(): boolean {
    const { nx, ny, nz, cells } = this;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const onBorder =
            i === 0 ||
            j === 0 ||
            k === 0 ||
            i === nx - 1 ||
            j === ny - 1 ||
            k === nz - 1;
          if (onBorder && cells[this.index(i, j, k)] === 2) return true;
        }
      }
    }
    return false;
  }

  /** True if the point is in air connected to the seed. */
  reachable(x: number, y: number, z: number): boolean {
    const idx = this.indexAt(x, y, z);
    return idx >= 0 && this.cells[idx] === 2;
  }

  /** True if any voxel overlapping the box is reachable air. */
  reachableIn(b: Box): boolean {
    const i0 = Math.max(0, Math.floor((b.x0 - this.ox) / this.res));
    const i1 = Math.min(this.nx - 1, Math.floor((b.x1 - this.ox) / this.res));
    const j0 = Math.max(0, Math.floor((b.y0 - this.oy) / this.res));
    const j1 = Math.min(this.ny - 1, Math.floor((b.y1 - this.oy) / this.res));
    const k0 = Math.max(0, Math.floor((b.z0 - this.oz) / this.res));
    const k1 = Math.min(this.nz - 1, Math.floor((b.z1 - this.oz) / this.res));
    for (let k = k0; k <= k1; k++) {
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          if (this.cells[this.index(i, j, k)] === 2) return true;
        }
      }
    }
    return false;
  }
}
/** Maximum value of any baked colour channel. */
const MAX_BAKED = 2.0;
/** Distance the shadow ray origin is lifted off the surface. */
const NORMAL_OFFSET = 0.02;
/** Blockers are shrunk by this much so surface-touching boxes do not occlude. */
const SHRINK = 1e-3;

/** Fixed jitter of the light position, in metres (each within 0.15 m). */
const JITTER: readonly (readonly [number, number, number])[] = [
  [0.1, 0.08, 0.1],
  [-0.1, -0.08, 0.1],
  [0.1, -0.08, -0.1],
  [-0.1, 0.08, -0.1],
];

/**
 * Fraction of light a see-through brush (a floor grate) stops: its solid
 * area. Shadow rays through it carry on with the rest.
 */
const SEE_THROUGH_OPACITY = 0.55;

interface ReferenceLight {
  def: LightDef;
  /** Opaque brushes that can possibly block this light's rays. */
  blockers: Box[];
  /** See-through brushes that can possibly dim them. */
  filters: Box[];
  /** Index of the blocker that stopped the latest blocked ray. */
  lastBlocker: number;
}

/** Bakes steady lights into per-vertex colours. */
export class ReferenceLightBaker {
  private readonly lights: ReferenceLight[] = [];
  private readonly ambient: Color;

  /**
   * `seeThrough[i]` marks brush i as see-through: it passes
   * 1 - SEE_THROUGH_OPACITY of the light instead of blocking it.
   */
  constructor(
    brushes: readonly Box[],
    lights: readonly LightDef[],
    ambient: Color,
    seeThrough: readonly boolean[] = [],
  ) {
    this.ambient = ambient;
    const shrunk = brushes.map((b) => ({
      x0: b.x0 + SHRINK,
      y0: b.y0 + SHRINK,
      z0: b.z0 + SHRINK,
      x1: b.x1 - SHRINK,
      y1: b.y1 - SHRINK,
      z1: b.z1 - SHRINK,
    }));
    for (const def of lights) {
      if (def.flicker !== "none") continue;
      const p = def.position;
      const r = def.radius;
      const near = (b: Box): boolean =>
        b.x0 < p.x + r &&
        b.x1 > p.x - r &&
        b.y0 < p.y + r &&
        b.y1 > p.y - r &&
        b.z0 < p.z + r &&
        b.z1 > p.z - r;
      this.lights.push({
        def,
        blockers: shrunk.filter((b, i) => !seeThrough[i] && near(b)),
        filters: shrunk.filter((b, i) => seeThrough[i] === true && near(b)),
        lastBlocker: 0,
      });
    }
  }

  /** Fraction of the light visible from the point, averaged over jitter samples. */
  private visibility(
    light: ReferenceLight,
    ox: number,
    oy: number,
    oz: number,
  ): number {
    const lp = light.def.position;
    let visible = 0;
    for (const j of JITTER) {
      const dx = lp.x + j[0] - ox;
      const dy = lp.y + j[1] - oy;
      const dz = lp.z + j[2] - oz;
      // Neighbouring samples are mostly shadowed by the same brush, so the
      // last blocker found is tried first (the answer does not depend on
      // the order).
      const blockers = light.blockers;
      let blocked =
        light.lastBlocker < blockers.length &&
        segmentHitsBox(ox, oy, oz, dx, dy, dz, 1, blockers[light.lastBlocker]);
      // Boxes clear of the segment's bounds cannot block it.
      const x0 = Math.min(ox, ox + dx);
      const x1 = Math.max(ox, ox + dx);
      const y0 = Math.min(oy, oy + dy);
      const y1 = Math.max(oy, oy + dy);
      const z0 = Math.min(oz, oz + dz);
      const z1 = Math.max(oz, oz + dz);
      for (let i = 0; !blocked && i < blockers.length; i++) {
        const b = blockers[i];
        if (
          b.x0 > x1 ||
          b.x1 < x0 ||
          b.y0 > y1 ||
          b.y1 < y0 ||
          b.z0 > z1 ||
          b.z1 < z0
        ) {
          continue;
        }
        if (segmentHitsBox(ox, oy, oz, dx, dy, dz, 1, b)) {
          blocked = true;
          light.lastBlocker = i;
        }
      }
      if (blocked) continue;
      // A ray starting inside a grate (a point just under it) still passes
      // through it.
      let pass = 1;
      for (const b of light.filters) {
        if (
          containsPoint(b, ox, oy, oz) ||
          segmentHitsBox(ox, oy, oz, dx, dy, dz, 1, b)
        ) {
          pass *= 1 - SEE_THROUGH_OPACITY;
        }
      }
      visible += pass;
    }
    return visible / JITTER.length;
  }

  /** Lit colour (linear RGB) at a surface point with a unit normal. */
  sample(
    px: number,
    py: number,
    pz: number,
    nx: number,
    ny: number,
    nz: number,
  ): [number, number, number] {
    let r = this.ambient.x;
    let g = this.ambient.y;
    let b = this.ambient.z;
    for (const light of this.lights) {
      const lp = light.def.position;
      const dx = lp.x - px;
      const dy = lp.y - py;
      const dz = lp.z - pz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const radius = light.def.radius;
      if (d >= radius || d < 1e-6) continue;
      const ndl = (nx * dx + ny * dy + nz * dz) / d;
      if (ndl <= 0) continue;
      const falloff = 1 - d / radius;
      const vis = this.visibility(
        light,
        px + nx * NORMAL_OFFSET,
        py + ny * NORMAL_OFFSET,
        pz + nz * NORMAL_OFFSET,
      );
      if (vis === 0) continue;
      const k = light.def.intensity * ndl * falloff * falloff * vis;
      r += light.def.color.x * k;
      g += light.def.color.y * k;
      b += light.def.color.z * k;
    }
    return [
      Math.min(r, MAX_BAKED),
      Math.min(g, MAX_BAKED),
      Math.min(b, MAX_BAKED),
    ];
  }
}
/**
 * How far in front of a face the reachable-air test looks: any voxel touching
 * this thin slab in front of a cell that is reachable air makes it visible.
 */
const PROBE_DEPTH = 0.02;
/** Offset used to test what lies just in front of a face. */
const FRONT = 1e-4;

type Axis = 0 | 1 | 2;

function axisOf(vec: { x: number; y: number; z: number }): {
  axis: Axis;
  sign: 1 | -1;
} {
  if (vec.x !== 0) return { axis: 0, sign: vec.x > 0 ? 1 : -1 };
  if (vec.y !== 0) return { axis: 1, sign: vec.y > 0 ? 1 : -1 };
  return { axis: 2, sign: vec.z > 0 ? 1 : -1 };
}

const lowOf = (b: Box, axis: Axis): number =>
  axis === 0 ? b.x0 : axis === 1 ? b.y0 : b.z0;
const highOf = (b: Box, axis: Axis): number =>
  axis === 0 ? b.x1 : axis === 1 ? b.y1 : b.z1;

/**
 * Breakpoints between lo and hi: the world grid plus any extra cut points,
 * sorted, deduplicated, always including both ends.
 */
function breaks(lo: number, hi: number, extra: readonly number[]): number[] {
  const all = [lo, hi];
  for (let m = Math.floor(lo / GRID) + 1; m * GRID < hi - 1e-6; m++) {
    if (m * GRID > lo + 1e-6) all.push(m * GRID);
  }
  for (const e of extra) if (e > lo + 1e-6 && e < hi - 1e-6) all.push(e);
  all.sort((a, b) => a - b);
  const out = [all[0]];
  for (let i = 1; i < all.length; i++) {
    if (all[i] - out[out.length - 1] > 1e-6) out.push(all[i]);
  }
  out[out.length - 1] = hi;
  return out;
}

/**
 * Splits every brush face into cells and decides which can be seen.
 *
 * A face is cut on the world grid and also at every edge of every brush that
 * touches it from the front, so that each cell is either wholly covered or
 * wholly uncovered: testing the cell centre is then exact. A cell is drawn if
 * it is uncovered and any voxel just in front of it is reachable air.
 *
 * See-through brushes cover only the faces of other see-through brushes
 * (so two of them never both draw where they touch); the faces of a
 * see-through brush are covered by any brush.
 */
export function referenceFaceCells(
  brushes: readonly Brush[],
  air: AirGrid,
): FaceCells[] {
  const boxes = brushes.map(boxOf);
  const index = new BoxIndex(boxes);
  const opaque = new BoxIndex(
    boxes.filter((_, n) => !isSeeThrough(brushes[n])),
  );
  const out: FaceCells[] = [];
  const pos = [0, 0, 0];
  boxes.forEach((box, n) => {
    const covers = isSeeThrough(brushes[n]) ? index : opaque;
    for (const basis of BOX_FACES) {
      const na = axisOf(basis.normal);
      const ua = axisOf(basis.u);
      const va = axisOf(basis.v);
      const plane = na.sign > 0 ? highOf(box, na.axis) : lowOf(box, na.axis);
      const u0 = lowOf(box, ua.axis);
      const u1 = highOf(box, ua.axis);
      const v0 = lowOf(box, va.axis);
      const v1 = highOf(box, va.axis);
      // Brushes that occupy the space just in front of the face.
      const front = plane + na.sign * FRONT;
      const cutU: number[] = [];
      const cutV: number[] = [];
      boxes.forEach((o, m) => {
        if (m === n) return;
        if (lowOf(o, na.axis) > front || highOf(o, na.axis) < front) return;
        if (lowOf(o, ua.axis) >= u1 || highOf(o, ua.axis) <= u0) return;
        if (lowOf(o, va.axis) >= v1 || highOf(o, va.axis) <= v0) return;
        cutU.push(lowOf(o, ua.axis), highOf(o, ua.axis));
        cutV.push(lowOf(o, va.axis), highOf(o, va.axis));
      });
      const us = breaks(u0, u1, cutU);
      const vs = breaks(v0, v1, cutV);
      const visible = new Uint8Array((us.length - 1) * (vs.length - 1));
      const probe: Box = { x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0 };
      const setProbe = (axis: Axis, lo: number, hi: number): void => {
        if (axis === 0) {
          probe.x0 = lo;
          probe.x1 = hi;
        } else if (axis === 1) {
          probe.y0 = lo;
          probe.y1 = hi;
        } else {
          probe.z0 = lo;
          probe.z1 = hi;
        }
      };
      const depth0 = na.sign > 0 ? plane + FRONT : plane - PROBE_DEPTH;
      const depth1 = na.sign > 0 ? plane + PROBE_DEPTH : plane - FRONT;
      for (let i = 0; i < us.length - 1; i++) {
        for (let j = 0; j < vs.length - 1; j++) {
          pos[na.axis] = front;
          pos[ua.axis] = (us[i] + us[i + 1]) / 2;
          pos[va.axis] = (vs[j] + vs[j + 1]) / 2;
          // Covered by another brush: hidden.
          if (covers.inside(pos[0], pos[1], pos[2])) continue;
          // Facing only air that the player can never reach: hidden.
          setProbe(na.axis, depth0, depth1);
          setProbe(ua.axis, us[i] + FRONT, us[i + 1] - FRONT);
          setProbe(va.axis, vs[j] + FRONT, vs[j + 1] - FRONT);
          if (!air.reachableIn(probe)) continue;
          visible[i * (vs.length - 1) + j] = 1;
        }
      }
      out.push({
        brush: n,
        basis,
        material: brushes[n].faces?.[basis.face] ?? brushes[n].material,
        n: na.axis,
        sign: na.sign,
        u: ua.axis,
        uSign: ua.sign,
        v: va.axis,
        vSign: va.sign,
        plane,
        us,
        vs,
        visible,
      });
    }
  });
  return out;
}
