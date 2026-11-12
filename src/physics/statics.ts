/**
 * Static world boxes with a uniform-grid broadphase, plus detection of
 * internal faces: a face fully covered by neighbouring static boxes can
 * never be touched from outside, so the narrowphase must not use it as a
 * contact normal. That removes snagging on seams between floor brushes.
 */
import { aabbBox, type Box } from "./body";

export interface StaticBox {
  id: number;
  minx: number;
  miny: number;
  minz: number;
  maxx: number;
  maxy: number;
  maxz: number;
  box: Box;
  /** Bit (axis*2) = +axis face internal, bit (axis*2+1) = -axis face internal. */
  blocked: number;
  /** Query stamp to avoid duplicates. */
  stamp: number;
}

const CELL = 4;
const MAX_CELLS_PER_BOX = 4096;
const COVER_EPS = 1e-4;
/** A neighbour must extend at least this far past a face to cover it. */
const COVER_DEPTH = 0.01;

function cellKey(ix: number, iy: number, iz: number): number {
  return ((ix + 4096) * 8192 + (iy + 4096)) * 8192 + (iz + 4096);
}

export class StaticStore {
  readonly list: StaticBox[] = [];
  private readonly cells = new Map<number, StaticBox[]>();
  private readonly large: StaticBox[] = [];
  private stamp = 0;

  add(
    minx: number,
    miny: number,
    minz: number,
    maxx: number,
    maxy: number,
    maxz: number,
  ): number {
    const s: StaticBox = {
      id: this.list.length,
      minx,
      miny,
      minz,
      maxx,
      maxy,
      maxz,
      box: aabbBox(minx, miny, minz, maxx, maxy, maxz),
      blocked: 0,
      stamp: 0,
    };
    this.list.push(s);
    const x0 = Math.floor(minx / CELL);
    const y0 = Math.floor(miny / CELL);
    const z0 = Math.floor(minz / CELL);
    const x1 = Math.floor(maxx / CELL);
    const y1 = Math.floor(maxy / CELL);
    const z1 = Math.floor(maxz / CELL);
    const count = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
    if (count > MAX_CELLS_PER_BOX) {
      this.large.push(s);
    } else {
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          for (let z = z0; z <= z1; z++) {
            const key = cellKey(x, y, z);
            let cell = this.cells.get(key);
            if (!cell) {
              cell = [];
              this.cells.set(key, cell);
            }
            cell.push(s);
          }
        }
      }
    }
    // The new box may cover faces of its neighbours and vice versa.
    const near = this.query(
      minx - COVER_EPS,
      miny - COVER_EPS,
      minz - COVER_EPS,
      maxx + COVER_EPS,
      maxy + COVER_EPS,
      maxz + COVER_EPS,
    );
    for (const n of near) {
      this.updateBlocked(n);
    }
    return s.id;
  }

  /** Statics whose bounds overlap the box, in id order. */
  query(
    minx: number,
    miny: number,
    minz: number,
    maxx: number,
    maxy: number,
    maxz: number,
  ): StaticBox[] {
    const out: StaticBox[] = [];
    const stamp = ++this.stamp;
    const test = (s: StaticBox): void => {
      if (s.stamp === stamp) {
        return;
      }
      s.stamp = stamp;
      if (
        s.minx <= maxx &&
        s.maxx >= minx &&
        s.miny <= maxy &&
        s.maxy >= miny &&
        s.minz <= maxz &&
        s.maxz >= minz
      ) {
        out.push(s);
      }
    };
    for (const s of this.large) {
      test(s);
    }
    const x0 = Math.floor(minx / CELL);
    const y0 = Math.floor(miny / CELL);
    const z0 = Math.floor(minz / CELL);
    const x1 = Math.floor(maxx / CELL);
    const y1 = Math.floor(maxy / CELL);
    const z1 = Math.floor(maxz / CELL);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > MAX_CELLS_PER_BOX) {
      for (const s of this.list) {
        test(s);
      }
    } else {
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          for (let z = z0; z <= z1; z++) {
            const cell = this.cells.get(cellKey(x, y, z));
            if (cell) {
              for (const s of cell) {
                test(s);
              }
            }
          }
        }
      }
    }
    if (out.length > 1) {
      out.sort((a, b) => a.id - b.id);
    }
    return out;
  }

  private updateBlocked(s: StaticBox): void {
    const lo = [s.minx, s.miny, s.minz];
    const hi = [s.maxx, s.maxy, s.maxz];
    const near = this.query(
      s.minx - COVER_EPS,
      s.miny - COVER_EPS,
      s.minz - COVER_EPS,
      s.maxx + COVER_EPS,
      s.maxy + COVER_EPS,
      s.maxz + COVER_EPS,
    );
    let mask = 0;
    for (let axis = 0; axis < 3; axis++) {
      const a1 = (axis + 1) % 3;
      const a2 = (axis + 2) % 3;
      for (let side = 0; side < 2; side++) {
        const plane = side === 0 ? hi[axis] : lo[axis];
        let remaining: number[][] = [[lo[a1], lo[a2], hi[a1], hi[a2]]];
        for (const n of near) {
          if (n === s) {
            continue;
          }
          const nlo = [n.minx, n.miny, n.minz];
          const nhi = [n.maxx, n.maxy, n.maxz];
          const covers =
            side === 0
              ? nlo[axis] <= plane + COVER_EPS &&
                nhi[axis] >= plane + COVER_DEPTH
              : nhi[axis] >= plane - COVER_EPS &&
                nlo[axis] <= plane - COVER_DEPTH;
          if (!covers) {
            continue;
          }
          remaining = subtractRects(remaining, [
            nlo[a1],
            nlo[a2],
            nhi[a1],
            nhi[a2],
          ]);
          if (remaining.length === 0) {
            break;
          }
        }
        if (remaining.length === 0) {
          mask |= 1 << (axis * 2 + side);
        }
      }
    }
    s.blocked = mask;
  }
}

/** Removes rect c (u0, v0, u1, v1) from each rect in the list. */
function subtractRects(rects: number[][], c: number[]): number[][] {
  const out: number[][] = [];
  for (const r of rects) {
    const [u0, v0, u1, v1] = r;
    if (
      c[0] >= u1 - COVER_EPS ||
      c[2] <= u0 + COVER_EPS ||
      c[1] >= v1 - COVER_EPS ||
      c[3] <= v0 + COVER_EPS
    ) {
      out.push(r);
      continue;
    }
    const cu0 = Math.max(u0, c[0]);
    const cu1 = Math.min(u1, c[2]);
    if (cu0 - u0 > COVER_EPS) {
      out.push([u0, v0, cu0, v1]);
    }
    if (u1 - cu1 > COVER_EPS) {
      out.push([cu1, v0, u1, v1]);
    }
    const cv0 = Math.max(v0, c[1]);
    const cv1 = Math.min(v1, c[3]);
    if (cv0 - v0 > COVER_EPS) {
      out.push([cu0, v0, cu1, cv0]);
    }
    if (v1 - cv1 > COVER_EPS) {
      out.push([cu0, cv1, cu1, v1]);
    }
  }
  return out;
}
