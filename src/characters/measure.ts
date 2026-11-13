/**
 * Geometry measurements used by the tests: signed volume of a closed shell,
 * and how far a point lies outside a set of closed shells.
 */
import type { MeshData } from "../core/mesh";
import type { Vec3 } from "../math";
import type { Piece } from "./geometry";

function vertex(mesh: MeshData, i: number): Vec3 {
  return {
    x: mesh.positions[i * 3],
    y: mesh.positions[i * 3 + 1],
    z: mesh.positions[i * 3 + 2],
  };
}

function triangle(mesh: MeshData, t: number): [Vec3, Vec3, Vec3] {
  return [
    vertex(mesh, mesh.indices[t * 3]),
    vertex(mesh, mesh.indices[t * 3 + 1]),
    vertex(mesh, mesh.indices[t * 3 + 2]),
  ];
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

/** Signed volume of a piece: positive when its triangles wind outwards. */
export function pieceVolume(mesh: MeshData, piece: Piece): number {
  let v = 0;
  for (
    let t = piece.firstTriangle;
    t < piece.firstTriangle + piece.triangleCount;
    t++
  ) {
    const [a, b, c] = triangle(mesh, t);
    v += dot(a, cross(b, c)) / 6;
  }
  return v;
}

/** Closest distance from p to triangle abc (Ericson, Real-Time Collision Detection). */
export function pointTriangleDistance(
  p: Vec3,
  a: Vec3,
  b: Vec3,
  c: Vec3,
): number {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  const len = (v: Vec3): number => Math.sqrt(dot(v, v));
  if (d1 <= 0 && d2 <= 0) return len(ap);
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return len(bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return len(sub(ap, { x: ab.x * v, y: ab.y * v, z: ab.z * v }));
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return len(cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return len(sub(ap, { x: ac.x * w, y: ac.y * w, z: ac.z * w }));
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const bc = sub(c, b);
    return len(sub(bp, { x: bc.x * w, y: bc.y * w, z: bc.z * w }));
  }
  // Inside the face region: distance to the plane.
  const n = cross(ab, ac);
  return Math.abs(dot(ap, n)) / len(n);
}

/** Ray (from p along a fixed odd direction) crossings of a piece. */
function crossings(mesh: MeshData, piece: Piece, p: Vec3): number {
  const dir = { x: 0.5773, y: 0.6123, z: 0.5404 };
  let count = 0;
  for (
    let t = piece.firstTriangle;
    t < piece.firstTriangle + piece.triangleCount;
    t++
  ) {
    const [a, b, c] = triangle(mesh, t);
    const e1 = sub(b, a);
    const e2 = sub(c, a);
    const h = cross(dir, e2);
    const det = dot(e1, h);
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const s = sub(p, a);
    const u = dot(s, h) * inv;
    if (u < 0 || u > 1) continue;
    const q = cross(s, e1);
    const v = dot(dir, q) * inv;
    if (v < 0 || u + v > 1) continue;
    if (dot(e2, q) * inv > 0) count++;
  }
  return count;
}

/**
 * How far p lies outside the union of the closed pieces of `mesh`
 * (0 when inside any of them).
 */
export function distanceOutside(
  mesh: MeshData,
  pieces: readonly Piece[],
  p: Vec3,
): number {
  let best = Infinity;
  for (const piece of pieces) {
    if (!piece.closed) continue;
    if (crossings(mesh, piece, p) % 2 === 1) return 0;
    for (
      let t = piece.firstTriangle;
      t < piece.firstTriangle + piece.triangleCount;
      t++
    ) {
      const [a, b, c] = triangle(mesh, t);
      best = Math.min(best, pointTriangleDistance(p, a, b, c));
    }
  }
  return best;
}
