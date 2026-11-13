import type { Color, LightDef } from "../core/api";
import { containsPoint, segmentHitsBox, type Box } from "./geometry";

/** Maximum value of any baked colour channel. */
export const MAX_BAKED = 2.0;
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
 * Every point of a shadow ray to a jittered light position lies within this
 * distance of the ray to the light's centre (the longest jitter, rounded up).
 */
const JITTER_REACH = 0.17;

/**
 * Fraction of light a see-through brush (a floor grate) stops: its solid
 * area. Shadow rays through it carry on with the rest.
 */
export const SEE_THROUGH_OPACITY = 0.55;

/** Cell size of the per-light blocker grids and of the light lookup grid. */
const BLOCKER_CELL = 1;
const LIGHT_CELL = 2;

interface BakedLight {
  def: LightDef;
  /** Opaque brushes that can possibly block this light's rays. */
  blockers: Box[];
  /**
   * The blockers by cell of a grid around the light (each grown by
   * JITTER_REACH, so a walk along the ray to the light's centre finds every
   * blocker of a ray to any jittered position).
   */
  grid: (number[] | undefined)[];
  gx: number;
  gy: number;
  gz: number;
  nx: number;
  ny: number;
  nz: number;
  /** Mailbox: the query that last collected each blocker. */
  stamp: Uint32Array;
  /** See-through brushes that can possibly dim them. */
  filters: Box[];
  /** Index of the blocker that stopped the latest blocked ray. */
  lastBlocker: number;
}

/**
 * Bakes steady lights into per-vertex colours.
 *
 * Cost stays proportional to the level's size: a point is lit only by the
 * lights whose radius reaches it (found through a coarse grid of lights),
 * and a shadow ray is tested only against the blockers in the grid cells
 * along it. Results are those of testing every light and every blocker.
 */
