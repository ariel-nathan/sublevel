import type { Brush } from "../core/api";
import { MATERIALS, type MaterialId } from "../core/materials";
import { BOX_FACES, MeshBuilder, type MeshData } from "../core/mesh";
import type { AirGrid } from "./airgrid";
import type { LightBaker } from "./bake";
import { boxOf, containsPoint, type Box } from "./geometry";

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

/** How far in front of a face cell the reachable-air probes look. */
const PROBE_DISTANCES = [0.06, 0.15];

/** Uniform grid over brush boxes for point-in-brush queries. */
class BrushIndex {
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
}

/** Breakpoints of the grid between lo and hi, always including both ends. */
function breaks(lo: number, hi: number): number[] {
  const out = [lo];
  for (let m = Math.floor(lo / GRID) + 1; m * GRID < hi - 1e-6; m++) {
    if (m * GRID > lo + 1e-6) out.push(m * GRID);
  }
  out.push(hi);
  return out;
}

function axisOf(vec: { x: number; y: number; z: number }): {
  axis: 0 | 1 | 2;
  sign: 1 | -1;
} {
  if (vec.x !== 0) return { axis: 0, sign: vec.x > 0 ? 1 : -1 };
  if (vec.y !== 0) return { axis: 1, sign: vec.y > 0 ? 1 : -1 };
  return { axis: 2, sign: vec.z > 0 ? 1 : -1 };
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
  const boxes = brushes.map(boxOf);
  const index = new BrushIndex(boxes);
  const builders = new Map<MaterialId, MeshBuilder>();
  const builderFor = (material: MaterialId): MeshBuilder => {
    let b = builders.get(material);
    if (!b) {
      b = new MeshBuilder(material);
      builders.set(material, b);
    }
    return b;
  };

  const pos = [0, 0, 0];
  const lo = [0, 0, 0];
  const hi = [0, 0, 0];

  brushes.forEach((brush, n) => {
    const box = boxes[n];
    lo[0] = box.x0;
    lo[1] = box.y0;
    lo[2] = box.z0;
    hi[0] = box.x1;
    hi[1] = box.y1;
    hi[2] = box.z1;
    for (const basis of BOX_FACES) {
      const material = brush.faces?.[basis.face] ?? brush.material;
      const emissive = MATERIALS[material].emissive;
      const tile = TILE_SIZE[material];
      const na = axisOf(basis.normal);
      const ua = axisOf(basis.u);
      const va = axisOf(basis.v);
      const plane = na.sign > 0 ? hi[na.axis] : lo[na.axis];
      const us = breaks(lo[ua.axis], hi[ua.axis]);
      const vs = breaks(lo[va.axis], hi[va.axis]);
      const cache = new Map<number, number>();
      const builder = builderFor(material);

      const vertex = (iu: number, iv: number): number => {
        const key = iu * 4096 + iv;
        const hit = cache.get(key);
        if (hit !== undefined) return hit;
        pos[na.axis] = plane;
        pos[ua.axis] = us[iu];
        pos[va.axis] = vs[iv];
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
          {
            u: (ua.sign * us[iu]) / tile,
            v: (-va.sign * vs[iv]) / tile,
          },
          color,
        );
        cache.set(key, idx);
        return idx;
      };

      for (let i = 0; i < us.length - 1; i++) {
        for (let j = 0; j < vs.length - 1; j++) {
          const cu = (us[i] + us[i + 1]) / 2;
          const cv = (vs[j] + vs[j + 1]) / 2;
          pos[na.axis] = plane;
          pos[ua.axis] = cu;
          pos[va.axis] = cv;
          const sgn = na.sign;
          const px = pos[0] + (na.axis === 0 ? sgn * 0.001 : 0);
          const py = pos[1] + (na.axis === 1 ? sgn * 0.001 : 0);
          const pz = pos[2] + (na.axis === 2 ? sgn * 0.001 : 0);
          // Covered by another brush: hidden.
          if (index.inside(px, py, pz)) continue;
          // Facing only air that the player can never reach: hidden.
          let seen = false;
          for (const d of PROBE_DISTANCES) {
            const qx = pos[0] + (na.axis === 0 ? sgn * d : 0);
            const qy = pos[1] + (na.axis === 1 ? sgn * d : 0);
            const qz = pos[2] + (na.axis === 2 ? sgn * d : 0);
            if (air.reachable(qx, qy, qz)) {
              seen = true;
              break;
            }
          }
          if (!seen) continue;
          // Corners counter-clockwise from the front: bl, br, tr, tl.
          const iu0 = ua.sign > 0 ? i : i + 1;
          const iu1 = ua.sign > 0 ? i + 1 : i;
          const iv0 = va.sign > 0 ? j : j + 1;
          const iv1 = va.sign > 0 ? j + 1 : j;
          const bl = vertex(iu0, iv0);
          const br = vertex(iu1, iv0);
          const tr = vertex(iu1, iv1);
          const tl = vertex(iu0, iv1);
          builder.addTriangle(bl, br, tr);
          builder.addTriangle(bl, tr, tl);
        }
      }
    }
  });

  const meshes: MeshData[] = [];
  for (const builder of builders.values()) {
    if (builder.vertexCount > 0) meshes.push(builder.build());
  }
  return meshes;
}
