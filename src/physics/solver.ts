/**
 * Contact constraints solved with sequential impulses in the "soft step"
 * scheme: each step is split into sub-steps; every sub-step integrates
 * velocities, warm starts, solves with a soft (spring-damper) position bias,
 * integrates positions, then relaxes without bias so the push-out velocity
 * does not linger as energy. Separation is tracked from the relative motion
 * of the bodies since the start of the step, so contacts stay accurate
 * across sub-steps without re-running collision detection. Speculative
 * contacts (positive separation) only allow closing the remaining gap.
 *
 * Friction is applied per manifold at the centroid of its points: a coupled
 * two-direction tangent constraint plus a twist constraint about the
 * normal. Unlike per-point friction this is symmetric, so resting and
 * sliding boxes do not creep or spin from solve-order bias.
 */
import type { ContactEvent } from "../core/api";
import type { Body } from "./body";

export class ContactPoint {
  id = 0;
  /** Anchors relative to each body centre at the start of the step. */
  rax = 0;
  ray = 0;
  raz = 0;
  rbx = 0;
  rby = 0;
  rbz = 0;
  /** World contact point at the start of the step. */
  px = 0;
  py = 0;
  pz = 0;
  sep = 0;
  /** Separation minus the anchor offset along the normal. */
  adjSep = 0;
  normalMass = 0;
  normalImpulse = 0;
  /** Normal relative velocity before solving; negative when approaching. */
  relativeVelocity = 0;
  maxNormalImpulse = 0;
  /** Distance from the manifold centroid, for twist friction. */
  twistArm = 0;
  /** Per-pass scratch: velocity bias and softness of the normal constraint. */
  bias = 0;
  massScale = 1;
  /** Sum of normal impulse applied over the whole step (N·s). */
  totalImpulse = 0;
}

/** What `b` is in a manifold; also the solve order (kinematic first, static last). */
export const PairKind = {
  Kinematic: 0,
  Character: 1,
  Body: 2,
  Static: 3,
} as const;
export type PairKind = (typeof PairKind)[keyof typeof PairKind];

export class Manifold {
  key: number;
  a: Body;
  b: Body;
  kind: PairKind;
  otherId: number;
  nx = 0;
  ny = 1;
  nz = 0;
  t1x = 1;
  t1y = 0;
  t1z = 0;
  t2x = 0;
  t2y = 0;
  t2z = 1;
  friction = 0.6;
  restitution = 0;
  points: ContactPoint[] = [];
  /** Friction anchors (centroid of the points) relative to each body. */
  cax = 0;
  cay = 0;
  caz = 0;
  cbx = 0;
  cby = 0;
  cbz = 0;
  /** Inverse of the 2x2 tangent effective mass matrix. */
  k11 = 0;
  k12 = 0;
  k22 = 0;
  twistMass = 0;
  tangentImpulse1 = 0;
  tangentImpulse2 = 0;
  twistImpulse = 0;
  /** Total normal impulse over the step. */
  total = 0;
  /** Impact event held back one step to merge impacts spanning two steps. */
  pending: ContactEvent | null = null;
  /** True when `b` has infinite mass (static, kinematic, character). */
  rigidB: boolean;

  constructor(key: number, a: Body, b: Body, kind: PairKind, otherId: number) {
    this.key = key;
    this.a = a;
    this.b = b;
    this.kind = kind;
    this.otherId = otherId;
    // Sleeping bodies take part in contacts as immovable objects.
    this.rigidB = !b.dynamic || b.asleep || a.asleep;
  }
}

export interface Softness {
  biasRate: number;
  massScale: number;
  impulseScale: number;
}

export function makeSoft(hertz: number, zeta: number, h: number): Softness {
  if (hertz === 0) {
    return { biasRate: 0, massScale: 1, impulseScale: 0 };
  }
  const omega = 2 * Math.PI * hertz;
  const a1 = 2 * zeta + h * omega;
  const a2 = h * omega * a1;
  const a3 = 1 / (1 + a2);
  return { biasRate: omega / a1, massScale: a2 * a3, impulseScale: a3 };
}

