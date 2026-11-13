import { BoxGrid, BoxIndex, regionCovered, type Box } from "./geometry";

/** Voxels per column side (columns are COL x COL voxels in x and z, full height). */
const COL_BITS = 3;
const COL = 1 << COL_BITS;
const COL_MASK = COL - 1;
const STACKS = COL * COL;

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
 *
 * Built to scale with a large facility:
 * - Storage is sparse: the grid (the brushes' bounds plus a 0.5 m margin)
 *   is cut into columns of 8 x 8 voxels in plan, full height, and only
 *   columns whose plan area some brush overlaps are stored. Any other column
 *   is air from the bottom of the grid to the top, so air that reaches one
 *   has reached the grid's border: the level leaks.
 * - The fill moves through vertical runs of air (a stack of voxels one
 *   above the other), not voxel by voxel; voxels of a stack are contiguous.
 * - A voxel a brush only partly covers is solid only if the brushes overlap
 *   it by its whole volume in sum and then cover it exactly.
 * Results (reachable voxels, their count, leaks) are those of the plain
 * dense voxel flood.
 */
export class AirGrid {
  private readonly res: number;
  private readonly ox: number;
  private readonly oy: number;
  private readonly oz: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly nz: number;
  /** Columns along x and z, and each column's block index or -1. */
  private readonly ncx: number;
  private readonly ncz: number;
  private readonly columns: Int32Array;
  /** Voxels per stored block (STACKS * ny). */
  private readonly block: number;
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
    const { nx, ny, nz } = this;
    this.ncx = (nx + COL - 1) >> COL_BITS;
    this.ncz = (nz + COL - 1) >> COL_BITS;
    const block = STACKS * ny;
    this.block = block;

    const eps = 1e-7;
    const span = (lo: number, hi: number, o: number, n: number) => ({
      full0: Math.max(0, Math.ceil((lo - o) / res - eps)),
      full1: Math.min(n - 1, Math.floor((hi - o) / res + eps) - 1),
      part0: Math.max(0, Math.floor((lo - o) / res + eps)),
      part1: Math.min(n - 1, Math.ceil((hi - o) / res - eps) - 1),
    });

    // Columns any brush overlaps (its partly covered voxels included).
    const columns = new Int32Array(this.ncx * this.ncz).fill(-1);
    const spans = boxes.map((b) => ({
      sx: span(b.x0, b.x1, this.ox, nx),
      sy: span(b.y0, b.y1, this.oy, ny),
      sz: span(b.z0, b.z1, this.oz, nz),
    }));
    let stored = 0;
    for (const { sx, sz } of spans) {
      for (let ck = sz.part0 >> COL_BITS; ck <= sz.part1 >> COL_BITS; ck++) {
        for (let ci = sx.part0 >> COL_BITS; ci <= sx.part1 >> COL_BITS; ci++) {
          const c = ci + this.ncx * ck;
          if (columns[c] < 0) columns[c] = stored++;
        }
      }
    }
    this.columns = columns;
    const blockColumn = new Int32Array(stored);
    columns.forEach((c, col) => {
      if (c >= 0) blockColumn[c] = col;
    });
    this.blockColumns = blockColumn;
    const cells = new Uint8Array(stored * block);
    this.cells = cells;
    // Stacks of a stored block past the grid's far edges do not exist.
    for (let ck = 0; ck < this.ncz; ck++) {
      for (let ci = 0; ci < this.ncx; ci++) {
        const c = columns[ci + this.ncx * ck];
        if (c < 0) continue;
        for (let s = 0; s < STACKS; s++) {
          const i = (ci << COL_BITS) + (s & COL_MASK);
          const k = (ck << COL_BITS) + (s >> COL_BITS);
          if (i >= nx || k >= nz) {
            const at = c * block + s * ny;
            cells.fill(1, at, at + ny);
          }
        }
      }
    }

    // Voxels wholly inside one brush are solid; voxels a brush only partly
    // covers are settled below against the union of all brushes.
    const pending: number[] = [];
    const partly = (idx: number): void => {
      if (cells[idx] === 0) {
        cells[idx] = 3;
        pending.push(idx);
      }
    };
    for (const { sx, sy, sz } of spans) {
      for (let k = sz.part0; k <= sz.part1; k++) {
        const kFull = k >= sz.full0 && k <= sz.full1;
        for (let i = sx.part0; i <= sx.part1; i++) {
          const base = this.address(i, 0, k);
          if (kFull && i >= sx.full0 && i <= sx.full1) {
            for (let j = sy.part0; j < sy.full0; j++) partly(base + j);
            if (sy.full0 <= sy.full1) {
              cells.fill(1, base + sy.full0, base + sy.full1 + 1);
            }
            for (let j = Math.max(sy.full1 + 1, sy.part0); j <= sy.part1; j++) {
              partly(base + j);
            }
          } else {
            for (let j = sy.part0; j <= sy.part1; j++) partly(base + j);
          }
        }
      }
    }
    // A voxel the brushes overlap by less than its volume in all is not
    // covered (the union is at most the sum); only the rest need the exact
    // test.
    const index = new BoxIndex(boxes);
    const near = new BoxGrid(boxes);
    const full = res * res * res * (1 - 1e-9);
    const lo = [0, 0, 0];
    const hi = [0, 0, 0];
    for (const idx of pending) {
      if (cells[idx] !== 3) continue;
      const [i, j, k] = this.coords(idx);
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
      lo[0] = vx;
      lo[1] = vy;
      lo[2] = vz;
      hi[0] = voxel.x1;
      hi[1] = voxel.y1;
      hi[2] = voxel.z1;
      let volume = 0;
      near.forEachNear(lo, hi, (n) => {
        const b = boxes[n];
        const dx = Math.min(b.x1, voxel.x1) - Math.max(b.x0, vx);
        const dy = Math.min(b.y1, voxel.y1) - Math.max(b.y0, vy);
        const dz = Math.min(b.z1, voxel.z1) - Math.max(b.z0, vz);
        if (dx > 0 && dy > 0 && dz > 0) volume += dx * dy * dz;
      });
      cells[idx] = volume >= full && regionCovered(index, boxes, voxel) ? 1 : 0;
    }
    // Door volumes are air whatever overlaps them.
    for (const b of air) {
      const sx = span(b.x0, b.x1, this.ox, nx);
      const sy = span(b.y0, b.y1, this.oy, ny);
      const sz = span(b.z0, b.z1, this.oz, nz);
      for (let k = sz.part0; k <= sz.part1; k++) {
        for (let i = sx.part0; i <= sx.part1; i++) {
          const base = this.address(i, 0, k);
          if (base >= 0) cells.fill(0, base + sy.part0, base + sy.part1 + 1);
        }
      }
    }

    // Runs of air in every stack: [start, end) in `cells`, stack by stack.
    const runs = new RunList();
    const firstRun = new Int32Array(stored * STACKS + 1);
    for (let s = 0; s < stored * STACKS; s++) {
      firstRun[s] = runs.length;
      const base = s * ny;
      let j = 0;
      while (j < ny) {
        if (cells[base + j] !== 0) {
          j++;
          continue;
        }
        const start = j;
        while (j < ny && cells[base + j] === 0) j++;
        runs.push(base + start, base + j);
      }
    }
    firstRun[stored * STACKS] = runs.length;
    /** Plan voxel (i, k) of stack s. */
    const stackIK = (s: number): [number, number] => {
      const c = (s / STACKS) | 0;
      const col = blockColumn[c];
      const local = s - c * STACKS;
      return [
        ((col % this.ncx) << COL_BITS) + (local & COL_MASK),
        (Math.floor(col / this.ncx) << COL_BITS) + (local >> COL_BITS),
      ];
    };
    /** Stack of plan voxel (i, k): -1 off the grid, -2 in an unstored column. */
    const stackAt = (i: number, k: number): number => {
      if (i < 0 || k < 0 || i >= nx || k >= nz) return -1;
      const c = columns[(i >> COL_BITS) + this.ncx * (k >> COL_BITS)];
      if (c < 0) return -2;
      return c * STACKS + (k & COL_MASK) * COL + (i & COL_MASK);
    };

    // Flood fill through the runs. Reaching the grid's border, or a column
    // that is not stored, means the level leaks; then the fill goes on from
    // everything outside, as a dense flood would.
    const reached = new Uint8Array(runs.length);
    let queue = new Int32Array(1024);
    let head = 0;
    let tail = 0;
    const push = (r: number): void => {
      if (reached[r]) return;
      reached[r] = 1;
      if (tail === queue.length) {
        const bigger = new Int32Array(queue.length * 2);
        bigger.set(queue);
        queue = bigger;
      }
      queue[tail++] = r;
    };
    const runStack = (r: number): number => (runs.start[r] / ny) | 0;
    /** True if run r touches the grid's border or an unstored column. */
    const onEdge = (r: number): boolean => {
      const s = runStack(r);
      const base = s * ny;
      if (runs.start[r] === base || runs.end[r] === base + ny) return true;
      const [i, k] = stackIK(s);
      return (
        i === 0 ||
        k === 0 ||
        i === nx - 1 ||
        k === nz - 1 ||
        stackAt(i - 1, k) === -2 ||
        stackAt(i + 1, k) === -2 ||
        stackAt(i, k - 1) === -2 ||
        stackAt(i, k + 1) === -2
      );
    };
    let leaks = false;
    const outside = (): void => {
      if (leaks) return;
      leaks = true;
      for (let r = 0; r < runs.length; r++) if (onEdge(r)) push(r);
    };
    const seedI = Math.floor((seed.x - this.ox) / res);
    const seedJ = Math.floor((seed.y - this.oy) / res);
    const seedK = Math.floor((seed.z - this.oz) / res);
    const seedStack = seedJ < 0 || seedJ >= ny ? -1 : stackAt(seedI, seedK);
    if (seedStack === -1) {
      throw new Error("AirGrid: seed point is not in open air");
    }
    if (seedStack === -2) {
      outside();
    } else {
      const at = seedStack * ny + seedJ;
      if (cells[at] !== 0) {
        throw new Error("AirGrid: seed point is not in open air");
      }
      for (let r = firstRun[seedStack]; r < firstRun[seedStack + 1]; r++) {
        if (runs.start[r] <= at && at < runs.end[r]) push(r);
      }
    }
    const DI = [-1, 1, 0, 0];
    const DK = [0, 0, -1, 1];
    while (head < tail) {
      const r = queue[head++];
      if (!leaks && onEdge(r)) outside();
      const s = runStack(r);
      const j0 = runs.start[r] - s * ny;
      const j1 = runs.end[r] - s * ny;
      const [i, k] = stackIK(s);
      for (let d = 0; d < 4; d++) {
        const t = stackAt(i + DI[d], k + DK[d]);
        if (t < 0) continue;
        const base = t * ny;
        for (let q = firstRun[t]; q < firstRun[t + 1]; q++) {
          if (runs.end[q] - base > j0 && runs.start[q] - base < j1) push(q);
        }
      }
    }
    this.leaks = leaks;
    let count = 0;
    for (let q = 0; q < tail; q++) {
      const r = queue[q];
      cells.fill(2, runs.start[r], runs.end[r]);
      count += runs.end[r] - runs.start[r];
    }
    // Unstored columns are all reached air once the level leaks.
    if (leaks) {
      for (let ck = 0; ck < this.ncz; ck++) {
        for (let ci = 0; ci < this.ncx; ci++) {
          if (columns[ci + this.ncx * ck] >= 0) continue;
          const w = Math.min(COL, nx - (ci << COL_BITS));
          const d = Math.min(COL, nz - (ck << COL_BITS));
          count += w * d * ny;
        }
      }
    }
    this.reachedCount = count;
  }

  /** Number of air cells reached by the flood fill. */
  readonly reachedCount: number;
  /** True if the flood fill reached the outer border of the grid. */
  readonly leaks: boolean;
  /** The column (ci + ncx * ck) of each stored block. */
  private readonly blockColumns: Int32Array;

  /**
   * Index of voxel (i, j, k) in `cells`; -1 outside the grid, -2 in a
   * column that is not stored (air).
   */
  private address(i: number, j: number, k: number): number {
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
    const c = this.columns[(i >> COL_BITS) + this.ncx * (k >> COL_BITS)];
    if (c < 0) return -2;
    return (
      c * this.block + ((k & COL_MASK) * COL + (i & COL_MASK)) * this.ny + j
    );
  }

  /** Voxel (i, j, k) of an index into `cells`. */
  private coords(idx: number): [number, number, number] {
    const c = Math.floor(idx / this.block);
    const local = idx - c * this.block;
    const s = Math.floor(local / this.ny);
    const j = local - s * this.ny;
    const col = this.blockColumns[c];
    return [
      ((col % this.ncx) << COL_BITS) + (s & COL_MASK),
      j,
      (Math.floor(col / this.ncx) << COL_BITS) + (s >> COL_BITS),
    ];
  }

  private addressAt(x: number, y: number, z: number): number {
    return this.address(
      Math.floor((x - this.ox) / this.res),
      Math.floor((y - this.oy) / this.res),
      Math.floor((z - this.oz) / this.res),
    );
  }

  /** True if the point is in air connected to the seed. */
  reachable(x: number, y: number, z: number): boolean {
    const idx = this.addressAt(x, y, z);
    if (idx === -2) return this.leaks;
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
    if (j0 > j1) return false;
    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) {
        const base = this.address(i, 0, k);
        if (base === -2) {
          if (this.leaks) return true;
          continue;
        }
        for (let j = j0; j <= j1; j++) {
          if (this.cells[base + j] === 2) return true;
        }
      }
    }
    return false;
  }
}

/** Growable pair of Int32 arrays: the runs' [start, end) in `cells`. */
class RunList {
  start = new Int32Array(1 << 14);
  end = new Int32Array(1 << 14);
  length = 0;

  push(a: number, b: number): void {
    if (this.length === this.start.length) {
      const s = new Int32Array(this.length * 2);
      const e = new Int32Array(this.length * 2);
      s.set(this.start);
      e.set(this.end);
      this.start = s;
      this.end = e;
    }
    this.start[this.length] = a;
    this.end[this.length++] = b;
  }
}
