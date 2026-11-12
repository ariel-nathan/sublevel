import type { Vec3 } from "./vec3";

/** A rotation quaternion. Functions here never mutate their arguments. */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export function identity(): Quat {
  return { x: 0, y: 0, z: 0, w: 1 };
}

export function clone(q: Quat): Quat {
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

/** Rotation of `angle` radians about a unit `axis` (right-hand rule). */
export function fromAxisAngle(axis: Vec3, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return {
    x: axis.x * s,
    y: axis.y * s,
    z: axis.z * s,
    w: Math.cos(angle / 2),
  };
}

/**
 * First-person view orientation. Yaw 0 looks along -Z; positive yaw turns
 * left (about +Y). Positive pitch looks up (about the local +X axis).
 */
export function fromYawPitch(yaw: number, pitch: number): Quat {
  return multiply(
    fromAxisAngle({ x: 0, y: 1, z: 0 }, yaw),
    fromAxisAngle({ x: 1, y: 0, z: 0 }, pitch),
  );
}

/** The rotation that applies b first, then a. */
export function multiply(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** Inverse rotation, for a unit quaternion. */
export function conjugate(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

export function normalize(q: Quat): Quat {
  const len = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  if (len < 1e-12) {
    return identity();
  }
  const inv = 1 / len;
  return { x: q.x * inv, y: q.y * inv, z: q.z * inv, w: q.w * inv };
}

/** Rotate vector v by unit quaternion q. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  // v' = v + 2w(u x v) + 2(u x (u x v)), u = (q.x, q.y, q.z)
  const cx = q.y * v.z - q.z * v.y;
  const cy = q.z * v.x - q.x * v.z;
  const cz = q.x * v.y - q.y * v.x;
  const ccx = q.y * cz - q.z * cy;
  const ccy = q.z * cx - q.x * cz;
  const ccz = q.x * cy - q.y * cx;
  return {
    x: v.x + 2 * (q.w * cx + ccx),
    y: v.y + 2 * (q.w * cy + ccy),
    z: v.z + 2 * (q.w * cz + ccz),
  };
}

/** Advance orientation q by a world-space angular velocity over dt seconds. */
export function integrate(q: Quat, angularVelocity: Vec3, dt: number): Quat {
  const half = 0.5 * dt;
  const wx = angularVelocity.x * half;
  const wy = angularVelocity.y * half;
  const wz = angularVelocity.z * half;
  // q + 0.5 * dt * (omega, 0) * q
  return normalize({
    x: q.x + wx * q.w + wy * q.z - wz * q.y,
    y: q.y - wx * q.z + wy * q.w + wz * q.x,
    z: q.z + wx * q.y - wy * q.x + wz * q.w,
    w: q.w - wx * q.x - wy * q.y - wz * q.z,
  });
}

/** Spherical interpolation along the shortest arc. */
export function slerp(a: Quat, b: Quat, t: number): Quat {
  let cos = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let sa = 1 - t;
  let sb = t;
  if (cos < 0.9995) {
    const angle = Math.acos(cos);
    const sin = Math.sin(angle);
    sa = Math.sin((1 - t) * angle) / sin;
    sb = Math.sin(t * angle) / sin;
  }
  return normalize({
    x: a.x * sa + bx * sb,
    y: a.y * sa + by * sb,
    z: a.z * sa + bz * sb,
    w: a.w * sa + bw * sb,
  });
}
