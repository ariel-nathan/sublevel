/**
 * Oriented box vs oriented box narrowphase: separating axis test over the
 * 15 candidate axes, then a contact manifold of up to four points from
 * reference/incident face clipping, or a single point for edge-edge contact.
 *
 * Contacts are accepted up to `margin` of separation (speculative contacts).
 * Every point carries a feature id that stays the same while the same
 * features touch, so the solver can warm start across frames.
 */
import type { Box } from "./body";

export interface RawPoint {
  x: number;
  y: number;
  z: number;
  /** Signed distance along the normal; negative when penetrating. */
  sep: number;
  id: number;
}

export interface RawManifold {
  /** Unit normal pointing from box A towards box B. */
  nx: number;
  ny: number;
  nz: number;
  points: RawPoint[];
}

/** Prefer face axes over edge axes unless an edge axis is clearly better. */
const FACE_B_TOLERANCE = 0.002;
const EDGE_TOLERANCE = 0.005;

// Scratch storage, reused between calls (the module is single-threaded).
const ua = [new Float64Array(3), new Float64Array(3), new Float64Array(3)];
const ub = [new Float64Array(3), new Float64Array(3), new Float64Array(3)];
const ea = new Float64Array(3);
const eb = new Float64Array(3);
const rot = new Float64Array(9);
const absRot = new Float64Array(9);

function loadAxes(box: Box, out: Float64Array[], ext: Float64Array): void {
  const r = box.r;
  for (let j = 0; j < 3; j++) {
    const a = out[j];
    a[0] = r[j];
    a[1] = r[3 + j];
    a[2] = r[6 + j];
  }
  ext[0] = box.hx;
  ext[1] = box.hy;
  ext[2] = box.hz;
}

/**
 * @param blockedB bit mask of B's faces that must not be used as the
 *   contact normal (internal faces of static geometry). Bit (axis*2) is the
 *   +axis face, bit (axis*2+1) the -axis face.
 */
