/**
 * The fixed humanoid skeleton, its proportions from a spec, poses and
 * forward kinematics.
 *
 * Character space: feet on y = 0, facing -Z, +X is the character's right.
 * In the bind pose every bone's axes are the character's axes (arms hang
 * straight down), so a bone's local rotation reads the same on every bone:
 * +X rotation swings a limb forward (and bends an elbow), -X bends a knee,
 * +Y turns to the left, and on the trunk -X bends forward.
 */
import { mat4, quat, type Mat4, type Quat, type Vec3 } from "../math";
import type { CharacterSpec } from "./spec";

export const BONE_NAMES = [
  "root",
  "pelvis",
  "spine",
  "chest",
  "neck",
  "head",
  "jaw",
  "clavicle_l",
  "upperarm_l",
  "forearm_l",
  "hand_l",
  "clavicle_r",
  "upperarm_r",
  "forearm_r",
  "hand_r",
  "thigh_l",
  "shin_l",
  "foot_l",
  "thigh_r",
  "shin_r",
  "foot_r",
] as const;

export type BoneName = (typeof BONE_NAMES)[number];

export const BONE_COUNT = BONE_NAMES.length;

/** Index of each bone in BONE_NAMES. */
export const BONE = Object.fromEntries(
  BONE_NAMES.map((name, i) => [name, i]),
) as Readonly<Record<BoneName, number>>;

const PARENT_NAMES: Readonly<Record<BoneName, BoneName | null>> = {
  root: null,
  pelvis: "root",
  spine: "pelvis",
  chest: "spine",
  neck: "chest",
  head: "neck",
  jaw: "head",
  clavicle_l: "chest",
  upperarm_l: "clavicle_l",
  forearm_l: "upperarm_l",
  hand_l: "forearm_l",
  clavicle_r: "chest",
  upperarm_r: "clavicle_r",
  forearm_r: "upperarm_r",
  hand_r: "forearm_r",
  thigh_l: "pelvis",
  shin_l: "thigh_l",
  foot_l: "shin_l",
  thigh_r: "pelvis",
  shin_r: "thigh_r",
  foot_r: "shin_r",
};

/** Parent index of each bone; -1 for the root. Parents come before children. */
export const BONE_PARENTS: readonly number[] = BONE_NAMES.map((name) => {
  const parent = PARENT_NAMES[name];
  return parent === null ? -1 : BONE[parent];
});

/**
 * Body measurements in metres, in character space, derived from a spec.
 * Heights are above the floor; half-widths are from the centre line.
 */
export interface BodyMetrics {
  height: number;
  /** Chin to crown. */
  headLength: number;
  chinY: number;
  /** Top of the shoulder line. */
  shoulderY: number;
  /** Distance from the centre line to the shoulder joint. */
  shoulderHalf: number;
  /** Distance from the centre line to each hip joint. */
  hipHalf: number;
  hipY: number;
  kneeY: number;
  ankleY: number;
  spineY: number;
  chestY: number;
  neckY: number;
  /** Head pivot (top of the neck). */
  headPivotY: number;
  waistY: number;
  /** Bottom of the trunk. */
  crotchY: number;
  upperArm: number;
  forearm: number;
  hand: number;
  /** Shoulder joint height. */
  shoulderJointY: number;
  /** Slim 1 to heavy ~1.35: multiplies trunk widths. */
  girth: number;
  /** Multiplies limb thickness. */
  limb: number;
  /** Scale relative to a 1.8 m person, for widths. */
  scale: number;
  /** "b" figure: 1; "a": 0. */
  softness: number;
  /** Outward angle of the hanging arms needed to clear the hips (radians). */
  armSplay: number;
}

export function bodyMetrics(spec: CharacterSpec): BodyMetrics {
  const H = spec.height;
  const b = spec.build;
  const soft = spec.figure === "b" ? 1 : 0;
  const scale = H / 1.8;
  // Heads grow less than bodies: short people have relatively larger heads.
  // A little larger than life, as the genre draws them.
  const headLength =
    (0.105 * H + 0.046) * spec.headScale * (soft ? 0.965 : 1) * 1.04;
  const chinY = H - headLength;
  const shoulderY = chinY - 0.042 * H;
  const ankleY = 0.044 * H;
  const hipY = (0.505 + 0.012 * spec.legs) * H;
  const kneeY = ankleY + (hipY - ankleY) * 0.52;
  const girth = 1 + 0.32 * b;
  const limb = 1 + 0.22 * b;
  const shoulderHalf = 0.104 * H * (soft ? 0.89 : 1) * (1 + 0.07 * b);
  const hipHalf = 0.049 * H * (soft ? 1.08 : 1) * (1 + 0.1 * b);
  const shoulderJointY = shoulderY - 0.036 * scale;
  const upperArm = 0.17 * H;
  const forearm = 0.15 * H;
  const hand = 0.098 * H;
  // Widest part of the hips, as built in body.ts, plus the arm's radius.
  const hipWidth = 0.172 * scale * girth * (soft ? 1.1 : 1);
  const armRadius = 0.046 * scale * limb;
  const drop = shoulderJointY - (hipY + 0.03 * scale);
  const armSplay = Math.max(
    0.05,
    Math.atan2(hipWidth + armRadius + 0.012 - shoulderHalf, drop),
  );
  return {
    height: H,
    headLength,
    chinY,
    shoulderY,
    shoulderHalf,
    hipHalf,
    hipY,
    kneeY,
    ankleY,
    spineY: hipY + 0.045 * H,
    chestY: hipY + 0.165 * H,
    neckY: shoulderY - 0.012 * scale,
    headPivotY: chinY + 0.2 * headLength,
    waistY: hipY + 0.1 * H,
    crotchY: hipY - 0.05 * H,
    upperArm,
    forearm,
    hand,
    shoulderJointY,
    girth,
    limb,
    scale,
    softness: soft,
    armSplay,
  };
}

