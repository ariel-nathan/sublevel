/**
 * Ray casting against triangle meshes through a uniform grid. Pure; used by
 * tests to check that the emitted level mesh is sealed from the inside.
 */
import type { MeshData } from "../core/mesh";

export interface MeshHit {
  t: number;
  /** True if the ray hit the triangle's front (counter-clockwise) side. */
  front: boolean;
  material: string;
}

export class TriangleGrid {
  private readonly tris: Float64Array;
  private readonly materials: string[] = [];
  private readonly cell: number;
  private readonly ox: number;
  private readonly oy: number;
  private readonly oz: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly nz: number;
  private readonly cells = new Map<number, number[]>();

  constructor(meshes: readonly MeshData[], cell = 0.5) {
    this.cell = cell;
    const list: number[] = [];
    for (const m of meshes) {
      for (let t = 0; t < m.indices.length; t += 3) {
        for (let k = 0; k < 3; k++) {
          const i = m.indices[t + k];
          list.push(
            m.positions[i * 3],
            m.positions[i * 3 + 1],
            m.positions[i * 3 + 2],
          );
        }
        this.materials.push(m.material);
      }
    }
    this.tris = Float64Array.from(list);
    let x0 = Infinity;
    let y0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let z1 = -Infinity;
    for (let i = 0; i < list.length; i += 3) {
      x0 = Math.min(x0, list[i]);
      y0 = Math.min(y0, list[i + 1]);
      z0 = Math.min(z0, list[i + 2]);
      x1 = Math.max(x1, list[i]);
      y1 = Math.max(y1, list[i + 1]);
      z1 = Math.max(z1, list[i + 2]);
    }
    this.ox = x0 - cell;
    this.oy = y0 - cell;
    this.oz = z0 - cell;
    this.nx = Math.ceil((x1 - x0) / cell) + 3;
    this.ny = Math.ceil((y1 - y0) / cell) + 3;
    this.nz = Math.ceil((z1 - z0) / cell) + 3;
    const pad = 1e-4;
    const n = this.materials.length;
    for (let t = 0; t < n; t++) {
      const b = t * 9;
      const tr = this.tris;
      const lo = [0, 1, 2].map((k) =>
        Math.min(tr[b + k], tr[b + 3 + k], tr[b + 6 + k]),
      );
      const hi = [0, 1, 2].map((k) =>
        Math.max(tr[b + k], tr[b + 3 + k], tr[b + 6 + k]),
      );
      const i0 = Math.floor((lo[0] - pad - this.ox) / cell);
      const i1 = Math.floor((hi[0] + pad - this.ox) / cell);
      const j0 = Math.floor((lo[1] - pad - this.oy) / cell);
      const j1 = Math.floor((hi[1] + pad - this.oy) / cell);
      const k0 = Math.floor((lo[2] - pad - this.oz) / cell);
      const k1 = Math.floor((hi[2] + pad - this.oz) / cell);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          for (let k = k0; k <= k1; k++) {
            const key = this.key(i, j, k);
            const c = this.cells.get(key);
            if (c) c.push(t);
            else this.cells.set(key, [t]);
          }
        }
      }
    }
  }

  get triangleCount(): number {
    return this.materials.length;
  }

  private key(i: number, j: number, k: number): number {
    return i + this.nx * (j + this.ny * k);
  }

  /** Ray (unit direction) against one triangle, both sides; t or -1. */
  private hitTriangle(
    t: number,
    o: readonly number[],
    d: readonly number[],
  ): { t: number; front: boolean } | null {
    const tr = this.tris;
    const b = t * 9;
    const e1x = tr[b + 3] - tr[b];
    const e1y = tr[b + 4] - tr[b + 1];
    const e1z = tr[b + 5] - tr[b + 2];
    const e2x = tr[b + 6] - tr[b];
    const e2y = tr[b + 7] - tr[b + 1];
    const e2z = tr[b + 8] - tr[b + 2];
    const px = d[1] * e2z - d[2] * e2y;
    const py = d[2] * e2x - d[0] * e2z;
    const pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) return null;
    const inv = 1 / det;
    const sx = o[0] - tr[b];
    const sy = o[1] - tr[b + 1];
    const sz = o[2] - tr[b + 2];
    const u = (sx * px + sy * py + sz * pz) * inv;
    const eps = 1e-9;
    if (u < -eps || u > 1 + eps) return null;
    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < -eps || u + v > 1 + eps) return null;
    const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (dist <= 1e-7) return null;
    // Counter-clockwise from the front: the geometric normal e1 x e2 faces
    // the viewer, so a front hit has det > 0 for a ray going into it.
    return { t: dist, front: det > 0 };
  }

  /**
   * First triangle hit along the ray within maxT, or null. Triangles whose
   * material is in `through` (see-through materials) are passed through, as
   * the eye does through the gaps of a cut-out texture.
   */
  cast(
    o: readonly number[],
    d: readonly number[],
    maxT = 100,
    through?: ReadonlySet<string>,
  ): MeshHit | null {
    const cell = this.cell;
    const org = [this.ox, this.oy, this.oz];
    const n = [this.nx, this.ny, this.nz];
    const idx = [0, 1, 2].map((k) => Math.floor((o[k] - org[k]) / cell));
    const step = [0, 1, 2].map((k) => (d[k] > 0 ? 1 : d[k] < 0 ? -1 : 0));
    const tMax = [0, 1, 2].map((k) => {
      if (d[k] === 0) return Infinity;
      const edge = org[k] + (idx[k] + (d[k] > 0 ? 1 : 0)) * cell;
      return (edge - o[k]) / d[k];
    });
    const tDelta = [0, 1, 2].map((k) =>
      d[k] === 0 ? Infinity : cell / Math.abs(d[k]),
    );
    let tEnter = 0;
    for (;;) {
      for (let k = 0; k < 3; k++) {
        if (idx[k] < 0 || idx[k] >= n[k]) return null;
      }
      const tExit = Math.min(tMax[0], tMax[1], tMax[2]);
      const list = this.cells.get(this.key(idx[0], idx[1], idx[2]));
      if (list) {
        let best: { t: number; front: boolean; tri: number } | null = null;
        for (const t of list) {
          if (through?.has(this.materials[t])) continue;
          const h = this.hitTriangle(t, o, d);
          if (!h || h.t > tExit + 1e-6 || h.t < tEnter - 1e-6) continue;
          // On a tie the front face wins: two faces meeting at an edge.
          if (
            !best ||
            h.t < best.t - 1e-7 ||
            (h.t < best.t + 1e-7 && h.front && !best.front)
          ) {
            best = { ...h, tri: t };
          }
        }
        if (best) {
          return {
            t: best.t,
            front: best.front,
            material: this.materials[best.tri],
          };
        }
      }
      if (tExit > maxT) return null;
      tEnter = tExit;
      const k = tMax[0] === tExit ? 0 : tMax[1] === tExit ? 1 : 2;
      idx[k] += step[k];
      tMax[k] += tDelta[k];
    }
  }
}
