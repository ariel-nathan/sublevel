/**
 * Animation clips written in code: each is a function from time to joint
 * angles. The animator samples them at a deliberately low rate (see
 * animator.ts) for the stiff motion of the era.
 *
 * Angles are [x, y, z] in radians in the bone's parent axes (see
 * skeleton.ts): +x swings a limb forward and bends an elbow, -x bends a knee
 * and bends the trunk forward, +y turns left, +z rolls towards the
 * character's left... except on limbs, where +z on the right side and -z on
 * the left side lift the limb out sideways. Limbs (arms, hands, legs, feet)
 * compose twist (y) first, then swing (x), then spread (z); the trunk, neck
 * and head compose roll (z) first, then pitch (x), then yaw (y).
 */
import { quat, type Quat } from "../math";
import { createRng } from "../core/rng";
import {
  BONE,
  BONE_COUNT,
  BONE_NAMES,
  type BodyMetrics,
  type BoneName,
} from "./skeleton";

export type Angles = Partial<Record<BoneName, [number, number, number]>>;

/** Per-character habits that colour every clip a little. */
export interface Habits {
  /** Forward slouch of the chest (radians). */
  slouch: number;
  /** Habitual head tilt (roll, radians). */
  tilt: number;
  /** Extra outward angle of the hanging arms. */
  splay: number;
  /** Multiplies the time between idle fidgets. */
  tempo: number;
  /** Elbow bend at rest. */
  elbow: number;
}

export function habitsFor(seed: number, build: number): Habits {
  const rng = createRng((seed * 31 + 0xab1e) >>> 0);
  return {
    slouch: rng.range(-0.03, 0.09),
    tilt: rng.range(-0.06, 0.06),
    splay: rng.range(0, 0.06) + build * 0.03,
    tempo: rng.range(0.88, 1.12),
    elbow: rng.range(0.08, 0.22),
  };
}

export interface ClipContext {
  metrics: BodyMetrics;
  habits: Habits;
}

export const CLIP_NAMES = [
  "idle",
  "look_around",
  "check_watch",
  "scratch_head",
  "arms_folded",
  "hands_on_hips",
  "stretch",
  "walk",
  "scurry",
  "turn_in_place",
  "talk_open",
  "talk_point",
  "talk_shrug",
  "flinch",
  "cower",
  "type",
] as const;
export type ClipName = (typeof CLIP_NAMES)[number];

/** Idle fidgets the automatic idle picks from. */
export const FIDGETS: readonly ClipName[] = [
  "look_around",
  "check_watch",
  "scratch_head",
  "arms_folded",
  "hands_on_hips",
  "stretch",
];

export interface Clip {
  name: ClipName;
  /** Seconds. */
  duration: number;
  loop: boolean;
  angles(t: number, ctx: ClipContext): Angles;
  /**
   * Whether the feet are set flat on the floor after the clip's own foot
   * angles (most standing clips). Walking clips animate the feet themselves.
   */
  flatFeet: boolean;
}

// --- Helpers --------------------------------------------------------------

const TAU = Math.PI * 2;
const smooth = (t: number): number => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};

/** Eased keyframes: [time, value] pairs, sorted by time. */
export function keys(
  t: number,
  frames: readonly (readonly [number, number])[],
): number {
  if (t <= frames[0][0]) return frames[0][1];
  for (let i = 0; i + 1 < frames.length; i++) {
    const [t0, v0] = frames[i];
    const [t1, v1] = frames[i + 1];
    if (t <= t1) {
      return v0 + (v1 - v0) * smooth((t - t0) / (t1 - t0));
    }
  }
  return frames[frames.length - 1][1];
}

/** 0 before a, up to 1 by b, held to c, back to 0 by d (eased). */
export function envelope(
  t: number,
  a: number,
  b: number,
  c: number,
  d: number,
): number {
  if (t <= a || t >= d) return 0;
  if (t < b) return smooth((t - a) / (b - a));
  if (t <= c) return 1;
  return 1 - smooth((t - c) / (d - c));
}

function addAngles(base: Angles, extra: Angles, weight = 1): Angles {
  const out: Angles = { ...base };
  for (const name of Object.keys(extra) as BoneName[]) {
    const a = out[name] ?? [0, 0, 0];
    const b = extra[name] as [number, number, number];
    out[name] = [
      a[0] + b[0] * weight,
      a[1] + b[1] * weight,
      a[2] + b[2] * weight,
    ];
  }
  return out;
}