/** Penetration allowed before position correction kicks in. */
export const LINEAR_SLOP = 0.0002;
/** Maximum push-out speed of position correction. */
export const MAX_PUSH_VELOCITY = 3;
const RESTITUTION_THRESHOLD = 1;

/** (r x a) . I^-1 (r x b) for a body; zero for immovable ones. */
function crossMassTerm(
  b: Body,
  rx: number,
  ry: number,
  rz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): number {
  if (!b.dynamic || b.asleep) {
    return 0;
  }
  // (r x a) . I (r x b)
  const ux = ry * az - rz * ay;
  const uy = rz * ax - rx * az;
  const uz = rx * ay - ry * ax;
  const vx = ry * bz - rz * by;
  const vy = rz * bx - rx * bz;
  const vz = rx * by - ry * bx;
  const ii = b.ii;
  return (
    ux * (ii[0] * vx + ii[1] * vy + ii[2] * vz) +
    uy * (ii[3] * vx + ii[4] * vy + ii[5] * vz) +
    uz * (ii[6] * vx + ii[7] * vy + ii[8] * vz)
  );
}

/** Computes anchors, effective masses and the pre-solve relative velocity. */
export function prepareManifold(m: Manifold): void {
  const A = m.a;
  const B = m.b;
  const nx = m.nx;
  const ny = m.ny;
  const nz = m.nz;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const cp of m.points) {
    const rax = cp.rax;
    const ray = cp.ray;
    const raz = cp.raz;
    const rbx = cp.rbx;
    const rby = cp.rby;
    const rbz = cp.rbz;
    cp.adjSep =
      cp.sep - ((rbx - rax) * nx + (rby - ray) * ny + (rbz - raz) * nz);
    const kn =
      A.inverseMassAt(nx, ny, nz, rax, ray, raz) +
      B.inverseMassAt(nx, ny, nz, rbx, rby, rbz);
    cp.normalMass = kn > 0 ? 1 / kn : 0;
    const dvx =
      B.vx + B.wy * rbz - B.wz * rby - (A.vx + A.wy * raz - A.wz * ray);
    const dvy =
      B.vy + B.wz * rbx - B.wx * rbz - (A.vy + A.wz * rax - A.wx * raz);
    const dvz =
      B.vz + B.wx * rby - B.wy * rbx - (A.vz + A.wx * ray - A.wy * rax);
    cp.relativeVelocity = dvx * nx + dvy * ny + dvz * nz;
    cp.maxNormalImpulse = 0;
    cp.totalImpulse = 0;
    cx += cp.rax;
    cy += cp.ray;
    cz += cp.raz;
  }
  const count = m.points.length;
  cx /= count;
  cy /= count;
  cz /= count;
  m.cax = cx;
  m.cay = cy;
  m.caz = cz;
  // Same world point seen from B.
  const p0 = m.points[0];
  m.cbx = cx + p0.rbx - p0.rax;
  m.cby = cy + p0.rby - p0.ray;
  m.cbz = cz + p0.rbz - p0.raz;
  for (const cp of m.points) {
    const dx = cp.rax - cx;
    const dy = cp.ray - cy;
    const dz = cp.raz - cz;
    const along = dx * nx + dy * ny + dz * nz;
    cp.twistArm = Math.sqrt(
      Math.max(0, dx * dx + dy * dy + dz * dz - along * along),
    );
  }

  // Coupled tangent effective mass at the centroid.
  const im = A.invMass + B.invMass;
  const t1x = m.t1x;
  const t1y = m.t1y;
  const t1z = m.t1z;
  const t2x = m.t2x;
  const t2y = m.t2y;
  const t2z = m.t2z;
  const a11 =
    im +
    crossMassTerm(A, m.cax, m.cay, m.caz, t1x, t1y, t1z, t1x, t1y, t1z) +
    crossMassTerm(B, m.cbx, m.cby, m.cbz, t1x, t1y, t1z, t1x, t1y, t1z);
  const a22 =
    im +
    crossMassTerm(A, m.cax, m.cay, m.caz, t2x, t2y, t2z, t2x, t2y, t2z) +
    crossMassTerm(B, m.cbx, m.cby, m.cbz, t2x, t2y, t2z, t2x, t2y, t2z);
  const a12 =
    crossMassTerm(A, m.cax, m.cay, m.caz, t1x, t1y, t1z, t2x, t2y, t2z) +
    crossMassTerm(B, m.cbx, m.cby, m.cbz, t1x, t1y, t1z, t2x, t2y, t2z);
  const det = a11 * a22 - a12 * a12;
  if (det > 1e-12) {
    const inv = 1 / det;
    m.k11 = a22 * inv;
    m.k22 = a11 * inv;
    m.k12 = -a12 * inv;
  } else {
    m.k11 = 0;
    m.k22 = 0;
    m.k12 = 0;
  }
  const kt = angularMassAbout(A, nx, ny, nz) + angularMassAbout(B, nx, ny, nz);
  m.twistMass = kt > 0 ? 1 / kt : 0;
}

