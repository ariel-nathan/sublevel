/**
 * Pure maths behind the pilot: angles, look deltas and route planning.
 * Conventions match the game: yaw 0 looks along -Z and positive yaw turns
 * left; positive pitch looks up; a positive mouse dx turns right (yaw down)
 * and a positive dy looks down (pitch down).
 */

/** Radians of turn per pixel of mouse movement (src/player/tuning.ts). */
export const LOOK_SENSITIVITY = 0.0022;
/** Largest pitch the player allows, in degrees. */
export const MAX_PITCH_DEG = 89;
/** Horizontal metres covered in one 1/60 s step at full run speed. */
export const RUN_STEP = 5.6 / 60;

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface Point2 {
  x: number;
  z: number;
}

export interface Look {
  yawDeg: number;
  pitchDeg: number;
}

const DEG = Math.PI / 180;

/** Wraps an angle in degrees into (-180, 180]. */
export function wrapDeg(angle: number): number {
  let a = angle % 360;
  if (a > 180) {
    a -= 360;
  } else if (a <= -180) {
    a += 360;
  }
  return a;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The look direction that points from `eye` at `target`. */
export function lookToward(eye: Point3, target: Point3): Look {
  const dx = target.x - eye.x;
  const dy = target.y - eye.y;
  const dz = target.z - eye.z;
  const flat = Math.hypot(dx, dz);
  return {
    yawDeg: flat < 1e-9 ? 0 : Math.atan2(-dx, -dz) / DEG,
    pitchDeg: clamp(Math.atan2(dy, flat) / DEG, -MAX_PITCH_DEG, MAX_PITCH_DEG),
  };
}

/**
 * Mouse movement in pixels that turns the view from `current` to `target`,
 * taking the short way round in yaw.
 */
export function lookDelta(
  current: Look,
  target: Look,
): { dx: number; dy: number } {
  const dyaw = wrapDeg(target.yawDeg - current.yawDeg) * DEG;
  const dpitch =
    (clamp(target.pitchDeg, -MAX_PITCH_DEG, MAX_PITCH_DEG) - current.pitchDeg) *
    DEG;
  return {
    dx: -dyaw / LOOK_SENSITIVITY,
    dy: -dpitch / LOOK_SENSITIVITY,
  };
}

/** Largest remaining angle (degrees) between two looks. */
export function lookError(a: Look, b: Look): number {
  return Math.max(
    Math.abs(wrapDeg(a.yawDeg - b.yawDeg)),
    Math.abs(a.pitchDeg - b.pitchDeg),
  );
}

/** Unit forward and right vectors of a view direction. */
export function viewBasis(look: Look): { forward: Point3; right: Point3 } {
  const yaw = look.yawDeg * DEG;
  const pitch = look.pitchDeg * DEG;
  return {
    forward: {
      x: -Math.sin(yaw) * Math.cos(pitch),
      y: Math.sin(pitch),
      z: -Math.cos(yaw) * Math.cos(pitch),
    },
    right: { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) },
  };
}

export function horizontalDistance(a: Point2, b: Point2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * How many steps to hold forward before re-aiming: as many as are safe
 * without overshooting `tolerance` at run speed, between 1 and `max`.
 */
export function batchSteps(
  distance: number,
  tolerance: number,
  max = 6,
): number {
  const room = distance - tolerance * 0.6;
  return clamp(Math.floor(room / RUN_STEP), 1, max);
}

/** Forward input that eases off near the target. */
export function forwardInput(distance: number): number {
  return clamp(distance / 1.2, 0.3, 1);
}

/** Point `standOff` metres from `target` on the side facing `from`. */
export function standPoint(
  target: Point2,
  from: Point2,
  standOff: number,
): Point2 {
  const dx = from.x - target.x;
  const dz = from.z - target.z;
  const length = Math.hypot(dx, dz);
  if (length < 1e-9) {
    return { x: target.x - standOff, z: target.z };
  }
  return {
    x: target.x + (dx / length) * standOff,
    z: target.z + (dz / length) * standOff,
  };
}

// --- Routes through the level --------------------------------------------------
// The level is a chain: lab, door A, corridor, bend, corridor south, storage.
// Walking straight between rooms would hit walls, so routes follow this spine.

export interface Waypoint extends Point2 {
  name: string;
}

export const SPINE: readonly Waypoint[] = [
  { name: "lab", x: 3, z: 0 },
  { name: "door_a", x: 4.15, z: 0 },
  { name: "corridor", x: 6.5, z: 0 },
  { name: "bend", x: 9.55, z: 0 },
  { name: "corridor_south", x: 9.55, z: 6.5 },
  { name: "storage_door", x: 9.55, z: 8.6 },
];

/** Index into SPINE of the zone a position belongs to. */
export function zoneOf(p: Point2): number {
  if (p.x < 4) {
    return 0;
  }
  if (p.z >= 8) {
    return 5;
  }
  if (p.x < 4.3) {
    return 1;
  }
  if (p.x < 8.3) {
    return 2;
  }
  return p.z < 1.25 ? 3 : 4;
}

/**
 * Intermediate points to walk through from `from` to `to`. Within one zone
 * this is empty (walk straight). Going forward it ends at the destination
 * zone's anchor; going back it starts at the source zone's anchor.
 */
export function routeBetween(from: Point2, to: Point2): Waypoint[] {
  const a = zoneOf(from);
  const b = zoneOf(to);
  if (a === b) {
    return [];
  }
  return a < b
    ? SPINE.slice(a + 1, b + 1)
    : SPINE.slice(b + 1, a + 1).reverse();
}
