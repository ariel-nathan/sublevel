/**
 * Internal rigid body representation. Plain mutable numbers for speed; the
 * public API copies data in and out as shared Vec3/Quat objects.
 *
 * The same class also serves as the "solver proxy" for static geometry,
 * kinematic boxes and the character obstacle: those have zero inverse mass
 * and inertia, never rotate, and may carry a velocity.
 */
export class Body {
  readonly id: number;
  tag: string;
  /** True for simulated bodies; false for static/kinematic proxies. */
  readonly dynamic: boolean;

  px = 0;
  py = 0;
  pz = 0;
  qx = 0;
  qy = 0;
  qz = 0;
  qw = 1;
  vx = 0;
  vy = 0;
  vz = 0;
  wx = 0;
  wy = 0;
  wz = 0;

  hx: number;
  hy: number;
  hz: number;
  /** Bounding sphere radius (length of half extents). */
  radius: number;
  mass: number;
  invMass: number;
  friction: number;
  restitution: number;
  /** Inverse principal moments of inertia in body space. */
  ilx: number;
  ily: number;
  ilz: number;

  /** Rotation matrix, row-major. Column j is local axis j in world space. */
  readonly r = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  /** World-space inverse inertia tensor, row-major. */
  readonly ii = new Float64Array(9);
  /** Rotation at the start of the step. */
  readonly r0 = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  /** Rotation since the start of the step: r * r0^T. */
  readonly dq = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  /** Translation since the start of the step. */
  dpx = 0;
  dpy = 0;
  dpz = 0;

  asleep = false;
  sleepTime = 0;
  /** Members of the sleeping island this body belongs to, while asleep. */
  island: Body[] | null = null;
  /** Force and torque applied over the next step, then cleared. */
  fx = 0;
  fy = 0;
  fz = 0;
  tx = 0;
  ty = 0;
  tz = 0;

  /** Exact world bounds at the current pose. */
  minx = 0;
  miny = 0;
  minz = 0;
  maxx = 0;
  maxy = 0;
  maxz = 0;
  /** Speculative margin for the current step. */
  margin = 0;
  /** Scratch for island building. */
  parent = 0;
  /** Set when something (a moving kinematic) must keep this body awake. */
  keepAwake = false;

  constructor(
    id: number,
    hx: number,
    hy: number,
    hz: number,
    mass: number,
    dynamic: boolean,
  ) {
    this.id = id;
    this.tag = "";
    this.dynamic = dynamic;
    this.hx = hx;
    this.hy = hy;
    this.hz = hz;
    this.radius = Math.sqrt(hx * hx + hy * hy + hz * hz);
    this.friction = 0.6;
    this.restitution = 0;
    if (dynamic) {
      this.mass = mass;
      this.invMass = 1 / mass;
      // Solid box: I = m/3 * (b^2 + c^2) with half extents.
      this.ilx = 3 / (mass * (hy * hy + hz * hz));
      this.ily = 3 / (mass * (hx * hx + hz * hz));
      this.ilz = 3 / (mass * (hx * hx + hy * hy));
    } else {
      this.mass = 0;
      this.invMass = 0;
      this.ilx = 0;
      this.ily = 0;
      this.ilz = 0;
    }
  }

  /** Normalises q, then refreshes the rotation matrix and world inertia. */
  updateRotation(): void {
    let len = Math.sqrt(
      this.qx * this.qx +
        this.qy * this.qy +
        this.qz * this.qz +
        this.qw * this.qw,
    );
    if (len < 1e-12) {
      this.qx = 0;
      this.qy = 0;
      this.qz = 0;
      this.qw = 1;
      len = 1;
    }
    const inv = 1 / len;
    const x = (this.qx *= inv);
    const y = (this.qy *= inv);
    const z = (this.qz *= inv);
    const w = (this.qw *= inv);
    const r = this.r;
    const xx = x * x;
    const yy = y * y;
    const zz = z * z;
    const xy = x * y;
    const xz = x * z;
    const yz = y * z;
    const wx = w * x;
    const wy = w * y;
    const wz = w * z;
    r[0] = 1 - 2 * (yy + zz);
    r[1] = 2 * (xy - wz);
    r[2] = 2 * (xz + wy);
    r[3] = 2 * (xy + wz);
    r[4] = 1 - 2 * (xx + zz);
    r[5] = 2 * (yz - wx);
    r[6] = 2 * (xz - wy);
    r[7] = 2 * (yz + wx);
    r[8] = 1 - 2 * (xx + yy);
    if (!this.dynamic) {
      return;
    }
    const ii = this.ii;
    const a = this.ilx;
    const b = this.ily;
    const c = this.ilz;
    for (let i = 0; i < 3; i++) {
      for (let j = i; j < 3; j++) {
        const v =
          r[i * 3] * a * r[j * 3] +
          r[i * 3 + 1] * b * r[j * 3 + 1] +
          r[i * 3 + 2] * c * r[j * 3 + 2];
        ii[i * 3 + j] = v;
        ii[j * 3 + i] = v;
      }
    }
  }