export function collideBoxes(
  A: Box,
  B: Box,
  margin: number,
  blockedB = 0,
): RawManifold | null {
  loadAxes(A, ua, ea);
  loadAxes(B, ub, eb);
  const dx = B.px - A.px;
  const dy = B.py - A.py;
  const dz = B.pz - A.pz;

  for (let i = 0; i < 3; i++) {
    const a = ua[i];
    for (let j = 0; j < 3; j++) {
      const b = ub[j];
      const v = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      rot[i * 3 + j] = v;
      absRot[i * 3 + j] = Math.abs(v) + 1e-9;
    }
  }

  // A direction n (from A to B) is unusable when B's face facing A along
  // it is an internal face.
  const isBlocked = (nx: number, ny: number, nz: number): boolean => {
    if (blockedB === 0) {
      return false;
    }
    for (let k = 0; k < 3; k++) {
      const w = ub[k];
      const d = w[0] * nx + w[1] * ny + w[2] * nz;
      // B's face with outward normal -n: the +axis face when d < 0.
      if (d < -0.995 && blockedB & (1 << (k * 2))) {
        return true;
      }
      if (d > 0.995 && blockedB & (1 << (k * 2 + 1))) {
        return true;
      }
    }
    return false;
  };

  // Face axes of A.
  let faceASep = -Infinity;
  let faceAAxis = 0;
  let faceASign = 1;
  for (let i = 0; i < 3; i++) {
    const a = ua[i];
    const d = dx * a[0] + dy * a[1] + dz * a[2];
    const rb =
      eb[0] * absRot[i * 3] +
      eb[1] * absRot[i * 3 + 1] +
      eb[2] * absRot[i * 3 + 2];
    const sep = Math.abs(d) - ea[i] - rb;
    if (sep > margin) {
      return null;
    }
    const s = d >= 0 ? 1 : -1;
    if (isBlocked(a[0] * s, a[1] * s, a[2] * s)) {
      continue;
    }
    if (sep > faceASep) {
      faceASep = sep;
      faceAAxis = i;
      faceASign = d >= 0 ? 1 : -1;
    }
  }

  // Face axes of B.
  let faceBSep = -Infinity;
  let faceBAxis = -1;
  let faceBSign = 1;
  for (let j = 0; j < 3; j++) {
    const b = ub[j];
    const d = dx * b[0] + dy * b[1] + dz * b[2];
    const ra =
      ea[0] * absRot[j] + ea[1] * absRot[3 + j] + ea[2] * absRot[6 + j];
    const sep = Math.abs(d) - ra - eb[j];
    if (sep > margin) {
      return null;
    }
    // The face of B that faces A has outward normal -sign(d) * ub[j].
    const bit = j * 2 + (d < 0 ? 0 : 1);
    if (blockedB & (1 << bit)) {
      continue;
    }
    if (sep > faceBSep) {
      faceBSep = sep;
      faceBAxis = j;
      faceBSign = d >= 0 ? 1 : -1;
    }
  }

  // Edge-edge axes.
  let edgeSep = -Infinity;
  let edgeI = -1;
  let edgeJ = -1;
  let enx = 0;
  let eny = 0;
  let enz = 0;
  for (let i = 0; i < 3; i++) {
    const a = ua[i];
    for (let j = 0; j < 3; j++) {
      const b = ub[j];
      let lx = a[1] * b[2] - a[2] * b[1];
      let ly = a[2] * b[0] - a[0] * b[2];
      let lz = a[0] * b[1] - a[1] * b[0];
      const len = Math.sqrt(lx * lx + ly * ly + lz * lz);
      if (len < 1e-4) {
        continue;
      }
      lx /= len;
      ly /= len;
      lz /= len;
      const d = dx * lx + dy * ly + dz * lz;
      let ra = 0;
      let rb = 0;
      for (let k = 0; k < 3; k++) {
        const u = ua[k];
        ra += ea[k] * Math.abs(u[0] * lx + u[1] * ly + u[2] * lz);
        const w = ub[k];
        rb += eb[k] * Math.abs(w[0] * lx + w[1] * ly + w[2] * lz);
      }
      const sep = Math.abs(d) - ra - rb;
      if (sep > margin) {
        return null;
      }
      const s = d >= 0 ? 1 : -1;
      if (sep > edgeSep && !isBlocked(lx * s, ly * s, lz * s)) {
        edgeSep = sep;
        edgeI = i;
        edgeJ = j;
        enx = lx * s;
        eny = ly * s;
        enz = lz * s;
      }
    }
  }

  let type = -1;
  let best = -Infinity;
  if (faceASep > -Infinity) {
    type = 0;
    best = faceASep;
  }
  if (faceBAxis >= 0 && (type < 0 || faceBSep > best + FACE_B_TOLERANCE)) {
    type = 1;
    best = faceBSep;
  }
  if (edgeI >= 0 && (type < 0 || edgeSep > best + EDGE_TOLERANCE)) {
    type = 2;
  }
  if (type < 0) {
    // Every axis leads into an internal face: the box is buried inside the
    // static geometry. Ignore internal faces rather than produce nothing.
    return blockedB !== 0 ? collideBoxes(A, B, margin, 0) : null;
  }

  if (type === 2) {
    return edgeContact(A, B, edgeI, edgeJ, enx, eny, enz, edgeSep);
  }
  if (type === 0) {
    const a = ua[faceAAxis];
    return faceContact(
      A,
      ua,
      ea,
      B,
      ub,
      eb,
      faceAAxis,
      a[0] * faceASign,
      a[1] * faceASign,
      a[2] * faceASign,
      false,
      margin,
    );
  }
  const b = ub[faceBAxis];
  // Reference normal points from B towards A.
  return faceContact(
    B,
    ub,
    eb,
    A,
    ua,
    ea,
    faceBAxis,
    -b[0] * faceBSign,
    -b[1] * faceBSign,
    -b[2] * faceBSign,
    true,
    margin,
  );
}

// Clipping scratch: polygons of up to 8 vertices.
interface ClipVertex {
  x: number;
  y: number;
  z: number;
  id: number;
  /** Label of the edge leaving this vertex: 0-3 incident edges, 4-7 clip planes. */
  edge: number;
}

function clipPolygon(
  poly: ClipVertex[],
  // Plane: dot(p, n) - offset <= 0 is inside.
  nx: number,
  ny: number,
  nz: number,
  offset: number,
  plane: number,
): ClipVertex[] {
  const out: ClipVertex[] = [];
  const count = poly.length;
  if (count === 0) {
    return out;
  }
  for (let i = 0; i < count; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % count];
    const da = a.x * nx + a.y * ny + a.z * nz - offset;
    const db = b.x * nx + b.y * ny + b.z * nz - offset;
    const aIn = da <= 1e-9;
    const bIn = db <= 1e-9;
    if (aIn) {
      out.push(a);
    }
    if (aIn !== bIn) {
      const t = da / (da - db);
      const id = 8 + plane * 8 + a.edge;
      out.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
        id,
        edge: aIn ? 4 + plane : a.edge,
      });
    }
  }
  return out;
}

