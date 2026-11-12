import { BoxIndex, regionCovered, type Box } from "./geometry";

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
export class AirGrid {
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
