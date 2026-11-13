import type { Brush } from "../core/api";
import { MATERIALS, type MaterialId } from "../core/materials";
import { BOX_FACES, MeshBuilder, type MeshData } from "../core/mesh";
import type { AirGrid } from "./airgrid";
import type { LightBaker } from "./bake";
import { boxOf, BoxIndex, type Box } from "./geometry";

/** Largest cell edge of the world-aligned tessellation grid, in metres. */
export const GRID = 0.5;

/** Size in metres of one texture repeat, per material. */
export const TILE_SIZE: Readonly<Record<MaterialId, number>> = {
  concrete_wall: 2,
  concrete_floor: 2,
  ceiling_panel: 2,
  lab_wall: 2,
  lab_floor_tile: 2,
  metal_panel: 2,
  metal_grate: 1,
  hazard_stripe: 1,
  door_steel: 2,
  crate_wood: 1,
  crate_wood_weak: 1,
  crate_metal: 1,
  barrel_side: 1,
  barrel_top: 1,
  pipe: 1,
  plastic_white: 1,
  rubber_dark: 1,
  pressure_plate: 1,
  sign_warning: 1,
  light_panel: 1,
  button_red: 0.25,
  button_green: 0.25,
  monitor_screen: 0.5,
};

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

/** Materials whose texture is fitted once to each brush face. */
const FITTED_MATERIALS: ReadonlySet<MaterialId> = new Set([
  "sign_warning",
  "monitor_screen",
]);

/**
 * Materials drawn with a cut-out texture (gaps the eye passes through). A
 * brush whose material is one of these is "see-through": it is solid to
 * physics and to walking, but for visibility it hides nothing of the other
 * brushes and the air under or behind it counts as visible air (see
 * `levelAir`), so whatever lies beyond it is emitted. Its own faces are
 * emitted, top and underside alike, wherever they border visible air.
 */
export const SEE_THROUGH_MATERIALS: ReadonlySet<MaterialId> = new Set([
  "metal_grate",
]);

/** True if the brush is see-through (see SEE_THROUGH_MATERIALS). */
export function isSeeThrough(brush: Brush): boolean {
  return SEE_THROUGH_MATERIALS.has(brush.material);
}

/** One brush face cut into cells, with the cells that must be drawn. */
export interface FaceCells {
  brush: number;
  basis: (typeof BOX_FACES)[number];
  material: MaterialId;
  /** Normal, u and v axes (0 x, 1 y, 2 z) with their signs. */
  n: Axis;
  sign: 1 | -1;
  u: Axis;
  uSign: 1 | -1;
  v: Axis;
  vSign: 1 | -1;
  /** Coordinate of the face plane along `n`. */
  plane: number;
  /** Cut points along the u and v axes (world coordinates, ascending). */
  us: number[];
  vs: number[];
  /** visible[i * (vs.length - 1) + j] for the cell us[i]..us[i+1] x vs[j]..vs[j+1]. */
  visible: Uint8Array;
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
export function faceCells(
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

/**
 * Calls `fn` with the world-space corners of every visible cell of a face,
 * counter-clockwise seen from the front (bl, br, tr, tl).
 */
export function forEachVisibleCell(
  f: FaceCells,
  fn: (corners: number[][]) => void,
): void {
  const { us, vs } = f;
  const at = (u: number, v: number): number[] => {
    const p = [0, 0, 0];
    p[f.n] = f.plane;
    p[f.u] = u;
    p[f.v] = v;
    return p;
  };
  for (let i = 0; i < us.length - 1; i++) {
    for (let j = 0; j < vs.length - 1; j++) {
      if (!f.visible[i * (vs.length - 1) + j]) continue;
      const u0 = f.uSign > 0 ? us[i] : us[i + 1];
      const u1 = f.uSign > 0 ? us[i + 1] : us[i];
      const v0 = f.vSign > 0 ? vs[j] : vs[j + 1];
      const v1 = f.vSign > 0 ? vs[j + 1] : vs[j];
      fn([at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)]);
    }
  }
}

/**
 * Every emitted vertex, grouped by the axis-aligned lines through it, to find
 * the vertices that lie inside an edge.
 */
class EdgeLines {
  private readonly lines = new Map<string, number[]>();
  private readonly sorted = new Set<string>();

  private static key(p: readonly number[], axis: number): string {
    const a = p[(axis + 1) % 3].toFixed(5);
    const b = p[(axis + 2) % 3].toFixed(5);
    return `${axis}|${a}|${b}`;
  }

  add(p: readonly number[]): void {
    for (let axis = 0; axis < 3; axis++) {
      const key = EdgeLines.key(p, axis);
      const list = this.lines.get(key);
      if (list) list.push(p[axis]);
      else this.lines.set(key, [p[axis]]);
      this.sorted.delete(key);
    }
  }