export class LightBaker {
  private readonly lights: BakedLight[] = [];
  private readonly ambient: Color;
  /** Lights (indices, ascending) whose reach overlaps each LIGHT_CELL cell. */
  private readonly lightCells = new Map<number, number[]>();
  private query = 0;
  private readonly candidates: number[] = [];

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
      const blockers = shrunk.filter((b, i) => !seeThrough[i] && near(b));
      this.lights.push({
        def,
        blockers,
        ...LightBaker.blockerGrid(p, r, blockers),
        stamp: new Uint32Array(blockers.length),
        filters: shrunk.filter((b, i) => seeThrough[i] === true && near(b)),
        lastBlocker: 0,
      });
    }
    this.lights.forEach((light, index) => {
      const p = light.def.position;
      const r = light.def.radius;
      const c = LIGHT_CELL;
      for (
        let i = Math.floor((p.x - r) / c);
        i <= Math.floor((p.x + r) / c);
        i++
      ) {
        for (
          let j = Math.floor((p.y - r) / c);
          j <= Math.floor((p.y + r) / c);
          j++
        ) {
          for (
            let k = Math.floor((p.z - r) / c);
            k <= Math.floor((p.z + r) / c);
            k++
          ) {
            const key = LightBaker.cellKey(i, j, k);
            const list = this.lightCells.get(key);
            if (list) list.push(index);
            else this.lightCells.set(key, [index]);
          }
        }
      }
    });
  }

  private static cellKey(i: number, j: number, k: number): number {
    return ((i + 1024) * 2048 + (j + 1024)) * 2048 + (k + 1024);
  }

  /** A dense grid over the light's reach, each blocker in every cell it (grown) touches. */
  private static blockerGrid(
    p: { x: number; y: number; z: number },
    r: number,
    blockers: readonly Box[],
  ) {
    const c = BLOCKER_CELL;
    const pad = r + NORMAL_OFFSET + JITTER_REACH + c;
    const gx = Math.floor((p.x - pad) / c);
    const gy = Math.floor((p.y - pad) / c);
    const gz = Math.floor((p.z - pad) / c);
    const nx = Math.floor((p.x + pad) / c) - gx + 1;
    const ny = Math.floor((p.y + pad) / c) - gy + 1;
    const nz = Math.floor((p.z + pad) / c) - gz + 1;
    const grid: (number[] | undefined)[] = new Array(nx * ny * nz);
    const g = JITTER_REACH + 1e-3;
    const clampI = (v: number, n: number) => Math.min(n - 1, Math.max(0, v));
    blockers.forEach((b, n) => {
      const i0 = clampI(Math.floor((b.x0 - g) / c) - gx, nx);
      const i1 = clampI(Math.floor((b.x1 + g) / c) - gx, nx);
      const j0 = clampI(Math.floor((b.y0 - g) / c) - gy, ny);
      const j1 = clampI(Math.floor((b.y1 + g) / c) - gy, ny);
      const k0 = clampI(Math.floor((b.z0 - g) / c) - gz, nz);
      const k1 = clampI(Math.floor((b.z1 + g) / c) - gz, nz);
      for (let k = k0; k <= k1; k++) {
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const idx = i + nx * (j + ny * k);
            const list = grid[idx];
            if (list) list.push(n);
            else grid[idx] = [n];
          }
        }
      }
    });
    return { grid, gx, gy, gz, nx, ny, nz };
  }

  /**
   * Blockers in the grid cells along the segment from (ox, oy, oz) to the
   * light's centre (a 3D DDA walk), into `this.candidates`.
   */
  private gather(light: BakedLight, ox: number, oy: number, oz: number): void {
    const out = this.candidates;
    out.length = 0;
    const t = ++this.query;
    const c = BLOCKER_CELL;
    const lp = light.def.position;
    const dx = lp.x - ox;
    const dy = lp.y - oy;
    const dz = lp.z - oz;
    let i = Math.floor(ox / c) - light.gx;
    let j = Math.floor(oy / c) - light.gy;
    let k = Math.floor(oz / c) - light.gz;
    const i1 = Math.floor(lp.x / c) - light.gx;
    const j1 = Math.floor(lp.y / c) - light.gy;
    const k1 = Math.floor(lp.z / c) - light.gz;
    const si = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const sj = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const sk = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    const next = (o: number, d: number, cell: number, s: number, g: number) =>
      s === 0 ? Infinity : ((cell + g + (s > 0 ? 1 : 0)) * c - o) / d;
    let tx = next(ox, dx, i, si, light.gx);
    let ty = next(oy, dy, j, sj, light.gy);
    let tz = next(oz, dz, k, sk, light.gz);
    const ddx = si === 0 ? Infinity : c / Math.abs(dx);
    const ddy = sj === 0 ? Infinity : c / Math.abs(dy);
    const ddz = sk === 0 ? Infinity : c / Math.abs(dz);
    const { nx, ny, nz, grid, stamp } = light;
    for (let steps = 0; steps < 4 * (nx + ny + nz); steps++) {
      if (i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz) {
        const list = grid[i + nx * (j + ny * k)];
        if (list) {
          for (const n of list) {
            if (stamp[n] !== t) {
              stamp[n] = t;
              out.push(n);
            }
          }
        }
      }
      if (i === i1 && j === j1 && k === k1) break;
      if (tx <= ty && tx <= tz) {
        if (tx > 1) break;
        i += si;
        tx += ddx;
      } else if (ty <= tz) {
        if (ty > 1) break;
        j += sj;
        ty += ddy;
      } else {
        if (tz > 1) break;
        k += sk;
        tz += ddz;
      }
    }
  }

  /** Fraction of the light visible from the point, averaged over jitter samples. */
  private visibility(
    light: BakedLight,
    ox: number,
    oy: number,
    oz: number,
  ): number {
    const lp = light.def.position;
    this.gather(light, ox, oy, oz);
    const near = this.candidates;
    const blockers = light.blockers;
    let visible = 0;
    for (const j of JITTER) {
      const dx = lp.x + j[0] - ox;
      const dy = lp.y + j[1] - oy;
      const dz = lp.z + j[2] - oz;
      // Neighbouring samples are mostly shadowed by the same brush, so the
      // last blocker found is tried first (the answer does not depend on
      // the order).
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
      for (let q = 0; !blocked && q < near.length; q++) {
        const i = near[q];
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
    const c = LIGHT_CELL;
    const near = this.lightCells.get(
      LightBaker.cellKey(
        Math.floor(px / c),
        Math.floor(py / c),
        Math.floor(pz / c),
      ),
    );
    if (near) {
      for (const index of near) {
        const light = this.lights[index];
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
    }
    return [
      Math.min(r, MAX_BAKED),
      Math.min(g, MAX_BAKED),
      Math.min(b, MAX_BAKED),
    ];
  }
}