function angularMassAbout(b: Body, nx: number, ny: number, nz: number): number {
  if (!b.dynamic || b.asleep) {
    return 0;
  }
  const ii = b.ii;
  return (
    nx * (ii[0] * nx + ii[1] * ny + ii[2] * nz) +
    ny * (ii[3] * nx + ii[4] * ny + ii[5] * nz) +
    nz * (ii[6] * nx + ii[7] * ny + ii[8] * nz)
  );
}

function applyAt(
  A: Body,
  B: Body,
  px: number,
  py: number,
  pz: number,
  rax: number,
  ray: number,
  raz: number,
  rbx: number,
  rby: number,
  rbz: number,
): void {
  A.applyImpulseAt(-px, -py, -pz, rax, ray, raz);
  B.applyImpulseAt(px, py, pz, rbx, rby, rbz);
}

function applyTwist(m: Manifold, impulse: number): void {
  const x = m.nx * impulse;
  const y = m.ny * impulse;
  const z = m.nz * impulse;
  m.a.applyAngularImpulse(-x, -y, -z);
  m.b.applyAngularImpulse(x, y, z);
}

export function warmStart(m: Manifold): void {
  const A = m.a;
  const B = m.b;
  for (const cp of m.points) {
    const n = cp.normalImpulse;
    applyAt(
      A,
      B,
      m.nx * n,
      m.ny * n,
      m.nz * n,
      cp.rax,
      cp.ray,
      cp.raz,
      cp.rbx,
      cp.rby,
      cp.rbz,
    );
  }
  const f1 = m.tangentImpulse1;
  const f2 = m.tangentImpulse2;
  applyAt(
    A,
    B,
    m.t1x * f1 + m.t2x * f2,
    m.t1y * f1 + m.t2y * f2,
    m.t1z * f1 + m.t2z * f2,
    m.cax,
    m.cay,
    m.caz,
    m.cbx,
    m.cby,
    m.cbz,
  );
  applyTwist(m, m.twistImpulse);
}

