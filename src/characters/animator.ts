/**
 * Playing clips on a character: low-rate sampling (the era's stiff look),
 * planting the feet, short cross-fades between clips, an automatic idle that
 * fidgets now and then, and two procedural layers on top: turning the head
 * towards a point and opening the jaw.
 */
import { mat4, quat, type Mat4, type Quat, type Vec3 } from "../math";
import { createRng, type Rng } from "../core/rng";
import {
  anglesToRotations,
  CLIP_TABLE,
  FIDGETS,
  legPitch,
  type Angles,
  type Clip,
  type ClipName,
} from "./clips";
import type { Character } from "./generate";
import { BONE, boneMatrices, type Pose } from "./skeleton";

/** Poses per second sampled from a clip; the motion in between is interpolated. */
export const ANIM_SAMPLE_RATE = 15;
/** Default cross-fade between clips, seconds (short and a little abrupt). */
export const DEFAULT_FADE = 0.2;
/** Jaw rotation at full opening, radians. */
export const JAW_OPEN = 0.24;

/** Head-turning limits and speeds. */
export const LOOK = {
  /** Largest turn left or right, radians. */
  yawLimit: 1.25,
  pitchUp: 0.42,
  pitchDown: 0.55,
  /** Turning speed, radians per second. */
  speed: 3.2,
  /** A target further round than this is "behind": the head snaps back. */
  behind: 1.95,
  /** Speed of the snap back to straight ahead. */
  snapSpeed: 9,
  /** Share of the turn taken by chest, neck and head. */
  yawShare: { chest: 0.18, neck: 0.32, head: 0.5 },
  pitchShare: { neck: 0.4, head: 0.6 },
} as const;

/** Where a character stands: feet position and facing (yaw 0 faces -Z). */
export interface Placement {
  position: Vec3;
  yaw: number;
}

/** Model matrix of a placement. */
export function placementMatrix(p: Placement): Mat4 {
  return mat4.fromTRS(
    p.position,
    quat.fromAxisAngle({ x: 0, y: 1, z: 0 }, p.yaw),
  );
}

/** Lowest point of either sole in character space for a pose. */
export function lowestSole(character: Character, pose: Pose): number {
  const mats = boneMatrices(character.skeleton, pose);
  let lowest = Infinity;
  for (const bone of [BONE.foot_l, BONE.foot_r]) {
    for (const p of character.soles) {
      const y = mat4.transformPoint(mats[bone], p).y;
      lowest = Math.min(lowest, y);
    }
  }
  return lowest;
}

/**
 * Ground speed (m/s) at which a walking clip's planted foot stays still:
 * the average backward speed of the sole point touching the floor,
 * relative to the body, over one cycle. Movement code moves the character
 * forward at this speed while the clip plays.
 */
export function groundSpeed(
  character: Character,
  clip: Clip,
  samples = 96,
): number {
  const dt = clip.duration / samples;
  let travel = 0;
  let time = 0;
  let prev: { key: number; z: number } | null = null;
  for (let i = 0; i <= samples; i++) {
    const pose = clipPose(character, clip, i * dt);
    const mats = boneMatrices(character.skeleton, pose);
    let best = { key: -1, y: Infinity, z: 0 };
    [BONE.foot_l, BONE.foot_r].forEach((bone, f) => {
      character.soles.forEach((p, k) => {
        const w = mat4.transformPoint(mats[bone], p);
        if (w.y < best.y - 1e-6) best = { key: f * 10 + k, y: w.y, z: w.z };
      });
    });
    if (prev && prev.key === best.key) {
      travel += best.z - prev.z;
      time += dt;
    }
    prev = { key: best.key, z: best.z };
  }
  return time > 0 ? travel / time : 0;
}

