import type { Quat } from "./quat";
import type { Vec3 } from "./vec3";

/**
 * 4x4 matrix, column-major (element [column * 4 + row]), ready to upload to
 * WebGPU as a mat4x4f. Functions here return new matrices.
 */
export type Mat4 = Float32Array;

export function identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

/** a * b: applies b first, then a. */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += a[k * 4 + r] * b[c * 4 + k];
      }
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

/** Model matrix from translation, rotation and (optional) per-axis scale. */
export function fromTRS(
  position: Vec3,
  orientation: Quat,
  scale: Vec3 = { x: 1, y: 1, z: 1 },
): Mat4 {
  const { x, y, z, w } = orientation;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  const m = new Float32Array(16);
  m[0] = (1 - 2 * (yy + zz)) * scale.x;
  m[1] = 2 * (xy + wz) * scale.x;
  m[2] = 2 * (xz - wy) * scale.x;
  m[4] = 2 * (xy - wz) * scale.y;
  m[5] = (1 - 2 * (xx + zz)) * scale.y;
  m[6] = 2 * (yz + wx) * scale.y;
  m[8] = 2 * (xz + wy) * scale.z;
  m[9] = 2 * (yz - wx) * scale.z;
  m[10] = (1 - 2 * (xx + yy)) * scale.z;
  m[12] = position.x;
  m[13] = position.y;
  m[14] = position.z;
  m[15] = 1;
  return m;
}

/** View matrix (world to camera) for a camera at `position` with `orientation`. */
export function view(position: Vec3, orientation: Quat): Mat4 {
  const inverse = {
    x: -orientation.x,
    y: -orientation.y,
    z: -orientation.z,
    w: orientation.w,
  };
  const m = fromTRS({ x: 0, y: 0, z: 0 }, inverse);
  m[12] = -(m[0] * position.x + m[4] * position.y + m[8] * position.z);
  m[13] = -(m[1] * position.x + m[5] * position.y + m[9] * position.z);
  m[14] = -(m[2] * position.x + m[6] * position.y + m[10] * position.z);
  return m;
}

/**
 * Right-handed perspective projection looking down -Z, with WebGPU's
 * clip-space depth range of 0 (near) to 1 (far).
 */
export function perspective(
  fovY: number,
  aspect: number,
  near: number,
  far: number,
): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = far / (near - far);
  m[11] = -1;
  m[14] = (near * far) / (near - far);
  return m;
}

/** Transform a point (w = 1), including the perspective divide. */
export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  const x = m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12];
  const y = m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13];
  const z = m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14];
  const w = m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15];
  return w !== 0 && w !== 1 ? { x: x / w, y: y / w, z: z / w } : { x, y, z };
}

/** Transform a direction (w = 0): rotation and scale only. */
export function transformDirection(m: Mat4, d: Vec3): Vec3 {
  return {
    x: m[0] * d.x + m[4] * d.y + m[8] * d.z,
    y: m[1] * d.x + m[5] * d.y + m[9] * d.z,
    z: m[2] * d.x + m[6] * d.y + m[10] * d.z,
  };
}

/** General inverse. Returns the identity if the matrix is singular. */
export function invert(a: Mat4): Mat4 {
  const a00 = a[0];
  const a01 = a[1];
  const a02 = a[2];
  const a03 = a[3];
  const a10 = a[4];
  const a11 = a[5];
  const a12 = a[6];
  const a13 = a[7];
  const a20 = a[8];
  const a21 = a[9];
  const a22 = a[10];
  const a23 = a[11];
  const a30 = a[12];
  const a31 = a[13];
  const a32 = a[14];
  const a33 = a[15];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det =
    b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-20) {
    return identity();
  }
  const inv = 1 / det;
  const out = new Float32Array(16);
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * inv;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * inv;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * inv;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * inv;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * inv;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * inv;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * inv;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * inv;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * inv;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * inv;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * inv;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * inv;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * inv;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * inv;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * inv;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * inv;
  return out;
}