function faceContact(
  R: Box,
  ur: Float64Array[],
  er: Float64Array,
  I: Box,
  ui: Float64Array[],
  ei: Float64Array,
  refAxis: number,
  nx: number,
  ny: number,
  nz: number,
  flip: boolean,
  margin: number,
): RawManifold | null {
  // Incident face: the face of I most anti-parallel to the reference normal.
  let incAxis = 0;
  let incDot = 0;
  for (let k = 0; k < 3; k++) {
    const u = ui[k];
    const d = u[0] * nx + u[1] * ny + u[2] * nz;
    if (Math.abs(d) > Math.abs(incDot)) {
      incDot = d;
      incAxis = k;
    }
  }
  const incSign = incDot > 0 ? -1 : 1;
  const iu = ui[incAxis];
  const fcx = I.px + iu[0] * ei[incAxis] * incSign;
  const fcy = I.py + iu[1] * ei[incAxis] * incSign;
  const fcz = I.pz + iu[2] * ei[incAxis] * incSign;
  const k1 = (incAxis + 1) % 3;
  const k2 = (incAxis + 2) % 3;
  const u1 = ui[k1];
  const u2 = ui[k2];
  const e1 = ei[k1];
  const e2 = ei[k2];
  const corners = [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ];
  let poly: ClipVertex[] = [];
  for (let v = 0; v < 4; v++) {
    const s1 = corners[v][0] * e1;
    const s2 = corners[v][1] * e2;
    poly.push({
      x: fcx + u1[0] * s1 + u2[0] * s2,
      y: fcy + u1[1] * s1 + u2[1] * s2,
      z: fcz + u1[2] * s1 + u2[2] * s2,
      id: v,
      edge: v,
    });
  }

  // Side planes of the reference face.
  const r1 = (refAxis + 1) % 3;
  const r2 = (refAxis + 2) % 3;
  const side = [r1, r1, r2, r2];
  for (let p = 0; p < 4 && poly.length > 0; p++) {
    const u = ur[side[p]];
    const s = p % 2 === 0 ? 1 : -1;
    const pnx = u[0] * s;
    const pny = u[1] * s;
    const pnz = u[2] * s;
    const offset = pnx * R.px + pny * R.py + pnz * R.pz + er[side[p]];
    poly = clipPolygon(poly, pnx, pny, pnz, offset, p);
  }
  if (poly.length === 0) {
    return null;
  }

  const refOffset = nx * R.px + ny * R.py + nz * R.pz + er[refAxis];
  const refFace =
    refAxis * 2 +
    (nx * ur[refAxis][0] + ny * ur[refAxis][1] + nz * ur[refAxis][2] > 0
      ? 0
      : 1);
  const incFace = incAxis * 2 + (incSign > 0 ? 0 : 1);
  const base = ((flip ? 6 : 0) + refFace) * 6 + incFace;
  let points: RawPoint[] = [];
  for (const v of poly) {
    const sep = v.x * nx + v.y * ny + v.z * nz - refOffset;
    if (sep > margin) {
      continue;
    }
    // Midway between the incident point and its projection on the reference face.
    const h = sep * 0.5;
    points.push({
      x: v.x - nx * h,
      y: v.y - ny * h,
      z: v.z - nz * h,
      sep,
      id: base * 64 + v.id,
    });
  }
  if (points.length === 0) {
    return null;
  }
  if (points.length > 4) {
    points = reducePoints(points, nx, ny, nz);
  }
  return flip ? { nx: -nx, ny: -ny, nz: -nz, points } : { nx, ny, nz, points };
}