/** A clip's raw angles at time t, with flat feet applied when the clip wants them. */
export function clipAngles(
  character: Character,
  clip: Clip,
  t: number,
): Angles {
  const angles = clip.angles(t, {
    metrics: character.skeleton.metrics,
    habits: character.habits,
  });
  if (clip.flatFeet) {
    for (const side of ["l", "r"] as const) {
      const foot = angles[`foot_${side}`] ?? [0, 0, 0];
      const roll =
        (angles.pelvis?.[2] ?? 0) + (angles[`thigh_${side}`]?.[2] ?? 0);
      angles[`foot_${side}`] = [
        foot[0] - legPitch(angles, side),
        foot[1],
        foot[2] - roll,
      ];
    }
  }
  return angles;
}

/** The pose of a clip at exactly time t (no low-rate sampling), feet on the floor. */
export function clipPose(character: Character, clip: Clip, t: number): Pose {
  const pose: Pose = {
    root: { x: 0, y: 0, z: 0 },
    rotations: anglesToRotations(clipAngles(character, clip, t)),
  };
  pose.root.y = -lowestSole(character, pose);
  return pose;
}

function nlerp(a: Quat, b: Quat, t: number): Quat {
  const sign = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w < 0 ? -1 : 1;
  return quat.normalize({
    x: a.x + (b.x * sign - a.x) * t,
    y: a.y + (b.y * sign - a.y) * t,
    z: a.z + (b.z * sign - a.z) * t,
    w: a.w + (b.w * sign - a.w) * t,
  });
}

/** Blend of two poses (normalised rotations, linear root). */
export function blendPoses(a: Pose, b: Pose, t: number): Pose {
  return {
    root: {
      x: a.root.x + (b.root.x - a.root.x) * t,
      y: a.root.y + (b.root.y - a.root.y) * t,
      z: a.root.z + (b.root.z - a.root.z) * t,
    },
    rotations: a.rotations.map((q, i) => nlerp(q, b.rotations[i], t)),
  };
}

/**
 * Samples a clip the way the era did: at `rate` poses per second, either
 * holding each pose (stepped) or interpolating linearly between neighbours.
 * Loops wrap seamlessly; one-shot clips stop on their last pose.
 */
export class ClipSampler {
  private cache = new Map<string, Pose>();
  constructor(
    readonly character: Character,
    readonly clip: Clip,
  ) {}

  private sampleAt(index: number, rate: number): Pose {
    const key = `${index}:${rate}`;
    let pose = this.cache.get(key);
    if (!pose) {
      const d = this.clip.duration;
      let t = index / rate;
      t = this.clip.loop ? ((t % d) + d) % d : Math.min(t, d);
      pose = clipPose(this.character, this.clip, t);
      if (this.cache.size > 64) {
        this.cache.clear();
      }
      this.cache.set(key, pose);
    }
    return pose;
  }

  pose(t: number, rate: number, stepped: boolean): Pose {
    const d = this.clip.duration;
    // Loops: count samples per cycle so the last sample wraps onto the first.
    const perCycle = Math.max(1, Math.round(d * rate));
    const r = this.clip.loop ? perCycle / d : rate;
    const x = Math.max(0, t) * r;
    let k = Math.floor(x);
    if (this.clip.loop) {
      k %= perCycle;
    }
    const a = this.sampleAt(k, r);
    if (stepped) {
      return a;
    }
    const b = this.sampleAt(this.clip.loop ? (k + 1) % perCycle : k + 1, r);
    return blendPoses(a, b, x - Math.floor(x));
  }
}

export interface AnimatorOptions {
  sampleRate?: number;
  stepped?: boolean;
  /** Seed for fidget choice and timing; defaults to the character's seed. */
  seed?: number;
}

/**
 * Drives one character: a current clip, a cross-fade from the previous
 * pose, an automatic idle with random fidgets, and the look-at and jaw
 * layers. Deterministic for a given seed and sequence of calls.
 */