export interface Skeleton {
  /** Offset of each bone from its parent in the bind pose (parent space). */
  offsets: Vec3[];
  /** Bind-pose position of each bone in character space. */
  bindPositions: Vec3[];
  metrics: BodyMetrics;
}

/** Bind-pose bone positions in character space. */
function bindPositions(m: BodyMetrics): Vec3[] {
  const s = m.scale;
  const p = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
  const at: Record<BoneName, Vec3> = {
    root: p(0, 0, 0),
    pelvis: p(0, m.hipY, 0),
    spine: p(0, m.spineY, 0.01 * s),
    // The chest part starts at the waist, so the chest bends from there.
    chest: p(0, m.waistY - 0.005 * m.height, 0.01 * s),
    neck: p(0, m.neckY, 0.02 * s),
    head: p(0, m.headPivotY, 0.012 * s),
    jaw: p(0, m.chinY + 0.36 * m.headLength, 0.03 * m.headLength),
    clavicle_l: p(-0.03 * s, m.shoulderY - 0.03 * s, 0.01 * s),
    upperarm_l: p(-m.shoulderHalf, m.shoulderJointY, 0.012 * s),
    forearm_l: p(-m.shoulderHalf, m.shoulderJointY - m.upperArm, 0.012 * s),
    hand_l: p(
      -m.shoulderHalf,
      m.shoulderJointY - m.upperArm - m.forearm,
      0.012 * s,
    ),
    clavicle_r: p(0.03 * s, m.shoulderY - 0.03 * s, 0.01 * s),
    upperarm_r: p(m.shoulderHalf, m.shoulderJointY, 0.012 * s),
    forearm_r: p(m.shoulderHalf, m.shoulderJointY - m.upperArm, 0.012 * s),
    hand_r: p(
      m.shoulderHalf,
      m.shoulderJointY - m.upperArm - m.forearm,
      0.012 * s,
    ),
    thigh_l: p(-m.hipHalf, m.hipY, 0),
    shin_l: p(-m.hipHalf, m.kneeY, 0),
    foot_l: p(-m.hipHalf, m.ankleY, 0.005 * s),
    thigh_r: p(m.hipHalf, m.hipY, 0),
    shin_r: p(m.hipHalf, m.kneeY, 0),
    foot_r: p(m.hipHalf, m.ankleY, 0.005 * s),
  };
  return BONE_NAMES.map((name) => at[name]);
}

export function buildSkeleton(spec: CharacterSpec): Skeleton {
  const metrics = bodyMetrics(spec);
  const positions = bindPositions(metrics);
  const offsets = positions.map((pos, i) => {
    const parent = BONE_PARENTS[i];
    if (parent < 0) {
      return { ...pos };
    }
    const base = positions[parent];
    return { x: pos.x - base.x, y: pos.y - base.y, z: pos.z - base.z };
  });
  return { offsets, bindPositions: positions, metrics };
}

/**
 * A pose: a local rotation per bone (relative to the bind pose, in the
 * parent's axes) and a translation of the root in character space.
 */
export interface Pose {
  root: Vec3;
  rotations: Quat[];
}

export function restPose(): Pose {
  return {
    root: { x: 0, y: 0, z: 0 },
    rotations: BONE_NAMES.map(() => quat.identity()),
  };
}

export function clonePose(pose: Pose): Pose {
  return {
    root: { ...pose.root },
    rotations: pose.rotations.map((q) => ({ ...q })),
  };
}

/**
 * Bone-to-character matrices for a pose: `out[i]` maps bone i's local space
 * to character space. Writes into `out` when given (16 floats per bone).
 */
export function boneMatrices(skeleton: Skeleton, pose: Pose): Mat4[] {
  const out: Mat4[] = [];
  for (let i = 0; i < BONE_COUNT; i++) {
    const parent = BONE_PARENTS[i];
    const offset = skeleton.offsets[i];
    const local =
      parent < 0
        ? mat4.fromTRS(
            {
              x: offset.x + pose.root.x,
              y: offset.y + pose.root.y,
              z: offset.z + pose.root.z,
            },
            pose.rotations[i],
          )
        : mat4.fromTRS(offset, pose.rotations[i]);
    out.push(parent < 0 ? local : mat4.multiply(out[parent], local));
  }
  return out;
}