/** The neutral standing pose of a person: arms hanging clear of the hips. */
function stand(ctx: ClipContext): Angles {
  const h = ctx.habits;
  const splay = ctx.metrics.armSplay + h.splay;
  return {
    spine: [h.slouch * 0.4, 0, 0],
    chest: [-h.slouch, 0, 0],
    neck: [h.slouch * 0.6, 0, 0],
    head: [h.slouch * 0.5, 0, h.tilt],
    clavicle_l: [0, 0, 0],
    clavicle_r: [0, 0, 0],
    upperarm_l: [0.04, -0.1, -splay],
    upperarm_r: [0.04, 0.1, splay],
    forearm_l: [h.elbow, 0, 0],
    forearm_r: [h.elbow, 0, 0],
    hand_l: [0.05, 0, 0.04],
    hand_r: [0.05, 0, -0.04],
    thigh_l: [0, 0, -0.025],
    thigh_r: [0, 0, 0.025],
    shin_l: [-0.03, 0, 0],
    shin_r: [-0.03, 0, 0],
  };
}

/** A fidget layered on the standing pose and faded in and out at its ends. */
function fidget(
  name: ClipName,
  duration: number,
  delta: (t: number, ctx: ClipContext) => Angles,
): Clip {
  return {
    name,
    duration,
    loop: false,
    flatFeet: true,
    angles: (t, ctx) => addAngles(idleAngles(t, ctx, 0.5), delta(t, ctx)),
  };
}

/**
 * Breathing (two breaths per cycle) and a slow weight shift from one leg to
 * the other and back (once per cycle). `cycle` must divide the duration of
 * a looping clip that uses it.
 */
function idleAngles(
  t: number,
  ctx: ClipContext,
  amount = 1,
  cycle = 6,
): Angles {
  const breath = Math.sin((TAU * t * 2) / cycle) * amount;
  const shift = Math.sin((TAU * t) / cycle) * amount;
  const drift = Math.sin((TAU * t) / cycle + 1.3) * amount;
  const roll = 0.035 * shift;
  const base = stand(ctx);
  return addAngles(base, {
    pelvis: [0, 0.03 * drift, roll],
    spine: [0.012 * breath, 0, -roll * 0.6],
    chest: [0.018 * breath, 0.02 * drift, -roll * 0.4],
    clavicle_l: [0, 0, -0.012 * breath],
    clavicle_r: [0, 0, 0.012 * breath],
    head: [-0.01 * breath, 0.06 * drift, 0],
    thigh_l: [0.02 * Math.max(0, shift), 0, -roll],
    thigh_r: [0.02 * Math.max(0, -shift), 0, -roll],
    // The unweighted leg relaxes: its knee bends a little.
    shin_l: [-0.1 * Math.max(0, shift), 0, 0],
    shin_r: [-0.1 * Math.max(0, -shift), 0, 0],
    upperarm_l: [0.015 * breath, 0, 0],
    upperarm_r: [0.015 * breath, 0, 0],
  });
}

// --- Walking ---------------------------------------------------------------

export interface GaitParams {
  /** Seconds per full cycle (two steps). */
  period: number;
  /** Thigh swing amplitude (radians). */
  swing: number;
  /** Peak knee bend in swing and in stance (radians, positive). */
  kneeSwing: number;
  kneeStance: number;
  arms: number;
  elbow: number;
  lean: number;
}

export const WALK: GaitParams = {
  period: 1.1,
  swing: 0.42,
  kneeSwing: 1.05,
  kneeStance: 0.16,
  arms: 0.32,
  elbow: 0.28,
  lean: -0.04,
};

export const SCURRY: GaitParams = {
  period: 0.62,
  swing: 0.46,
  kneeSwing: 1.35,
  kneeStance: 0.4,
  arms: 0.5,
  elbow: 1.25,
  lean: -0.2,
};

/** Rate at which movement code should turn a character playing turn_in_place (rad/s). */
export const TURN_RATE = 2.2;

/** Absolute foot pitch over one leg's cycle: heel strike at 0, toe-off at ~0.55. */
const FOOT_PITCH: readonly (readonly [number, number])[] = [
  [0, 0.22],
  [0.08, 0.0],
  [0.22, 0.0],
  [0.38, -0.24],
  [0.5, -0.42],
  [0.62, -0.55],
  [0.74, -0.1],
  [0.88, 0.1],
  [1, 0.22],
];

