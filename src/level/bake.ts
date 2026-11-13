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
 * Fraction of light a see-through brush (a floor grate) stops: its solid
 * area. Shadow rays through it carry on with the rest.
 */
export const SEE_THROUGH_OPACITY = 0.55;

interface BakedLight {
  def: LightDef;
  /** Opaque brushes that can possibly block this light's rays. */
  blockers: Box[];
  /** See-through brushes that can possibly dim them. */
  filters: Box[];
  /** Index of the blocker that stopped the latest blocked ray. */
  lastBlocker: number;
}

/** Bakes steady lights into per-vertex colours. */
export class LightBaker {
  private readonly lights: BakedLight[] = [];
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
    light: BakedLight,
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