  /** Recomputes the exact world bounds from the current pose. */
  updateBounds(): void {
    const r = this.r;
    const ex =
      Math.abs(r[0]) * this.hx +
      Math.abs(r[1]) * this.hy +
      Math.abs(r[2]) * this.hz;
    const ey =
      Math.abs(r[3]) * this.hx +
      Math.abs(r[4]) * this.hy +
      Math.abs(r[5]) * this.hz;
    const ez =
      Math.abs(r[6]) * this.hx +
      Math.abs(r[7]) * this.hy +
      Math.abs(r[8]) * this.hz;
    this.minx = this.px - ex;
    this.miny = this.py - ey;
    this.minz = this.pz - ez;
    this.maxx = this.px + ex;
    this.maxy = this.py + ey;
    this.maxz = this.pz + ez;
  }

  /** Starts a step: remembers the pose so contacts can track relative motion. */
  beginStep(): void {
    this.dpx = 0;
    this.dpy = 0;
    this.dpz = 0;
    this.r0.set(this.r);
    const dq = this.dq;
    dq[0] = 1;
    dq[1] = 0;
    dq[2] = 0;
    dq[3] = 0;
    dq[4] = 1;
    dq[5] = 0;
    dq[6] = 0;
    dq[7] = 0;
    dq[8] = 1;
  }

  /** dq = r * r0^T, the rotation applied since beginStep. */
  updateDeltaRotation(): void {
    const r = this.r;
    const s = this.r0;
    const dq = this.dq;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        dq[i * 3 + j] =
          r[i * 3] * s[j * 3] +
          r[i * 3 + 1] * s[j * 3 + 1] +
          r[i * 3 + 2] * s[j * 3 + 2];
      }
    }
  }

  /** Velocity change from an impulse at a world-space offset from the centre. */
  applyImpulseAt(
    ix: number,
    iy: number,
    iz: number,
    rx: number,
    ry: number,
    rz: number,
  ): void {
    if (!this.dynamic || this.asleep) {
      return;
    }
    const m = this.invMass;
    this.vx += ix * m;
    this.vy += iy * m;
    this.vz += iz * m;
    const tx = ry * iz - rz * iy;
    const ty = rz * ix - rx * iz;
    const tz = rx * iy - ry * ix;
    const ii = this.ii;
    this.wx += ii[0] * tx + ii[1] * ty + ii[2] * tz;
    this.wy += ii[3] * tx + ii[4] * ty + ii[5] * tz;
    this.wz += ii[6] * tx + ii[7] * ty + ii[8] * tz;
  }

  /** Angular velocity change from a pure angular impulse. */
  applyAngularImpulse(x: number, y: number, z: number): void {
    if (!this.dynamic || this.asleep) {
      return;
    }
    const ii = this.ii;
    this.wx += ii[0] * x + ii[1] * y + ii[2] * z;
    this.wy += ii[3] * x + ii[4] * y + ii[5] * z;
    this.wz += ii[6] * x + ii[7] * y + ii[8] * z;
  }

  /** Inverse effective mass along unit direction n at world offset r. */
  inverseMassAt(
    nx: number,
    ny: number,
    nz: number,
    rx: number,
    ry: number,
    rz: number,
  ): number {
    if (!this.dynamic || this.asleep) {
      return 0;
    }
    const cx = ry * nz - rz * ny;
    const cy = rz * nx - rx * nz;
    const cz = rx * ny - ry * nx;
    const ii = this.ii;
    const ix = ii[0] * cx + ii[1] * cy + ii[2] * cz;
    const iy = ii[3] * cx + ii[4] * cy + ii[5] * cz;
    const iz = ii[6] * cx + ii[7] * cy + ii[8] * cz;
    return this.invMass + cx * ix + cy * iy + cz * iz;
  }
}

/** Oriented box view used by collision routines. */
export interface Box {
  px: number;
  py: number;
  pz: number;
  /** Row-major rotation; column j is local axis j. */
  r: Float64Array;
  hx: number;
  hy: number;
  hz: number;
}

export const IDENTITY = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/** A mutable axis-aligned box presented through the Box interface. */
export function aabbBox(
  minx: number,
  miny: number,
  minz: number,
  maxx: number,
  maxy: number,
  maxz: number,
): Box {
  return {
    px: (minx + maxx) * 0.5,
    py: (miny + maxy) * 0.5,
    pz: (minz + maxz) * 0.5,
    r: IDENTITY,
    hx: (maxx - minx) * 0.5,
    hy: (maxy - miny) * 0.5,
    hz: (maxz - minz) * 0.5,
  };
}