function legCycle(
  p: number,
  g: GaitParams,
): { thigh: number; knee: number; foot: number } {
  const q = ((p % 1) + 1) % 1;
  // The swinging thigh lifts a little extra (foot clearance), then drops
  // back onto the heel strike.
  const lift = q > 0.5 ? 0.2 * Math.sin(Math.PI * ((q - 0.5) / 0.5)) : 0;
  const thigh = g.swing * Math.cos(TAU * q) + 0.04 + lift;
  // Knee: a give after heel strike, bending again before toe-off, most
  // bent early in the swing and straight again for the next heel strike.
  const a = g.kneeStance;
  const b = g.kneeSwing;
  const knee = keys(q, [
    [0, 0],
    [0.12, -a],
    [0.3, -0.3 * a],
    [0.45, -0.3 * b],
    [0.6, -0.72 * b],
    [0.72, -b],
    [0.84, -0.78 * b],
    [0.94, -0.28 * b],
    [1, 0],
  ]);
  const footAbs = keys(q, FOOT_PITCH);
  return { thigh, knee, foot: footAbs - thigh - knee };
}

function gaitClip(name: ClipName, g: GaitParams): Clip {
  return {
    name,
    duration: g.period,
    loop: true,
    flatFeet: false,
    angles: (t, ctx) => {
      const p = t / g.period;
      const c = Math.cos(TAU * p);
      const left = legCycle(p, g);
      const right = legCycle(p + 0.5, g);
      const roll = -0.04 * Math.sin(TAU * p);
      const splay = ctx.metrics.armSplay * 0.7 + ctx.habits.splay;
      // The forward arm bends more.
      const elbowL = g.elbow + 0.18 * Math.max(0, -c);
      const elbowR = g.elbow + 0.18 * Math.max(0, c);
      const bounce = Math.abs(Math.sin(TAU * p));
      // Lean from the hips; the thighs are counter-rotated so the stride
      // stays centred under the body.
      const lean = g.lean * 0.7;
      return {
        pelvis: [lean, -0.09 * c, roll],
        spine: [g.lean * 0.15, 0.04 * c, -roll * 0.5],
        chest: [g.lean * 0.15 - ctx.habits.slouch * 0.5, 0.09 * c, -roll * 0.5],
        neck: [-g.lean * 0.4, -0.04 * c, 0],
        head: [-g.lean * 0.4 + 0.02 * bounce, -0.05 * c, ctx.habits.tilt * 0.5],
        thigh_l: [left.thigh - lean, 0, -roll - 0.02],
        thigh_r: [right.thigh - lean, 0, -roll + 0.02],
        shin_l: [left.knee, 0, 0],
        shin_r: [right.knee, 0, 0],
        foot_l: [left.foot, 0, 0],
        foot_r: [right.foot, 0, 0],
        upperarm_l: [-g.arms * c + 0.05, -0.1, -splay],
        upperarm_r: [g.arms * c + 0.05, 0.1, splay],
        forearm_l: [elbowL, 0, 0],
        forearm_r: [elbowR, 0, 0],
        hand_l: [0.1, 0, 0.05],
        hand_r: [0.1, 0, -0.05],
      };
    },
  };
}

// --- Clip table --------------------------------------------------------------

/** A shiver that repeats every 2 s (so the cower loop is seamless). */
const tremble = (t: number, k: number): number =>
  Math.sin(TAU * t * 8.5 + k) * 0.6 + Math.sin(TAU * t * 5 + k * 2.1) * 0.4;

/** The crouch with the arms over the head (shared by flinch and cower). */
function cowerAngles(
  ctx: ClipContext,
  t: number,
  amount: number,
  shake: number,
): Angles {
  const s = shake * 0.025;
  return {
    // Bent forward mostly at the hips, so the waist seam stays closed.
    pelvis: [-0.26, 0, 0],
    spine: [-0.05, 0, 0],
    chest: [-0.18 - s * tremble(t, 1), 0, 0],
    neck: [-0.2, 0, 0],
    head: [-0.3 + s * tremble(t, 2), 0.1, 0],
    thigh_l: [(0.85 + 0.26) * amount, 0, -0.12],
    thigh_r: [(0.85 + 0.26) * amount, 0, 0.12],
    shin_l: [-1.45 * amount, 0, 0],
    shin_r: [-1.45 * amount, 0, 0],
    clavicle_l: [0, 0, -0.03],
    clavicle_r: [0, 0, 0.03],
    // Elbows out and up, forearms folded over the top of the head.
    upperarm_l: [0.3 + s * tremble(t, 3), 1.5, -1.75],
    upperarm_r: [0.3 + s * tremble(t, 4), -1.5, 1.75],
    forearm_l: [2.4, 0, 0],
    forearm_r: [2.4, 0, 0],
    hand_l: [0.3, 0, 0],
    hand_r: [0.3, 0, 0],
  };
}

