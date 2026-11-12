import type { Box } from "./geometry";

/**
 * Voxel flood fill of the open air reachable from a seed point. Used to drop
 * faces that no one can ever see (the outside of every wall, closed-off gaps).
 * Doors are not brushes, so their doorways count as open air.
 */
export class AirGrid {
  private readonly res: number;
  private readonly ox: number;
  private readonly oy: number;
  private readonly oz: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly nz: number;
  /** 0 air, 1 solid, 2 reached. */
  private readonly cells: Uint8Array;

  constructor(
    boxes: readonly Box[],
    seed: { x: number; y: number; z: number },
    res = 0.1,
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

    // Rasterise: a cell is solid if its centre lies inside a brush.
    for (const b of boxes) {
      const ia = Math.max(0, Math.ceil((b.x0 - this.ox) / res - 0.5));
      const ib = Math.min(
        this.nx - 1,
        Math.floor((b.x1 - this.ox) / res - 0.5),
      );
      const ja = Math.max(0, Math.ceil((b.y0 - this.oy) / res - 0.5));
      const jb = Math.min(
        this.ny - 1,
        Math.floor((b.y1 - this.oy) / res - 0.5),
      );
      const ka = Math.max(0, Math.ceil((b.z0 - this.oz) / res - 0.5));
      const kb = Math.min(
        this.nz - 1,
        Math.floor((b.z1 - this.oz) / res - 0.5),
      );
      for (let k = ka; k <= kb; k++) {
        for (let j = ja; j <= jb; j++) {
          let idx = this.index(ia, j, k);
          for (let i = ia; i <= ib; i++) {
            this.cells[idx++] = 1;
          }
        }
      }
    }

    // Flood fill from the seed.
    const start = this.indexAt(seed.x, seed.y, seed.z);
    if (start < 0 || this.cells[start] !== 0) {
      throw new Error("AirGrid: seed point is not in open air");
    }
    const queue = new Int32Array(this.cells.length);
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    this.cells[start] = 2;
    const sx = 1;
    const sy = this.nx;
    const sz = this.nx * this.ny;
    const { nx, ny, nz, cells } = this;
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
}
