import { v3, type Vec3 } from "../math";
import type { MaterialId } from "./materials";

/**
 * Indexed triangle mesh with a single material.
 * - Front faces wind counter-clockwise.
 * - UVs are in tiles: 1.0 = one repeat of the texture; v grows downward.
 * - `colors`, when present, is baked lighting (linear RGB per vertex); the
 *   renderer uses it in place of lights that are marked `baked`.
 */
export interface MeshData {
  material: MaterialId;
  /** xyz per vertex. */
  positions: Float32Array;
  /** Unit xyz per vertex. */
  normals: Float32Array;
  /** uv per vertex. */
  uvs: Float32Array;
  /** Optional rgb per vertex. */
  colors?: Float32Array;
  indices: Uint32Array;
}

export interface Uv {
  u: number;
  v: number;
}

export type BoxFace = "px" | "nx" | "py" | "ny" | "pz" | "nz";

interface FaceBasis {
  face: BoxFace;
  normal: Vec3;
  /** Texture u direction; u cross v = normal. */
  u: Vec3;
  /** Texture "up" direction. */
  v: Vec3;
}

export const BOX_FACES: readonly FaceBasis[] = [
  {
    face: "px",
    normal: v3.create(1, 0, 0),
    u: v3.create(0, 0, -1),
    v: v3.create(0, 1, 0),
  },
  {
    face: "nx",
    normal: v3.create(-1, 0, 0),
    u: v3.create(0, 0, 1),
    v: v3.create(0, 1, 0),
  },
  {
    face: "py",
    normal: v3.create(0, 1, 0),
    u: v3.create(1, 0, 0),
    v: v3.create(0, 0, -1),
  },
  {
    face: "ny",
    normal: v3.create(0, -1, 0),
    u: v3.create(1, 0, 0),
    v: v3.create(0, 0, 1),
  },
  {
    face: "pz",
    normal: v3.create(0, 0, 1),
    u: v3.create(1, 0, 0),
    v: v3.create(0, 1, 0),
  },
  {
    face: "nz",
    normal: v3.create(0, 0, -1),
    u: v3.create(-1, 0, 0),
    v: v3.create(0, 1, 0),
  },
];

export interface BoxOptions {
  /** Size in metres of one texture repeat. Default 1. */
  tileSize?: number;
  /** Faces to leave out. */
  skip?: readonly BoxFace[];
  /** Vertex colour for every vertex of the box. */
  color?: Vec3;
}

/** Accumulates geometry for one material and produces a MeshData. */
export class MeshBuilder {
  readonly material: MaterialId;
  private positions: number[] = [];
  private normals: number[] = [];
  private uvs: number[] = [];
  private colors: number[] = [];
  private indices: number[] = [];
  private hasColor = false;
  private count = 0;

  constructor(material: MaterialId) {
    this.material = material;
  }

  get vertexCount(): number {
    return this.count;
  }

  /** Adds one vertex and returns its index. */
  addVertex(position: Vec3, normal: Vec3, uv: Uv, color?: Vec3): number {
    this.positions.push(position.x, position.y, position.z);
    this.normals.push(normal.x, normal.y, normal.z);
    this.uvs.push(uv.u, uv.v);
    if (color) {
      this.hasColor = true;
      this.colors.push(color.x, color.y, color.z);
    } else {
      this.colors.push(1, 1, 1);
    }
    return this.count++;
  }

  /** Adds a triangle from three vertex indices, counter-clockwise from the front. */
  addTriangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  /**
   * Adds a flat quad. Corners go counter-clockwise seen from the front:
   * bottom-left, bottom-right, top-right, top-left.
   */
  addQuad(
    corners: readonly [Vec3, Vec3, Vec3, Vec3],
    normal: Vec3,
    uvs: readonly [Uv, Uv, Uv, Uv],
    colors?: readonly [Vec3, Vec3, Vec3, Vec3],
  ): void {
    const a = this.addVertex(corners[0], normal, uvs[0], colors?.[0]);
    const b = this.addVertex(corners[1], normal, uvs[1], colors?.[1]);
    const c = this.addVertex(corners[2], normal, uvs[2], colors?.[2]);
    const d = this.addVertex(corners[3], normal, uvs[3], colors?.[3]);
    this.addTriangle(a, b, c);
    this.addTriangle(a, c, d);
  }