function blendAngles(a: Angles, b: Angles, w: number): Angles {
  const out: Angles = {};
  for (const name of BONE_NAMES) {
    const x = a[name] ?? [0, 0, 0];
    const y = b[name] ?? [0, 0, 0];
    if (a[name] || b[name]) {
      out[name] = [
        x[0] + (y[0] - x[0]) * w,
        x[1] + (y[1] - x[1]) * w,
        x[2] + (y[2] - x[2]) * w,
      ];
    }
  }
  return out;
}

const CLIPS: Clip[] = [
  {
    name: "idle",
    duration: 6,
    loop: true,
    flatFeet: true,
    angles: (t, ctx) => idleAngles(t, ctx),
  },
  fidget("look_around", 3.8, (t) => {
    const yaw = keys(t, [
      [0, 0],
      [0.5, 0],
      [1.1, 0.62],
      [1.7, 0.62],
      [2.3, -0.58],
      [2.9, -0.58],
      [3.6, 0],
    ]);
    const pitch = keys(t, [
      [0, 0],
      [1.1, 0.06],
      [2.3, -0.04],
      [3.6, 0],
    ]);
    return {
      chest: [0, yaw * 0.18, 0],
      neck: [pitch * 0.4, yaw * 0.32, 0],
      head: [pitch * 0.6, yaw * 0.5, 0],
    };
  }),
  fidget("check_watch", 3.6, (t) => {
    const e = envelope(t, 0.15, 0.85, 2.6, 3.4);
    const look = envelope(t, 0.45, 1.0, 2.5, 3.2);
    return {
      upperarm_l: [0.5 * e, -0.95 * e, 0.12 * e],
      forearm_l: [1.85 * e, 0, 0],
      hand_l: [0.1 * e, -1.1 * e, 0],
      chest: [0, 0.08 * e, 0],
      neck: [-0.15 * look, 0.12 * look, 0],
      head: [-0.32 * look, 0.28 * look, -0.05 * look],
    };
  }),
  fidget("scratch_head", 3.0, (t, ctx) => {
    const e = envelope(t, 0.1, 0.75, 2.1, 2.9);
    const scratch = t > 0.75 && t < 2.1 ? Math.sin(t * 34) * 0.14 : 0;
    const splay = ctx.metrics.armSplay;
    return {
      upperarm_r: [0.1 * e, -1.6 * e, (1.8 - splay) * e],
      forearm_r: [(2.25 + scratch) * e, 0, 0],
      hand_r: [0.3 * e, 0, 0],
      clavicle_r: [0, 0, 0.03 * e],
      head: [-0.1 * e, 0, -0.16 * e],
      neck: [0, -0.06 * e, -0.05 * e],
    };
  }),
  fidget("arms_folded", 5.0, (t) => {
    const e = envelope(t, 0.1, 0.8, 4.1, 4.9);
    return {
      upperarm_l: [0.42 * e, -1.05 * e, 0.06 * e],
      upperarm_r: [0.38 * e, 1.05 * e, -0.06 * e],
      forearm_l: [1.95 * e, 0, 0],
      forearm_r: [1.85 * e, 0, 0],
      hand_l: [0, 0, 0.2 * e],
      hand_r: [0, 0, -0.2 * e],
      chest: [0.03 * e, 0, 0],
      head: [0.04 * e, 0.12 * envelope(t, 1.5, 2.2, 3.2, 3.9), 0],
    };
  }),
  fidget("hands_on_hips", 4.6, (t, ctx) => {
    const e = envelope(t, 0.1, 0.8, 3.8, 4.5);
    const splay = ctx.metrics.armSplay;
    return {
      upperarm_l: [-0.22 * e, -1.25 * e, -(0.72 - splay) * e],
      upperarm_r: [-0.22 * e, 1.25 * e, (0.72 - splay) * e],
      forearm_l: [1.75 * e, 0, 0],
      forearm_r: [1.75 * e, 0, 0],
      hand_l: [0, -0.4 * e, 0.3 * e],
      hand_r: [0, 0.4 * e, -0.3 * e],
      chest: [0.05 * e, 0, 0],
      head: [0.03 * e, -0.15 * envelope(t, 1.2, 1.8, 2.8, 3.4), 0],
    };
  }),
  fidget("stretch", 3.4, (t, ctx) => {
    const e = envelope(t, 0.1, 1.0, 2.0, 3.2);
    const splay = ctx.metrics.armSplay;
    return {
      upperarm_l: [2.55 * e, -0.2 * e, (-0.25 + splay) * e],
      upperarm_r: [2.55 * e, 0.2 * e, (0.25 - splay) * e],
      forearm_l: [0.55 * e, 0, 0],
      forearm_r: [0.55 * e, 0, 0],
      spine: [0.08 * e, 0, 0],
      chest: [0.14 * e, 0, 0],
      neck: [0.1 * e, 0, 0],
      head: [0.18 * e, 0, 0],
      jaw: [-0.28 * envelope(t, 0.6, 1.1, 1.9, 2.4), 0, 0],
    };
  }),
  gaitClip("walk", WALK),
  gaitClip("scurry", SCURRY),
  {
    name: "turn_in_place",
    duration: 0.9,
    loop: true,
    flatFeet: false,
    angles: (t, ctx) => {
      const p = t / 0.9;
      const stepL = Math.max(0, Math.sin(TAU * p));
      const stepR = Math.max(0, -Math.sin(TAU * p));
      const base = stand(ctx);
      return addAngles(base, {
        pelvis: [0, 0.1 * (stepL - stepR), 0.03 * (stepR - stepL)],
        chest: [0, 0.05 * (stepL - stepR), 0],
        head: [0, 0.12, 0],
        thigh_l: [0.4 * stepL, 0.15 * stepL, 0],
        thigh_r: [0.4 * stepR, 0.15 * stepR, 0],
        shin_l: [-0.75 * stepL, 0, 0],
        shin_r: [-0.75 * stepR, 0, 0],
        foot_l: [0.35 * stepL - 0.05, 0, 0],
        foot_r: [0.35 * stepR - 0.05, 0, 0],
        upperarm_l: [0.12 * stepR, 0, -0.05],
        upperarm_r: [0.12 * stepL, 0, 0.05],
        forearm_l: [0.15, 0, 0],
        forearm_r: [0.15, 0, 0],
      });
    },
  },
  {
    name: "talk_open",
    duration: 4.8,
    loop: true,
    flatFeet: true,
    angles: (t, ctx) => {
      const beat = Math.sin((TAU * t) / 1.2);
      const nod = Math.sin((TAU * t) / 0.6) * 0.5 + 0.5;
      return addAngles(idleAngles(t, ctx, 0.4, 4.8), {
        upperarm_r: [0.3 + 0.08 * beat, 0.55, -0.1],
        forearm_r: [1.25 + 0.2 * beat, 0, 0],
        hand_r: [0.2, 1.1, -0.2],
        upperarm_l: [0.12 + 0.05 * beat, -0.3, 0],
        forearm_l: [0.55 + 0.12 * beat, 0, 0],
        hand_l: [0.1, -0.6, 0.1],
        head: [-0.05 * nod, 0.08 * beat, 0],
        chest: [0, -0.04 * beat, 0],
      });
    },
  },
  {
    name: "talk_point",
    duration: 4.8,
    loop: true,
    flatFeet: true,
    angles: (t, ctx) => {
      const jab = Math.max(0, Math.sin((TAU * t) / 0.8)) ** 3;
      return addAngles(idleAngles(t, ctx, 0.4, 4.8), {
        upperarm_r: [1.15 + 0.12 * jab, 0.25, -0.22],
        forearm_r: [0.45 - 0.2 * jab, 0, 0],
        hand_r: [0.1, 0.5, 0],
        chest: [-0.03 * jab, -0.12, 0],
        head: [-0.06 * jab, 0.1, 0],
        upperarm_l: [0.06, 0, 0],
      });
    },
  },
  {
    name: "talk_shrug",
    duration: 4.8,
    loop: true,
    flatFeet: true,
    angles: (t, ctx) => {
      const shrug = envelope(t % 1.2, 0.05, 0.35, 0.65, 1.05);
      return addAngles(idleAngles(t, ctx, 0.4, 4.8), {
        clavicle_l: [0, 0, -0.03 * shrug],
        clavicle_r: [0, 0, 0.03 * shrug],
        upperarm_l: [0.25 * shrug, 0.9 * shrug, -0.25 * shrug],
        upperarm_r: [0.25 * shrug, -0.9 * shrug, 0.25 * shrug],
        forearm_l: [1.3 * shrug + 0.1, 0, 0],
        forearm_r: [1.3 * shrug + 0.1, 0, 0],
        hand_l: [0, 0.8 * shrug, 0],
        hand_r: [0, -0.8 * shrug, 0],
        head: [-0.04 * shrug, 0, 0.08 * shrug],
        neck: [0.05 * shrug, 0, 0],
      });
    },
  },
  {
    name: "flinch",
    duration: 1.5,
    loop: false,
    flatFeet: true,
    angles: (t, ctx) => {
      // Snaps into the crouch almost at once, holds, then straightens up.
      const e = keys(t, [
        [0, 0],
        [0.12, 1],
        [0.7, 1],
        [1.45, 0],
      ]);
      return blendAngles(stand(ctx), cowerAngles(ctx, t, 1, 1), e);
    },
  },
  {
    name: "cower",
    duration: 2.0,
    loop: true,
    flatFeet: true,
    angles: (t, ctx) => cowerAngles(ctx, t, 1, 1),
  },
  {
    name: "type",
    duration: 3.2,
    loop: true,
    flatFeet: true,
    angles: (t, ctx) => {
      const a = Math.sin((TAU * t) / 0.4);
      const b = Math.sin((TAU * t) / 0.4 + 2.2);
      return addAngles(idleAngles(t, ctx, 0.3, 3.2), {
        upperarm_l: [0.42, -0.45, 0.14],
        upperarm_r: [0.42, 0.45, -0.14],
        forearm_l: [1.2 + 0.07 * a, 0, 0],
        forearm_r: [1.2 + 0.07 * b, 0, 0],
        hand_l: [-0.25, -0.2, 0.9],
        hand_r: [-0.25, 0.2, -0.9],
        chest: [-0.06, 0, 0],
        neck: [-0.1, 0, 0],
        head: [-0.2, 0.05 * Math.sin((TAU * t) / 1.6), 0],
      });
    },
  },
];

