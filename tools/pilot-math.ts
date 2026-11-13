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
// The level is a chain: lab, door A, corridor, bend, corridor south, storage,
// door B into the filtration hall, round the grate screen into the service
// lane, door T into the valve chamber, the exit door into the egress lock.
// Walking straight between rooms would hit walls, so routes follow this spine.

export interface Waypoint extends Point2 {
  name: string;
}

/** A zone's anchor, and the points to pass on the way in from the zone before. */
export interface SpinePoint extends Waypoint {
  via?: readonly Waypoint[];
}

export const SPINE: readonly SpinePoint[] = [
  { name: "lab", x: 3, z: 0 },
  { name: "door_a", x: 4.15, z: 0 },
  { name: "corridor", x: 6.5, z: 0 },
  { name: "bend", x: 9.55, z: 0 },
  { name: "corridor_south", x: 9.55, z: 6.5 },
  { name: "storage_door", x: 9.55, z: 8.6 },
  {
    name: "hall",
    x: 14.6,
    z: 12,
    via: [{ name: "door_b_approach", x: 12.9, z: 12 }],
  },
  {
    name: "lane",
    x: 14.85,
    z: 10.2,
    via: [{ name: "screen_end", x: 14.85, z: 11.75 }],
  },
  {
    name: "chamber",
    x: 26.3,
    z: 9.6,
    via: [{ name: "door_t_approach", x: 24.4, z: 9.6 }],
  },
  {
    name: "lock",
    x: 32.3,
    z: 9.8,
    via: [{ name: "exit_door_approach", x: 30.6, z: 9.8 }],
  },
];

/** Index into SPINE of the zone a position belongs to. */
export function zoneOf(p: Point2): number {
  if (p.x >= 31.55) {
    return 9;
  }
  if (p.x >= 25.25) {
    return 8;
  }
  if (p.x >= 13.65) {
    return p.z < 10.95 ? 7 : 6;
  }
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
 * this is empty (walk straight). Going forward it passes each next zone's
 * `via` points and anchor; going back it retraces them in reverse.
 */
export function routeBetween(from: Point2, to: Point2): Waypoint[] {
  const a = zoneOf(from);
  const b = zoneOf(to);
  const out: Waypoint[] = [];
  const strip = (p: SpinePoint): Waypoint => ({
    name: p.name,
    x: p.x,
    z: p.z,
  });
  if (a < b) {
    for (let k = a + 1; k <= b; k++) {
      out.push(...(SPINE[k].via ?? []), strip(SPINE[k]));
    }
  } else {
    for (let k = a; k > b; k--) {
      out.push(strip(SPINE[k]), ...[...(SPINE[k].via ?? [])].reverse());
    }
  }
  return out;
}

// --- Throwing ------------------------------------------------------------------

/**
 * Pitch (degrees) at which to throw so that a prop released at height 0
 * passes through a point `distance` metres away horizontally and `rise`
 * metres up, flying at `speed` along the view plus `up` m/s straight up,
 * under gravity `g`. The flatter of the two arcs; null if out of range.
 */
export function throwPitch(
  distance: number,
  rise: number,
  speed: number,
  up: number,
  g = 9.81,
): number | null {
  const heightAt = (deg: number): number => {
    const a = deg * DEG;
    const vx = speed * Math.cos(a);
    const vy = speed * Math.sin(a) + up;
    const t = distance / vx;
    return vy * t - (g * t * t) / 2;
  };
  // Height at the target rises with pitch up to the highest arc, then falls.
  let lo = -60;
  let hi = -60;
  let best = heightAt(hi);
  for (let deg = -60; deg <= 80; deg += 0.5) {
    const h = heightAt(deg);
    if (h > best) {
      best = h;
      hi = deg;
    }
  }
  if (best < rise || heightAt(lo) > rise) {
    return null;
  }
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (heightAt(mid) < rise) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

/**
 * Where a held prop hangs: `distance` metres (eye to centre) along the view
 * (yaw and pitch in degrees), HOLD_LOWER below the line of sight
 * (src/player/tuning.ts).
 */
export function holdPoint(
  eye: Point3,
  look: Look,
  distance: number,
  lower = 0.15,
): Point3 {
  const { forward } = viewBasis(look);
  return {
    x: eye.x + forward.x * distance,
    y: eye.y + forward.y * distance - lower,
    z: eye.z + forward.z * distance,
  };
}

export interface ThrowPlan {
  look: Look;
  /** Where the prop hangs (and so is released) with that look. */
  release: Point3;
}

/**
 * The view to throw with from `eye` so that a prop of `speed` hanging
 * `holdDistance` ahead passes through `target`: the pitch moves the hold
 * point, which moves the arc, so it is iterated to a fixed point. `lift`
 * aims that far above the target. Null if the target is out of range.
 */
export function planThrow(
  eye: Point3,
  target: Point3,
  speed: number,
  holdDistance: number,
  lift = 0,
  up = 1.0,
): ThrowPlan | null {
  const yawDeg = lookToward(eye, { x: target.x, y: eye.y, z: target.z }).yawDeg;
  let pitchDeg = 20;
  let release = holdPoint(eye, { yawDeg, pitchDeg }, holdDistance);
  for (let i = 0; i < 30; i++) {
    const solved = throwPitch(
      horizontalDistance(release, target),
      target.y + lift - release.y,
      speed,
      up,
    );
    if (solved === null) {
      return null;
    }
    const moved = Math.abs(solved - pitchDeg);
    pitchDeg = solved;
    release = holdPoint(eye, { yawDeg, pitchDeg }, holdDistance);
    if (moved < 1e-4) {
      break;
    }
  }
  return { look: { yawDeg, pitchDeg }, release };
}
