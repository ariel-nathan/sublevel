/**
 * Shared math. Usage: `import { v3, quat, mat4, type Vec3 } from "../math";`
 *
 * Conventions used across the whole project:
 * - Right-handed, Y up, units are metres, seconds, kilograms, radians.
 * - A camera or player with yaw 0 looks along -Z; +X is to its right.
 * - Matrices are column-major Float32Array(16); clip depth is 0..1 (WebGPU).
 */
export * as v3 from "./vec3";
export * as quat from "./quat";
export * as mat4 from "./mat4";
export type { Vec3 } from "./vec3";
export type { Quat } from "./quat";
export type { Mat4 } from "./mat4";

export function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