/** Keeps the deepest point and three others spanning the largest area. */
function reducePoints(
  points: RawPoint[],
  nx: number,
  ny: number,
  nz: number,
): RawPoint[] {
  let i0 = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].sep < points[i0].sep) {
      i0 = i;
    }
  }
  const p0 = points[i0];
  let i1 = -1;
  let bestD = -1;
  for (let i = 0; i < points.length; i++) {
    if (i === i0) {
      continue;
    }
    const ex = points[i].x - p0.x;
    const ey = points[i].y - p0.y;
    const ez = points[i].z - p0.z;
    const d = ex * ex + ey * ey + ez * ez;
    if (d > bestD) {
      bestD = d;
      i1 = i;
    }
  }
  const p1 = points[i1];
  const area = (a: RawPoint, b: RawPoint, c: RawPoint): number => {
    const ux = b.x - a.x;
    const uy = b.y - a.y;
    const uz = b.z - a.z;
    const vx = c.x - a.x;
    const vy = c.y - a.y;
    const vz = c.z - a.z;
    return (
      (uy * vz - uz * vy) * nx +
      (uz * vx - ux * vz) * ny +
      (ux * vy - uy * vx) * nz
    );
  };
  let i2 = -1;
  let bestA = -1;
  for (let i = 0; i < points.length; i++) {
    if (i === i0 || i === i1) {
      continue;
    }
    const a = Math.abs(area(p0, p1, points[i]));
    if (a > bestA) {
      bestA = a;
      i2 = i;
    }
  }
  const p2 = points[i2];
  const orient = area(p0, p1, p2) >= 0 ? 1 : -1;
  let i3 = -1;
  let bestOut = 0;
  for (let i = 0; i < points.length; i++) {
    if (i === i0 || i === i1 || i === i2) {
      continue;
    }
    const p = points[i];
    // Area added outside each edge of the triangle.
    const out = Math.max(
      -area(p0, p1, p) * orient,
      -area(p1, p2, p) * orient,
      -area(p2, p0, p) * orient,
    );
    if (out > bestOut) {
      bestOut = out;
      i3 = i;
    }
  }
  const result = [p0, p1, p2];
  if (i3 >= 0) {
    result.push(points[i3]);
  }
  return result;
}

function edgeContact(
  A: Box,
  B: Box,
  i: number,
  j: number,
  nx: number,
  ny: number,
  nz: number,
  sep: number,
): RawManifold {
  // Point on the edge of A nearest B, and the edge of B nearest A.
  let ax = A.px;
  let ay = A.py;
  let az = A.pz;
  let signsA = 0;
  for (let k = 0; k < 3; k++) {
    if (k === i) {
      continue;
    }
    const u = ua[k];
    const s = u[0] * nx + u[1] * ny + u[2] * nz > 0 ? 1 : -1;
    ax += u[0] * ea[k] * s;
    ay += u[1] * ea[k] * s;
    az += u[2] * ea[k] * s;
    signsA = signsA * 2 + (s > 0 ? 1 : 0);
  }
  let bx = B.px;
  let by = B.py;
  let bz = B.pz;
  let signsB = 0;
  for (let k = 0; k < 3; k++) {
    if (k === j) {
      continue;
    }
    const u = ub[k];
    const s = u[0] * nx + u[1] * ny + u[2] * nz > 0 ? -1 : 1;
    bx += u[0] * eb[k] * s;
    by += u[1] * eb[k] * s;
    bz += u[2] * eb[k] * s;
    signsB = signsB * 2 + (s > 0 ? 1 : 0);
  }
  const da = ua[i];
  const db = ub[j];
  // Closest points between segments ax + s*da (|s|<=ea[i]) and bx + t*db.
  const rx = ax - bx;
  const ry = ay - by;
  const rz = az - bz;
  const b = da[0] * db[0] + da[1] * db[1] + da[2] * db[2];
  const c = da[0] * rx + da[1] * ry + da[2] * rz;
  const f = db[0] * rx + db[1] * ry + db[2] * rz;
  const denom = 1 - b * b;
  let s = denom > 1e-9 ? (b * f - c) / denom : 0;
  s = Math.max(-ea[i], Math.min(ea[i], s));
  let t = b * s + f;
  t = Math.max(-eb[j], Math.min(eb[j], t));
  s = Math.max(-ea[i], Math.min(ea[i], b * t - c));
  const pax = ax + da[0] * s;
  const pay = ay + da[1] * s;
  const paz = az + da[2] * s;
  const pbx = bx + db[0] * t;
  const pby = by + db[1] * t;
  const pbz = bz + db[2] * t;
  // Face ids stay below 72 * 64; edge ids start above them.
  const id = 8192 + ((i * 3 + j) * 4 + signsA) * 4 + signsB;
  return {
    nx,
    ny,
    nz,
    points: [
      {
        x: (pax + pbx) * 0.5,
        y: (pay + pby) * 0.5,
        z: (paz + pbz) * 0.5,
        sep,
        id,
      },
    ],
  };
}