export class CharacterAnimator {
  sampleRate: number;
  stepped: boolean;
  /** Jaw opening 0..1, applied on top of the clip. */
  jaw = 0;
  private sampler: ClipSampler;
  private time = 0;
  private from: Pose | null = null;
  private fadeTime = 0;
  private fadeDuration = 0;
  private auto = false;
  private idleTimer = 0;
  private nextFidget = 0;
  private readonly rng: Rng;
  private lookTarget: Vec3 | null = null;
  /** Current head turn (yaw left positive, pitch up positive), radians. */
  readonly look = { yaw: 0, pitch: 0 };

  constructor(
    readonly character: Character,
    options: AnimatorOptions = {},
  ) {
    this.sampleRate = options.sampleRate ?? ANIM_SAMPLE_RATE;
    this.stepped = options.stepped ?? false;
    this.rng = createRng(
      ((options.seed ?? character.spec.seed) * 7919 + 13) >>> 0,
    );
    this.sampler = new ClipSampler(character, CLIP_TABLE.idle);
    this.scheduleFidget();
  }

  get clipName(): ClipName {
    return this.sampler.clip.name;
  }

  /** Seconds into the current clip. */
  get clipTime(): number {
    return this.time;
  }

  /** True when a one-shot clip has reached its end. */
  get finished(): boolean {
    return !this.sampler.clip.loop && this.time >= this.sampler.clip.duration;
  }

  /** Starts a clip from its beginning, cross-fading from the current pose. */
  play(name: ClipName, fade = DEFAULT_FADE): void {
    this.from = fade > 0 ? this.basePose() : null;
    this.fadeTime = 0;
    this.fadeDuration = fade;
    this.sampler = new ClipSampler(this.character, CLIP_TABLE[name]);
    this.time = 0;
    if (name === "idle") {
      this.scheduleFidget();
    }
  }

  /** Idle with a random fidget every few seconds. */
  setAuto(on: boolean): void {
    this.auto = on;
    if (on && this.clipName !== "idle") {
      this.play("idle");
    }
  }

  /** A world point to look at, or null to look straight ahead. */
  setLookTarget(target: Vec3 | null): void {
    this.lookTarget = target ? { ...target } : null;
  }

  private scheduleFidget(): void {
    this.idleTimer = 0;
    this.nextFidget = this.rng.range(3, 8) * this.character.habits.tempo;
  }

  /** Advances time and the look layer. `placement` is where the character stands. */
  update(dt: number, placement?: Placement): void {
    this.time += dt;
    if (this.from) {
      this.fadeTime += dt;
      if (this.fadeTime >= this.fadeDuration) {
        this.from = null;
      }
    }
    if (this.auto) {
      if (this.clipName === "idle") {
        this.idleTimer += dt;
        if (this.idleTimer >= this.nextFidget) {
          const pick = FIDGETS[Math.floor(this.rng.next() * FIDGETS.length)];
          this.play(pick);
        }
      } else if (this.finished) {
        this.play("idle");
      }
    }
    this.updateLook(dt, placement);
  }

  private updateLook(dt: number, placement?: Placement): void {
    let wantYaw = 0;
    let wantPitch = 0;
    let speed: number = LOOK.speed;
    if (this.lookTarget && placement) {
      const head = this.character.skeleton.bindPositions[BONE.head];
      const c = Math.cos(placement.yaw);
      const s = Math.sin(placement.yaw);
      // Head position in the world (bind pose, plus a little for the face).
      const hx = placement.position.x + c * head.x + s * head.z;
      const hy = placement.position.y + head.y + 0.08;
      const hz = placement.position.z - s * head.x + c * head.z;
      const dx = this.lookTarget.x - hx;
      const dy = this.lookTarget.y - hy;
      const dz = this.lookTarget.z - hz;
      // Into the character's frame: right = (c, 0, -s), forward = (-s, 0, -c).
      const right = dx * c - dz * s;
      const forward = -dx * s - dz * c;
      const yaw = Math.atan2(-right, forward);
      const pitch = Math.atan2(dy, Math.hypot(right, forward));
      if (Math.abs(yaw) > LOOK.behind) {
        speed = LOOK.snapSpeed;
      } else {
        wantYaw = Math.max(-LOOK.yawLimit, Math.min(LOOK.yawLimit, yaw));
        wantPitch = Math.max(-LOOK.pitchDown, Math.min(LOOK.pitchUp, pitch));
      }
    } else {
      speed = LOOK.speed;
    }
    const step = speed * dt;
    const toward = (from: number, to: number): number =>
      from + Math.max(-step, Math.min(step, to - from));
    this.look.yaw = toward(this.look.yaw, wantYaw);
    this.look.pitch = toward(this.look.pitch, wantPitch);
  }