  /** Points strictly inside the axis-aligned segment a..b, in order from a. */
  between(a: readonly number[], b: readonly number[]): number[][] {
    const axis = a[0] !== b[0] ? 0 : a[1] !== b[1] ? 1 : 2;
    const key = EdgeLines.key(a, axis);
    const list = this.lines.get(key);
    if (!list) return [];
    if (!this.sorted.has(key)) {
      list.sort((p, q) => p - q);
      this.sorted.add(key);
    }
    const lo = Math.min(a[axis], b[axis]) + 1e-5;
    const hi = Math.max(a[axis], b[axis]) - 1e-5;
    const out: number[][] = [];
    let last = NaN;
    for (const t of list) {
      if (t <= lo || t >= hi || Math.abs(t - last) < 1e-5) continue;
      last = t;
      const p = [a[0], a[1], a[2]];
      p[axis] = t;
      out.push(p);
    }
    if (a[axis] > b[axis]) out.reverse();
    return out;
  }
}

/**
 * Turns brushes into one mesh per material: faces are tessellated on a
 * world-aligned grid, cells that cannot be seen are dropped, and every vertex
 * gets a baked colour.
 */
export function generateMeshes(
  brushes: readonly Brush[],
  air: AirGrid,
  baker: LightBaker,
): MeshData[] {
  const builders = new Map<MaterialId, MeshBuilder>();
  const builderFor = (material: MaterialId): MeshBuilder => {
    let b = builders.get(material);
    if (!b) {
      b = new MeshBuilder(material);
      builders.set(material, b);
    }
    return b;
  };

  const faces = faceCells(brushes, air);
  const lines = new EdgeLines();
  for (const f of faces) {
    forEachVisibleCell(f, (corners) => {
      for (const c of corners) lines.add(c);
    });
  }

  for (const f of faces) {
    const { basis, material } = f;
    const emissive = MATERIALS[material].emissive;
    const tile = TILE_SIZE[material];
    // Signs and screens are pictures, not tiling surfaces: stretch the
    // texture exactly once over the face instead of tiling it in world space.
    const fitted = FITTED_MATERIALS.has(material);
    const uMin = f.us[0];
    const uMax = f.us[f.us.length - 1];
    const vMin = f.vs[0];
    const vMax = f.vs[f.vs.length - 1];
    const uSpan = Math.max(uMax - uMin, 1e-6);
    const vSpan = Math.max(vMax - vMin, 1e-6);
    const cache = new Map<string, number>();
    const builder = builderFor(material);

    const vertex = (pos: readonly number[]): number => {
      const key = `${pos[0].toFixed(5)},${pos[1].toFixed(5)},${pos[2].toFixed(5)}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const color = emissive
        ? { x: 1, y: 1, z: 1 }
        : (() => {
            const c = baker.sample(
              pos[0],
              pos[1],
              pos[2],
              basis.normal.x,
              basis.normal.y,
              basis.normal.z,
            );
            return { x: c[0], y: c[1], z: c[2] };
          })();
      const idx = builder.addVertex(
        { x: pos[0], y: pos[1], z: pos[2] },
        basis.normal,
        fitted
          ? {
              // One repeat across the face, upright, left to right.
              u: (f.uSign > 0 ? pos[f.u] - uMin : uMax - pos[f.u]) / uSpan,
              v: (f.vSign > 0 ? vMax - pos[f.v] : pos[f.v] - vMin) / vSpan,
            }
          : {
              u: (f.uSign * pos[f.u]) / tile,
              v: (-f.vSign * pos[f.v]) / tile,
            },
        color,
      );
      cache.set(key, idx);
      return idx;
    };

    forEachVisibleCell(f, (corners) => {
      // The cell outline with every vertex of other cells that lies on one
      // of its edges, so that no edge ends in a T-junction (they rasterise
      // with pinhole cracks).
      const ring: number[][] = [];
      for (let e = 0; e < 4; e++) {
        const a = corners[e];
        const b = corners[(e + 1) % 4];
        ring.push(a);
        for (const p of lines.between(a, b)) ring.push(p);
      }
      if (ring.length === 4) {
        const [bl, br, tr, tl] = corners.map(vertex);
        builder.addTriangle(bl, br, tr);
        builder.addTriangle(bl, tr, tl);
        return;
      }
      const centre = [0, 1, 2].map((k) => (corners[0][k] + corners[2][k]) / 2);
      const c = vertex(centre);
      const ids = ring.map(vertex);
      for (let k = 0; k < ids.length; k++) {
        builder.addTriangle(c, ids[k], ids[(k + 1) % ids.length]);
      }
    });
  }

  const meshes: MeshData[] = [];
  for (const builder of builders.values()) {
    if (builder.vertexCount > 0) meshes.push(builder.build());
  }
  return meshes;
}
