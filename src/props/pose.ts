import type { Mat4, Quat } from "../math";

/**
 * Writes a model matrix (translation, rotation, uniform scale) into `out`
 * without allocating. Same layout as `mat4.fromTRS`.
 */
export function composeInto(
  out: Mat4,
  x: number,
  y: number,
  z: number,
  q: Quat,
  s: number,
): Mat4 {
  const xx = q.x * q.x;
  const yy = q.y * q.y;
  const zz = q.z * q.z;
  const xy = q.x * q.y;
  const xz = q.x * q.z;
  const yz = q.y * q.z;
  const wx = q.w * q.x;
  const wy = q.w * q.y;
  const wz = q.w * q.z;
  out[0] = (1 - 2 * (yy + zz)) * s;
  out[1] = 2 * (xy + wz) * s;
  out[2] = 2 * (xz - wy) * s;
  out[3] = 0;
  out[4] = 2 * (xy - wz) * s;
  out[5] = (1 - 2 * (xx + zz)) * s;
  out[6] = 2 * (yz + wx) * s;
  out[7] = 0;
  out[8] = 2 * (xz + wy) * s;
  out[9] = 2 * (yz - wx) * s;
  out[10] = (1 - 2 * (xx + yy)) * s;
  out[11] = 0;
  out[12] = x;
  out[13] = y;
  out[14] = z;
  out[15] = 1;
  return out;
}

/** Unit quaternion rotating `from` onto `to` (both unit vectors) by the shortest arc. */
export function rotationBetween(
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
): Quat {
  const dot = from.x * to.x + from.y * to.y + from.z * to.z;
  if (dot < -0.999999) {
    // Opposite: turn half a revolution about any axis perpendicular to `from`.
    const axis =
      Math.abs(from.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    const cx = from.y * axis.z - from.z * axis.y;
    const cy = from.z * axis.x - from.x * axis.z;
    const cz = from.x * axis.y - from.y * axis.x;
    const len = Math.hypot(cx, cy, cz);
    return { x: cx / len, y: cy / len, z: cz / len, w: 0 };
  }
  const cx = from.y * to.z - from.z * to.y;
  const cy = from.z * to.x - from.x * to.z;
  const cz = from.x * to.y - from.y * to.x;
  const w = 1 + dot;
  const len = Math.hypot(cx, cy, cz, w);
  return { x: cx / len, y: cy / len, z: cz / len, w: w / len };
}
