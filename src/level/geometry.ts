import type { Aabb, Brush, PropSpawn } from "../core/api";
import { PROP_SPECS } from "../core/props";

/** Plain-number axis-aligned box, used internally for speed. */
export interface Box {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

export function boxOf(b: Aabb | Brush): Box {
  return {
    x0: b.min.x,
    y0: b.min.y,
    z0: b.min.z,
    x1: b.max.x,
    y1: b.max.y,
    z1: b.max.z,
  };
}

/** True if the boxes overlap by more than `eps` on every axis. */
export function boxesOverlap(a: Box, b: Box, eps = 0): boolean {
  return (
    a.x0 < b.x1 - eps &&
    a.x1 > b.x0 + eps &&
    a.y0 < b.y1 - eps &&
    a.y1 > b.y0 + eps &&
    a.z0 < b.z1 - eps &&
    a.z1 > b.z0 + eps
  );
}

/** World-space bounds of a prop (conservative for any yaw). */
export function propBox(prop: PropSpawn): Box {
  const h = PROP_SPECS[prop.kind].halfExtents;
  const c = Math.abs(Math.cos(prop.yaw));
  const s = Math.abs(Math.sin(prop.yaw));
  const ex = c * h.x + s * h.z;
  const ez = s * h.x + c * h.z;
  const p = prop.position;
  return {
    x0: p.x - ex,
    x1: p.x + ex,
    y0: p.y - h.y,
    y1: p.y + h.y,
    z0: p.z - ez,
    z1: p.z + ez,
  };
}

export function containsPoint(
  b: Box,
  x: number,
  y: number,
  z: number,
): boolean {
  return (
    x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && z >= b.z0 && z <= b.z1
  );
}

/**
 * Segment (origin to origin + dir * maxT) against a box using the slab test.
 * A segment that starts inside the box is not counted as blocked, since it
 * cannot see out of the geometry it is embedded in anyway.
 */
export function segmentHitsBox(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxT: number,
  b: Box,
): boolean {
  let tmin = 0;
  let tmax = maxT;
  let inside = true;
  if (Math.abs(dx) < 1e-12) {
    if (ox < b.x0 || ox > b.x1) return false;
  } else {
    const inv = 1 / dx;
    let t0 = (b.x0 - ox) * inv;
    let t1 = (b.x1 - ox) * inv;
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > 0) inside = false;
    if (t0 > tmin) tmin = t0;
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return false;
  }
  if (Math.abs(dy) < 1e-12) {
    if (oy < b.y0 || oy > b.y1) return false;
  } else {
    const inv = 1 / dy;
    let t0 = (b.y0 - oy) * inv;
    let t1 = (b.y1 - oy) * inv;
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > 0) inside = false;
    if (t0 > tmin) tmin = t0;
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return false;
  }
  if (Math.abs(dz) < 1e-12) {
    if (oz < b.z0 || oz > b.z1) return false;
  } else {
    const inv = 1 / dz;
    let t0 = (b.z0 - oz) * inv;
    let t1 = (b.z1 - oz) * inv;
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > 0) inside = false;
    if (t0 > tmin) tmin = t0;
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return false;
  }
  return !inside;
}