function solveFriction(m: Manifold): void {
  const A = m.a;
  const B = m.b;
  let normalSum = 0;
  let twistLimit = 0;
  for (const cp of m.points) {
    normalSum += cp.normalImpulse;
    twistLimit += cp.normalImpulse * cp.twistArm;
  }
  const mu = m.friction;

  // Twist about the normal.
  {
    const dw =
      (B.wx - A.wx) * m.nx + (B.wy - A.wy) * m.ny + (B.wz - A.wz) * m.nz;
    const max = mu * twistLimit;
    const next = Math.max(
      -max,
      Math.min(max, m.twistImpulse - m.twistMass * dw),
    );
    const d = next - m.twistImpulse;
    m.twistImpulse = next;
    applyTwist(m, d);
  }

  // Tangent plane at the centroid.
  const rax = m.cax;
  const ray = m.cay;
  const raz = m.caz;
  const rbx = m.cbx;
  const rby = m.cby;
  const rbz = m.cbz;
  const dvx = B.vx + B.wy * rbz - B.wz * rby - (A.vx + A.wy * raz - A.wz * ray);
  const dvy = B.vy + B.wz * rbx - B.wx * rbz - (A.vy + A.wz * rax - A.wx * raz);
  const dvz = B.vz + B.wx * rby - B.wy * rbx - (A.vz + A.wx * ray - A.wy * rax);
  const v1 = dvx * m.t1x + dvy * m.t1y + dvz * m.t1z;
  const v2 = dvx * m.t2x + dvy * m.t2y + dvz * m.t2z;
  let n1 = m.tangentImpulse1 - (m.k11 * v1 + m.k12 * v2);
  let n2 = m.tangentImpulse2 - (m.k12 * v1 + m.k22 * v2);
  const max = mu * normalSum;
  const lenSq = n1 * n1 + n2 * n2;
  if (lenSq > max * max) {
    const s = max / Math.sqrt(lenSq);
    n1 *= s;
    n2 *= s;
  }
  const d1 = n1 - m.tangentImpulse1;
  const d2 = n2 - m.tangentImpulse2;
  m.tangentImpulse1 = n1;
  m.tangentImpulse2 = n2;
  applyAt(
    A,
    B,
    m.t1x * d1 + m.t2x * d2,
    m.t1y * d1 + m.t2y * d2,
    m.t1z * d1 + m.t2z * d2,
    rax,
    ray,
    raz,
    rbx,
    rby,
    rbz,
  );
}

/**
 * One sequential-impulse pass over a manifold. With `useBias` the soft
 * position correction is active; without it only speculative gaps are
 * honoured (relax pass). The normal constraints of the manifold are swept
 * `normalIterations` times so the impulse spreads over all points evenly
 * instead of favouring whichever point is solved first (which would make a
 * flat landing spin and drift).
 */
export function solveManifold(
  m: Manifold,
  soft: Softness,
  useBias: boolean,
  invH: number,
  normalIterations: number,
): void {
  const A = m.a;
  const B = m.b;
  const nx = m.nx;
  const ny = m.ny;
  const nz = m.nz;
  const da = A.dq;
  const db = B.dq;
  const aRot = A.dynamic;
  const bRot = B.dynamic;
  const points = m.points;

  // Friction first, so the normal constraint has the last word.
  solveFriction(m);

  for (const cp of points) {
    const rax = cp.rax;
    const ray = cp.ray;
    const raz = cp.raz;
    const rbx = cp.rbx;
    const rby = cp.rby;
    const rbz = cp.rbz;
    // Current separation from the motion since the start of the step.
    let prax = rax;
    let pray = ray;
    let praz = raz;
    if (aRot) {
      prax = da[0] * rax + da[1] * ray + da[2] * raz;
      pray = da[3] * rax + da[4] * ray + da[5] * raz;
      praz = da[6] * rax + da[7] * ray + da[8] * raz;
    }
    let prbx = rbx;
    let prby = rby;
    let prbz = rbz;
    if (bRot) {
      prbx = db[0] * rbx + db[1] * rby + db[2] * rbz;
      prby = db[3] * rbx + db[4] * rby + db[5] * rbz;
      prbz = db[6] * rbx + db[7] * rby + db[8] * rbz;
    }
    const s =
      (B.dpx - A.dpx + prbx - prax) * nx +
      (B.dpy - A.dpy + prby - pray) * ny +
      (B.dpz - A.dpz + prbz - praz) * nz +
      cp.adjSep;

    let bias = 0;
    let massScale = 1;
    let impulseScale = 0;
    if (s > 0) {
      // Speculative: allow closing the gap within this sub-step.
      bias = s * invH;
    } else if (useBias) {
      const c = Math.min(0, s + LINEAR_SLOP);
      bias = Math.max(soft.biasRate * c, -MAX_PUSH_VELOCITY);
      massScale = soft.massScale;
      impulseScale = soft.impulseScale;
    }
    cp.bias = bias;
    cp.massScale = massScale;
    // The softness leak is applied once per pass.
    solveNormal(A, B, nx, ny, nz, cp, bias, massScale, impulseScale);
  }
  for (let iter = 1; iter < normalIterations; iter++) {
    for (const cp of points) {
      solveNormal(A, B, nx, ny, nz, cp, cp.bias, cp.massScale, 0);
    }
  }
}

