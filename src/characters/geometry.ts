/**
 * Low-poly building blocks for body parts: lofts (rings of points joined
 * into a tube, with domed or flat ends), boxes, and mirroring. Texture
 * coordinates are given in atlas pixels and converted to 0..1 on build.
 */
import type { MaterialId } from "../core/materials";
import type { MeshData, MeshImage } from "../core/mesh";
import type { Vec3 } from "../math";

/** Rectangle in atlas pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One cross-section of a loft, at height `y` in the part's space. */
export interface Ring {
  y: number;
  /** Half width (x) and half depth (z) of the ellipse. */
  rx: number;
  rz: number;
  /** Centre offset. */
  cx?: number;
  cz?: number;
  /** Atlas row (pixels) of this ring. */
  v: number;
}

export type Cap =
  /** Closes the end with a point at height `y` (a dome); `v` is its atlas row. */
  | { kind: "pole"; y: number; v: number; cx?: number; cz?: number }
  /** Closes the end with a flat fan mapped onto an atlas swatch. */
  | { kind: "flat"; swatch: Rect }
  | { kind: "none" };

export interface LoftOptions {
  sides: number;
  /** Bottom to top (increasing y). */
  rings: Ring[];
  /** Atlas columns the loft wraps around: x .. x + w. */
  band: { x: number; w: number };
  /** Atlas column of each of the sides + 1 seams, as fractions of the band. */
  uCols?: readonly number[];
  /** Angle range in turns (0 = back, 0.25 = right, 0.5 = front). Default 0..1. */
  turns?: [number, number];
  top?: Cap;
  bottom?: Cap;
  /** Also add inward faces, mapped onto this swatch (for open shells). */
  lining?: Rect;
  /** Maps each built point and normal, e.g. to lay a loft along -Z. */
  transform?: (p: Vec3) => Vec3;
}

/** A closed shell inside a part, as a triangle range (for inside tests). */
export interface Piece {
  firstTriangle: number;
  triangleCount: number;
  closed: boolean;
}

