/**
 * Every number that shapes how the player moves, looks and carries things.
 * Metres, seconds, kilograms, radians.
 */
import { PLAYER } from "../core/props";

// --- Movement (Quake/GoldSrc model) ----------------------------------------

export const RUN_SPEED = 5.6;
export const CROUCH_SPEED = 2.4;
/** Ground acceleration, in multiples of the wish speed per second. */
export const GROUND_ACCEL = 10;
export const AIR_ACCEL = 10;
/** Wish speed cap in the air: small, so turning while strafing curves the path. */
export const AIR_SPEED_CAP = 0.76;
export const FRICTION = 6;
/** Below this speed friction acts as if moving this fast: crisp final stop. */
export const STOP_SPEED = 2.5;
/** The player's own gravity, heavier than the props' for a tight jump. */
export const GRAVITY = 20;
/** Feet rise exactly PLAYER.jumpHeight at the apex. */
export const JUMP_VELOCITY = Math.sqrt(2 * GRAVITY * PLAYER.jumpHeight);
export const MAX_FALL_SPEED = 30;

// --- Riding moving ground ------------------------------------------------------

/**
 * Dynamic bodies lighter than this are not ridden: under the player's 80 kg
 * their motion is mostly a reaction to the player standing on them, and
 * carrying the player along with it would feed that back.
 */
export const RIDE_MIN_MASS = 12;
/**
 * Dynamic ground slower than this counts as still, so the slight give of a
 * loaded crate never makes the player creep.
 */
export const RIDE_DEADBAND = 0.05;
/** Ground velocity taken from dynamic bodies is clamped to this speed. */
export const RIDE_MAX_SPEED = 10;

// --- Look and camera ---------------------------------------------------------

/** Radians of turn per pixel of mouse movement. */
export const LOOK_SENSITIVITY = 0.0022;
export const MAX_PITCH = (89 * Math.PI) / 180;
export const FOV_Y = (74 * Math.PI) / 180;
export const NEAR = 0.05;
export const FAR = 80;
export const STAND_EYE_HEIGHT = PLAYER.eyeHeight;
export const CROUCH_EYE_HEIGHT = PLAYER.crouchHeight - 0.15;
/** Time constant of the eye-height change when crouching (settles in ~0.12 s). */
export const EYE_SMOOTH_TIME = 0.04;
/** Time constant of the eye catching up after an auto-step. */
export const STEP_SMOOTH_TIME = 0.05;
/** Feet height changes per step larger than this while grounded are smoothed. */
export const STEP_SMOOTH_MIN = 0.02;
/** Downward eye velocity given per m/s of landing speed. */
export const LAND_DIP_PER_SPEED = 0.25;
/** Angular frequency of the critically damped landing-dip spring. */
export const LAND_DIP_STIFFNESS = 14;
/** Peak-to-trough height of the view bob at run speed; 0 turns it off. */
export const VIEW_BOB = 0.012;

// --- Events ------------------------------------------------------------------

export const FOOTSTEP_STRIDE = 2.2;
export const CROUCH_STRIDE = 1.4;
/** No footsteps below this horizontal speed. */
export const FOOTSTEP_MIN_SPEED = 0.8;
/** Landing faster than this (downward) emits a `land` event. */
export const LAND_EVENT_SPEED = 2.5;

// --- Carrying ------------------------------------------------------------------

/** Minimum distance from the eye to the centre of a held prop. */
export const HOLD_DISTANCE = 1.15;
/** Gap kept between the eye and the nearest point of a held prop. */
export const HOLD_CLEARANCE = 0.55;
/** How far below the line of sight the prop is carried. */
export const HOLD_LOWER = 0.15;
/** Closest a held prop is pulled in when a wall is in the way. */
export const HOLD_MIN_DISTANCE = 0.3;
export const HOLD_WALL_MARGIN = 0.03;
/** Position gain (1/s) and speed limit for the lightest props. */
export const HOLD_GAIN = 14;
export const HOLD_MAX_SPEED = 12;
/** Orientation gain (1/s) and angular speed limit for the lightest props. */
export const HOLD_ANGULAR_GAIN = 8;
export const HOLD_MAX_ANGULAR = 8;
/** Dropped automatically when farther than this from the hold point ... */
export const HOLD_STUCK_DISTANCE = 1.2;
/** ... for longer than this. */
export const HOLD_STUCK_TIME = 0.25;
/** Speed limit of a prop that is let go of. */
export const DROP_MAX_SPEED = 5;
export const THROW_SPEED_LIGHT = 11;
export const THROW_SPEED_HEAVY = 5;
export const THROW_LIGHT_MASS = 8;
export const THROW_UP = 1.0;
/** Forward tumble given to a thrown prop, rad/s. */
export const THROW_SPIN = 3;
export const SHOVE_IMPULSE = 90;
/** A shove never changes a body's speed by more than this. */
export const SHOVE_MAX_DELTA_V = 8;

/** 1 for light props, falling to 0.4 at the carry limit: heavier props lag more. */
export function carryLightness(mass: number): number {
  const t = (mass - 5) / (PLAYER.maxCarryMass - 5);
  return Math.min(1, Math.max(0.4, 1 - 0.6 * t));
}

/** Throw speed for a prop of this mass. */
export function throwSpeed(mass: number): number {
  const t =
    (mass - THROW_LIGHT_MASS) / (PLAYER.maxCarryMass - THROW_LIGHT_MASS);
  const k = Math.min(1, Math.max(0, t));
  return THROW_SPEED_LIGHT + (THROW_SPEED_HEAVY - THROW_SPEED_LIGHT) * k;
}