function solveNormal(
  A: Body,
  B: Body,
  nx: number,
  ny: number,
  nz: number,
  cp: ContactPoint,
  bias: number,
  massScale: number,
  impulseScale: number,
): void {
  const rax = cp.rax;
  const ray = cp.ray;
  const raz = cp.raz;
  const rbx = cp.rbx;
  const rby = cp.rby;
  const rbz = cp.rbz;
  const dvx = B.vx + B.wy * rbz - B.wz * rby - (A.vx + A.wy * raz - A.wz * ray);
  const dvy = B.vy + B.wz * rbx - B.wx * rbz - (A.vy + A.wz * rax - A.wx * raz);
  const dvz = B.vz + B.wx * rby - B.wy * rbx - (A.vz + A.wx * ray - A.wy * rax);
  const vn = dvx * nx + dvy * ny + dvz * nz;
  let impulse =
    -cp.normalMass * massScale * (vn + bias) - impulseScale * cp.normalImpulse;
  const total = Math.max(cp.normalImpulse + impulse, 0);
  impulse = total - cp.normalImpulse;
  cp.normalImpulse = total;
  if (total > cp.maxNormalImpulse) {
    cp.maxNormalImpulse = total;
  }
  applyAt(
    A,
    B,
    nx * impulse,
    ny * impulse,
    nz * impulse,
    rax,
    ray,
    raz,
    rbx,
    rby,
    rbz,
  );
}

/** Bounce for points that were approaching fast and actually got pushed. */
export function applyRestitution(m: Manifold): void {
  if (m.restitution === 0) {
    return;
  }
  for (let iter = 0; iter < 4; iter++) {
    restitutionSweep(m);
  }
}

function restitutionSweep(m: Manifold): void {
  const A = m.a;
  const B = m.b;
  const nx = m.nx;
  const ny = m.ny;
  const nz = m.nz;
  for (const cp of m.points) {
    if (
      cp.relativeVelocity > -RESTITUTION_THRESHOLD ||
      cp.maxNormalImpulse === 0
    ) {
      continue;
    }
    const rax = cp.rax;
    const ray = cp.ray;
    const raz = cp.raz;
    const rbx = cp.rbx;
    const rby = cp.rby;
    const rbz = cp.rbz;
    const dvx =
      B.vx + B.wy * rbz - B.wz * rby - (A.vx + A.wy * raz - A.wz * ray);
    const dvy =
      B.vy + B.wz * rbx - B.wx * rbz - (A.vy + A.wz * rax - A.wx * raz);
    const dvz =
      B.vz + B.wx * rby - B.wy * rbx - (A.vz + A.wx * ray - A.wy * rax);
    const vn = dvx * nx + dvy * ny + dvz * nz;
    let impulse = -cp.normalMass * (vn + m.restitution * cp.relativeVelocity);
    const total = Math.max(cp.normalImpulse + impulse, 0);
    impulse = total - cp.normalImpulse;
    cp.normalImpulse = total;
    cp.totalImpulse += impulse;
    applyAt(
      A,
      B,
      nx * impulse,
      ny * impulse,
      nz * impulse,
      rax,
      ray,
      raz,
      rbx,
      rby,
      rbz,
    );
  }
}
