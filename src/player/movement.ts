/**
 * The classic Quake/GoldSrc movement primitives, on a velocity that is
 * modified in place. Pure functions, no world access.
 */
import type { Vec3 } from "../math";

/**
 * Ground friction with a stop-speed term: below `stopSpeed` the player
 * decelerates as if moving at `stopSpeed`, so stops are crisp, not asymptotic.
 */
export function applyFriction(
  velocity: Vec3,
  friction: number,
  stopSpeed: number,
  dt: number,
): void {
  const speed = Math.hypot(velocity.x, velocity.z);
  if (speed < 1e-4) {
    velocity.x = 0;
    velocity.z = 0;
    return;
  }
  const control = Math.max(speed, stopSpeed);
  const newSpeed = Math.max(0, speed - control * friction * dt);
  const k = newSpeed / speed;
  velocity.x *= k;
  velocity.z *= k;
}

/**
 * Adds speed along `wishDir` (unit, horizontal) only up to `cap` measured
 * along that direction, at most `accel * wishSpeed * dt` per call. With a
 * small cap in the air this is what makes air-strafing and bunny-hopping work.
 */
export function accelerate(
  velocity: Vec3,
  wishDir: Vec3,
  wishSpeed: number,
  accel: number,
  cap: number,
  dt: number,
): void {
  const current = velocity.x * wishDir.x + velocity.z * wishDir.z;
  const add = Math.min(wishSpeed, cap) - current;
  if (add <= 0) {
    return;
  }
  const amount = Math.min(add, accel * wishSpeed * dt);
  velocity.x += wishDir.x * amount;
  velocity.z += wishDir.z * amount;
}

/**
 * Horizontal wish direction from the input axes rotated by yaw (yaw 0 looks
 * along -Z, +X is to the right). Diagonals are normalised; the returned
 * `amount` (0..1) scales the wish speed for analogue input.
 */
export function wishDirection(
  moveX: number,
  moveZ: number,
  yaw: number,
): { dir: Vec3; amount: number } {
  const len = Math.hypot(moveX, moveZ);
  if (len < 1e-6) {
    return { dir: { x: 0, y: 0, z: 0 }, amount: 0 };
  }
  const sx = moveX / len;
  const sz = moveZ / len;
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  // forward = (-sin yaw, 0, -cos yaw), right = (cos yaw, 0, -sin yaw)
  return {
    dir: { x: -s * sz + c * sx, y: 0, z: -c * sz - s * sx },
    amount: Math.min(1, len),
  };
}