  /** The current clip pose, cross-faded, without the procedural layers. */
  basePose(): Pose {
    const pose = this.sampler.pose(this.time, this.sampleRate, this.stepped);
    if (this.from && this.fadeDuration > 0) {
      const w = Math.min(1, this.fadeTime / this.fadeDuration);
      return blendPoses(this.from, pose, w);
    }
    return pose;
  }

  /** The final pose: clip, cross-fade, head turn and jaw. */
  pose(): Pose {
    const base = this.basePose();
    const rotations = base.rotations.slice();
    const turn = (bone: number, yaw: number, pitch: number): void => {
      const q = quat.multiply(
        quat.fromAxisAngle({ x: 0, y: 1, z: 0 }, yaw),
        quat.fromAxisAngle({ x: 1, y: 0, z: 0 }, pitch),
      );
      rotations[bone] = quat.normalize(quat.multiply(q, rotations[bone]));
    };
    const { yaw, pitch } = this.look;
    if (yaw !== 0 || pitch !== 0) {
      turn(BONE.chest, yaw * LOOK.yawShare.chest, 0);
      turn(BONE.neck, yaw * LOOK.yawShare.neck, pitch * LOOK.pitchShare.neck);
      turn(BONE.head, yaw * LOOK.yawShare.head, pitch * LOOK.pitchShare.head);
    }
    const jaw = Math.max(0, Math.min(1, this.jaw));
    if (jaw > 0) {
      rotations[BONE.jaw] = quat.normalize(
        quat.multiply(
          rotations[BONE.jaw],
          quat.fromAxisAngle({ x: 1, y: 0, z: 0 }, -jaw * JAW_OPEN),
        ),
      );
    }
    return { root: base.root, rotations };
  }
}

/**
 * A syllable-like opening and closing of the mouth for a talking character
 * without audio: words of a few syllables, short pauses between words and a
 * longer breath now and then. Deterministic from the seed; repeats every
 * `period` seconds.
 */
export class TalkEnvelope {
  private readonly syllables: {
    start: number;
    length: number;
    level: number;
  }[] = [];
  readonly period: number;

  constructor(seed: number, period = 12) {
    this.period = period;
    const rng = createRng((seed * 48271 + 5) >>> 0);
    let t = 0.1;
    let words = 0;
    while (t < period - 0.6) {
      const count = rng.int(1, 4);
      for (let i = 0; i < count && t < period - 0.4; i++) {
        const length = rng.range(0.11, 0.24);
        this.syllables.push({ start: t, length, level: rng.range(0.45, 1) });
        t += length + rng.range(0.0, 0.05);
      }
      words++;
      t += words % 5 === 0 ? rng.range(0.5, 0.9) : rng.range(0.08, 0.22);
    }
  }

  /** Mouth opening 0..1 at time t. */
  at(t: number): number {
    const x = ((t % this.period) + this.period) % this.period;
    for (const s of this.syllables) {
      if (x >= s.start && x < s.start + s.length) {
        return s.level * Math.sin((Math.PI * (x - s.start)) / s.length);
      }
    }
    return 0;
  }
}