  /** Adds an axis-aligned box with outward faces and world-scaled UVs. */
  addBox(min: Vec3, max: Vec3, options: BoxOptions = {}): void {
    const tile = options.tileSize ?? 1;
    const center = v3.scale(v3.add(min, max), 0.5);
    const half = v3.scale(v3.sub(max, min), 0.5);
    for (const basis of BOX_FACES) {
      if (options.skip?.includes(basis.face)) {
        continue;
      }
      const hn = Math.abs(v3.dot(basis.normal, half));
      const hu = Math.abs(v3.dot(basis.u, half));
      const hv = Math.abs(v3.dot(basis.v, half));
      const faceCenter = v3.addScaled(center, basis.normal, hn);
      const corner = (su: number, sv: number): Vec3 =>
        v3.addScaled(
          v3.addScaled(faceCenter, basis.u, su * hu),
          basis.v,
          sv * hv,
        );
      const width = (2 * hu) / tile;
      const height = (2 * hv) / tile;
      const color = options.color;
      this.addQuad(
        [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)],
        basis.normal,
        [
          { u: 0, v: height },
          { u: width, v: height },
          { u: width, v: 0 },
          { u: 0, v: 0 },
        ],
        color ? [color, color, color, color] : undefined,
      );
    }
  }

  /**
   * Adds a closed cylinder standing on the Y axis, with smooth side normals.
   * `base` is the centre of the bottom cap. Caps map the texture once across
   * the diameter; the side wraps it `sideRepeats` times around.
   */
  addCylinder(
    base: Vec3,
    radius: number,
    height: number,
    segments: number,
    options: { sideRepeats?: number; caps?: boolean; color?: Vec3 } = {},
  ): void {
    const repeats = options.sideRepeats ?? 1;
    const color = options.color;
    const yTop = base.y + height;
    const sideStart = this.count;
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      const normal = v3.create(Math.cos(angle), 0, Math.sin(angle));
      const x = base.x + normal.x * radius;
      const z = base.z + normal.z * radius;
      // u decreases with angle so the texture is not mirrored on the outside.
      const u = (1 - i / segments) * repeats;
      this.addVertex(v3.create(x, base.y, z), normal, { u, v: 1 }, color);
      this.addVertex(v3.create(x, yTop, z), normal, { u, v: 0 }, color);
    }
    for (let i = 0; i < segments; i++) {
      const bottom0 = sideStart + i * 2;
      const top0 = bottom0 + 1;
      const bottom1 = bottom0 + 2;
      const top1 = bottom0 + 3;
      this.addTriangle(bottom1, bottom0, top0);
      this.addTriangle(bottom1, top0, top1);
    }
    if (options.caps === false) {
      return;
    }
    for (const top of [true, false]) {
      const y = top ? yTop : base.y;
      const normal = v3.create(0, top ? 1 : -1, 0);
      const centerIndex = this.addVertex(
        v3.create(base.x, y, base.z),
        normal,
        { u: 0.5, v: 0.5 },
        color,
      );
      const rimStart = this.count;
      for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        this.addVertex(
          v3.create(base.x + cos * radius, y, base.z - sin * radius),
          normal,
          { u: 0.5 + cos * 0.5, v: 0.5 + sin * 0.5 },
          color,
        );
      }
      for (let i = 0; i < segments; i++) {
        if (top) {
          this.addTriangle(centerIndex, rimStart + i, rimStart + i + 1);
        } else {
          this.addTriangle(centerIndex, rimStart + i + 1, rimStart + i);
        }
      }
    }
  }

  build(): MeshData {
    const mesh: MeshData = {
      material: this.material,
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      uvs: new Float32Array(this.uvs),
      indices: new Uint32Array(this.indices),
    };
    if (this.hasColor) {
      mesh.colors = new Float32Array(this.colors);
    }
    return mesh;
  }
}