export const CLIP_TABLE: Readonly<Record<ClipName, Clip>> = Object.fromEntries(
  CLIPS.map((clip) => [clip.name, clip]),
) as Record<ClipName, Clip>;

// --- Angles to rotations -----------------------------------------------------

const LIMB = new Set<number>([
  BONE.upperarm_l,
  BONE.forearm_l,
  BONE.hand_l,
  BONE.upperarm_r,
  BONE.forearm_r,
  BONE.hand_r,
  BONE.thigh_l,
  BONE.shin_l,
  BONE.foot_l,
  BONE.thigh_r,
  BONE.shin_r,
  BONE.foot_r,
]);

const AX = { x: 1, y: 0, z: 0 };
const AY = { x: 0, y: 1, z: 0 };
const AZ = { x: 0, y: 0, z: 1 };

/** Rotation for one bone's [x, y, z] angles, in that bone's composition order. */
export function angleQuat(
  bone: number,
  a: readonly [number, number, number],
): Quat {
  const qx = quat.fromAxisAngle(AX, a[0]);
  const qy = quat.fromAxisAngle(AY, a[1]);
  const qz = quat.fromAxisAngle(AZ, a[2]);
  return LIMB.has(bone)
    ? quat.multiply(qz, quat.multiply(qx, qy))
    : quat.multiply(qy, quat.multiply(qx, qz));
}

/** Rotations for every bone (identity where a bone has no angles). */
export function anglesToRotations(angles: Angles): Quat[] {
  const out: Quat[] = [];
  for (let i = 0; i < BONE_COUNT; i++) {
    const a = angles[BONE_NAMES[i]];
    out.push(a ? angleQuat(i, a) : quat.identity());
  }
  return out;
}

/** Sum of the pitch (x) angles from the pelvis down to a foot, for flat feet. */
export function legPitch(angles: Angles, side: "l" | "r"): number {
  const get = (name: BoneName): number => angles[name]?.[0] ?? 0;
  return get("pelvis") + get(`thigh_${side}`) + get(`shin_${side}`);
}