/** Accumulates one part's geometry. */
export class PartBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly uvs: number[] = [];
  readonly indices: number[] = [];
  /** Smoothing group of each vertex: normals average within a group. */
  private readonly groups: number[] = [];
  readonly pieces: Piece[] = [];
  private nextGroup = 0;
  private pieceStart = 0;

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  get triangleCount(): number {
    return this.indices.length / 3;
  }

  newGroup(): number {
    return this.nextGroup++;
  }

  vertex(p: Vec3, u: number, v: number, group: number): number {
    this.positions.push(p.x, p.y, p.z);
    this.normals.push(0, 0, 0);
    this.uvs.push(u, v);
    this.groups.push(group);
    return this.vertexCount - 1;
  }

  triangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  /** Marks the triangles added since the last call as one shell. */
  endPiece(closed: boolean): void {
    const first = this.pieceStart;
    const count = this.triangleCount - first;
    if (count > 0) {
      this.pieces.push({ firstTriangle: first, triangleCount: count, closed });
    }
    this.pieceStart = this.triangleCount;
  }

  /** Adds a loft and ends it as a piece (closed if both ends are capped). */
  loft(o: LoftOptions): void {
    const sides = o.sides;
    const [t0, t1] = o.turns ?? [0, 1];
    const full = t1 - t0 >= 1 - 1e-9;
    const tf = o.transform ?? ((p: Vec3) => p);
    const group = this.newGroup();
    const uOf = (j: number): number =>
      o.band.x + (o.uCols ? o.uCols[j] : j / sides) * o.band.w;
    const point = (ring: Ring, j: number): Vec3 => {
      const phi = (t0 + ((t1 - t0) * j) / sides) * Math.PI * 2;
      return {
        x: (ring.cx ?? 0) + ring.rx * Math.sin(phi),
        y: ring.y,
        z: (ring.cz ?? 0) + ring.rz * Math.cos(phi),
      };
    };
    const grid: number[][] = [];
    for (const ring of o.rings) {
      const row: number[] = [];
      for (let j = 0; j <= sides; j++) {
        row.push(this.vertex(tf(point(ring, j)), uOf(j), ring.v, group));
      }
      grid.push(row);
    }
    for (let i = 0; i + 1 < grid.length; i++) {
      for (let j = 0; j < sides; j++) {
        const bl = grid[i][j];
        const br = grid[i][j + 1];
        const tr = grid[i + 1][j + 1];
        const tl = grid[i + 1][j];
        this.triangle(bl, br, tr);
        this.triangle(bl, tr, tl);
      }
    }
    const cap = (cap: Cap | undefined, top: boolean): void => {
      if (!cap || cap.kind === "none") {
        return;
      }
      const ring = top ? o.rings[o.rings.length - 1] : o.rings[0];
      const row = top ? grid[grid.length - 1] : grid[0];
      if (cap.kind === "pole") {
        const apex = tf({ x: cap.cx ?? 0, y: cap.y, z: cap.cz ?? 0 });
        for (let j = 0; j < sides; j++) {
          const a = this.vertex(apex, (uOf(j) + uOf(j + 1)) / 2, cap.v, group);
          if (top) {
            this.triangle(row[j], row[j + 1], a);
          } else {
            this.triangle(row[j + 1], row[j], a);
          }
        }
        return;
      }
      const flat = this.newGroup();
      const sw = cap.swatch;
      const centreUv = { u: sw.x + sw.w / 2, v: sw.y + sw.h / 2 };
      const c = this.vertex(
        tf({ x: ring.cx ?? 0, y: ring.y, z: ring.cz ?? 0 }),
        centreUv.u,
        centreUv.v,
        flat,
      );
      const rim: number[] = [];
      for (let j = 0; j <= sides; j++) {
        const phi = (j / sides) * Math.PI * 2;
        rim.push(
          this.vertex(
            tf(point(ring, j)),
            centreUv.u + (Math.sin(phi) * sw.w) / 2.2,
            centreUv.v + (Math.cos(phi) * sw.h) / 2.2,
            flat,
          ),
        );
      }
      for (let j = 0; j < sides; j++) {
        if (top) {
          this.triangle(c, rim[j], rim[j + 1]);
        } else {
          this.triangle(c, rim[j + 1], rim[j]);
        }
      }
    };
    cap(o.top, true);
    cap(o.bottom, false);
    if (o.lining) {
      const lin = o.lining;
      const inner = this.newGroup();
      const back: number[][] = grid.map((row, i) =>
        row.map((index, j) => {
          const p = {
            x: this.positions[index * 3],
            y: this.positions[index * 3 + 1],
            z: this.positions[index * 3 + 2],
          };
          return this.vertex(
            p,
            lin.x + (j / sides) * lin.w,
            lin.y + (i / Math.max(1, grid.length - 1)) * lin.h,
            inner,
          );
        }),
      );
      for (let i = 0; i + 1 < back.length; i++) {
        for (let j = 0; j < sides; j++) {
          this.triangle(back[i][j], back[i + 1][j + 1], back[i][j + 1]);
          this.triangle(back[i][j], back[i + 1][j], back[i + 1][j + 1]);
        }
      }
    }
    const closed =
      full &&
      !o.lining &&
      o.top !== undefined &&
      o.top.kind !== "none" &&
      o.bottom !== undefined &&
      o.bottom.kind !== "none";
    this.endPiece(closed);
  }

  /**
   * Adds an axis-aligned box from `min` to `max`, every face mapped onto the
   * same atlas swatch, and ends it as a closed piece.
   */
  box(min: Vec3, max: Vec3, swatch: Rect, transform?: (p: Vec3) => Vec3): void {
    const tf = transform ?? ((p: Vec3) => p);
    const faces: [Vec3, Vec3, Vec3, Vec3][] = [];
    const P = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
    const { x: x0, y: y0, z: z0 } = min;
    const { x: x1, y: y1, z: z1 } = max;
    // Corners counter-clockwise seen from outside: bl, br, tr, tl.
    faces.push([P(x0, y0, z0), P(x1, y0, z0), P(x1, y1, z0), P(x0, y1, z0)]); // front? (-Z): seen from -Z
    faces.push([P(x1, y0, z1), P(x0, y0, z1), P(x0, y1, z1), P(x1, y1, z1)]); // +Z
    faces.push([P(x1, y0, z0), P(x1, y0, z1), P(x1, y1, z1), P(x1, y1, z0)]); // +X
    faces.push([P(x0, y0, z1), P(x0, y0, z0), P(x0, y1, z0), P(x0, y1, z1)]); // -X
    faces.push([P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1)]); // +Y
    faces.push([P(x0, y0, z1), P(x1, y0, z1), P(x1, y0, z0), P(x0, y0, z0)]); // -Y
    for (const f of faces) {
      const g = this.newGroup();
      const uv = [
        [swatch.x, swatch.y + swatch.h],
        [swatch.x + swatch.w, swatch.y + swatch.h],
        [swatch.x + swatch.w, swatch.y],
        [swatch.x, swatch.y],
      ];
      const ids = f.map((p, k) => this.vertex(tf(p), uv[k][0], uv[k][1], g));
      // The front face list above is wound for a viewer at -Z looking +Z.
      this.triangle(ids[0], ids[2], ids[1]);
      this.triangle(ids[0], ids[3], ids[2]);
    }
    this.endPiece(true);
  }

  /** Reflects everything added so far across x = 0 (keeping outward winding). */
  mirrorX(): void {
    for (let i = 0; i < this.positions.length; i += 3) {
      this.positions[i] = -this.positions[i];
    }
    for (let i = 0; i < this.indices.length; i += 3) {
      const t = this.indices[i + 1];
      this.indices[i + 1] = this.indices[i + 2];
      this.indices[i + 2] = t;
    }
  }

  /**
   * Builds the mesh: smooth normals within each smoothing group (vertices
   * at the same place in the same group share a normal), UVs scaled to 0..1.
   */
  build(material: MaterialId, atlas: MeshImage): MeshData {
    const n = this.vertexCount;
    const normals = new Float32Array(n * 3);
    const p = this.positions;
    for (let t = 0; t < this.indices.length; t += 3) {
      const a = this.indices[t] * 3;
      const b = this.indices[t + 1] * 3;
      const c = this.indices[t + 2] * 3;
      const e1x = p[b] - p[a];
      const e1y = p[b + 1] - p[a + 1];
      const e1z = p[b + 2] - p[a + 2];
      const e2x = p[c] - p[a];
      const e2y = p[c + 1] - p[a + 1];
      const e2z = p[c + 2] - p[a + 2];
      // Area-weighted face normal.
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      for (const v of [a, b, c]) {
        normals[v] += nx;
        normals[v + 1] += ny;
        normals[v + 2] += nz;
      }
    }
    // Merge vertices that share a position and smoothing group.
    const key = (i: number): string =>
      `${this.groups[i]}:${Math.round(p[i * 3] * 1e4)},${Math.round(p[i * 3 + 1] * 1e4)},${Math.round(p[i * 3 + 2] * 1e4)}`;
    const sums = new Map<string, [number, number, number]>();
    for (let i = 0; i < n; i++) {
      const k = key(i);
      const s = sums.get(k) ?? [0, 0, 0];
      s[0] += normals[i * 3];
      s[1] += normals[i * 3 + 1];
      s[2] += normals[i * 3 + 2];
      sums.set(k, s);
    }
    for (let i = 0; i < n; i++) {
      const s = sums.get(key(i)) ?? [0, 1, 0];
      let len = Math.hypot(s[0], s[1], s[2]);
      if (len < 1e-12) {
        s[0] = 0;
        s[1] = 1;
        s[2] = 0;
        len = 1;
      }
      normals[i * 3] = s[0] / len;
      normals[i * 3 + 1] = s[1] / len;
      normals[i * 3 + 2] = s[2] / len;
    }
    const size = atlas.size;
    const uvs = new Float32Array(this.uvs.length);
    for (let i = 0; i < this.uvs.length; i++) {
      uvs[i] = this.uvs[i] / size;
    }
    return {
      material,
      positions: new Float32Array(this.positions),
      normals,
      uvs,
      indices: new Uint32Array(this.indices),
      image: atlas,
    };
  }
}

/** Lays a loft built along +Y out along -Z (for feet): (x, y, z) -> (x, z, -y). */
export const alongMinusZ = (p: Vec3): Vec3 => ({ x: p.x, y: p.z, z: -p.y });
