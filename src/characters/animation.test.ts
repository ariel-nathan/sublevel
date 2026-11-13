import { describe, expect, test } from "bun:test";
import { mat4, type Mat4, type Quat, type Vec3 } from "../math";
import { clipPose, ClipSampler, lowestSole } from "./animator";
import {
  BONE,
  boneMatrices,
  CharacterAnimator,
  CLIP_NAMES,
  CLIP_TABLE,
  generateCharacter,
  LOOK,
  TalkEnvelope,
  type Character,
  type Pose,
} from "./index";
import { distanceOutside } from "./measure";

const cast: Character[] = [
  generateCharacter(1, "scientist"),
  generateCharacter(2, "guard"),
  generateCharacter(7, "scientist"),
  generateCharacter(9, "guard"),
];
// Make sure both figures and a heavy build are covered.
for (let s = 100; cast.length < 8 && s < 400; s++) {
  const c = generateCharacter(s, s % 2 ? "guard" : "scientist");
  const haveB = cast.some((x) => x.spec.figure === "b");
  const haveHeavy = cast.some((x) => x.spec.build > 0.85);
  if (
    (!haveB && c.spec.figure === "b") ||
    (!haveHeavy && c.spec.build > 0.85)
  ) {
    cast.push(c);
  }
}

const samples = (duration: number, n: number, loop: boolean): number[] =>
  Array.from({ length: n }, (_, i) =>
    loop ? (i * duration) / n : (i * duration) / (n - 1),
  );

function inverse(m: Mat4): Mat4 {
  return mat4.invert(m);
}

/** Angle of a pure X rotation (radians); fails if the rotation has other axes. */
function xAngle(q: Quat): number {
  expect(Math.abs(q.y)).toBeLessThan(1e-6);
  expect(Math.abs(q.z)).toBeLessThan(1e-6);
  return 2 * Math.atan2(q.x, q.w);
}

describe("clips", () => {
  test("no NaN, feet near the floor, root never sinks, joints inside limits", () => {
    for (const c of cast) {
      for (const name of CLIP_NAMES) {
        const clip = CLIP_TABLE[name];
        const footHeights = [0, 0];
        const times = samples(clip.duration, 40, clip.loop);
        for (const t of times) {
          const pose = clipPose(c, clip, t);
          for (const q of pose.rotations) {
            expect(Number.isFinite(q.x + q.y + q.z + q.w)).toBe(true);
          }
          const mats = boneMatrices(c.skeleton, pose);
          // Feet: the lowest sole point is on the floor, never under it.
          expect(Math.abs(lowestSole(c, pose))).toBeLessThan(1e-3);
          [BONE.foot_l, BONE.foot_r].forEach((bone, k) => {
            const low = Math.min(
              ...c.soles.map((p) => mat4.transformPoint(mats[bone], p).y),
            );
            expect(low).toBeGreaterThan(-1e-3);
            footHeights[k] += low / times.length;
          });
          // The pelvis stays well above the floor (a crouch is the lowest).
          const pelvisY = mats[BONE.pelvis][13];
          expect(pelvisY).toBeGreaterThan(c.skeleton.metrics.hipY * 0.55);
          // Knees bend backwards only, elbows forwards only, up to 150 deg.
          for (const bone of [BONE.shin_l, BONE.shin_r]) {
            const a = xAngle(pose.rotations[bone]);
            expect(a).toBeLessThanOrEqual(0.02);
            expect(a).toBeGreaterThan((-150 * Math.PI) / 180);
          }
          for (const bone of [BONE.forearm_l, BONE.forearm_r]) {
            const a = xAngle(pose.rotations[bone]);
            expect(a).toBeGreaterThanOrEqual(-0.02);
            expect(a).toBeLessThan((150 * Math.PI) / 180);
          }
        }
        for (const h of footHeights) {
          expect(h).toBeLessThan(0.08);
        }
      }
    }
  });

  test("looping clips loop seamlessly; one-shots start and end at rest", () => {
    const c = cast[0];
    const close = (a: Pose, b: Pose, tol: number): void => {
      a.rotations.forEach((q, i) => {
        const r = b.rotations[i];
        const d = Math.abs(q.x * r.x + q.y * r.y + q.z * r.z + q.w * r.w);
        expect(1 - d).toBeLessThan(tol);
      });
      expect(Math.abs(a.root.y - b.root.y)).toBeLessThan(0.005);
    };
    for (const name of CLIP_NAMES) {
      const clip = CLIP_TABLE[name];
      if (clip.loop) {
        close(
          clipPose(c, clip, 0),
          clipPose(c, clip, clip.duration - 1e-6),
          1e-6,
        );
      } else {
        // Fidgets and the flinch begin and end on the idle pose at that time.
        const idle0 = clipPose(c, CLIP_TABLE.idle, 0);
        close(clipPose(c, clip, 0), idle0, 2e-3);
      }
    }
  });

  test("low-rate sampling: stepped holds each pose, loops wrap onto the first sample", () => {
    const c = cast[1];
    const sampler = new ClipSampler(c, CLIP_TABLE.walk);
    // Loops round the rate so a whole number of samples fits one cycle.
    const per = Math.round(CLIP_TABLE.walk.duration * 15);
    const interval = CLIP_TABLE.walk.duration / per;
    const a = sampler.pose(interval * 3 + 0.001, 15, true);
    const b = sampler.pose(interval * 4 - 0.001, 15, true);
    expect(b).toBe(a);
    expect(sampler.pose(interval * 4 + 0.001, 15, true)).not.toBe(a);
    const end = sampler.pose(CLIP_TABLE.walk.duration - 1e-4, 15, false);
    const start = sampler.pose(0, 15, false);
    end.rotations.forEach((q, i) => {
      const r = start.rotations[i];
      expect(
        Math.abs(q.x * r.x + q.y * r.y + q.z * r.z + q.w * r.w),
      ).toBeGreaterThan(0.995);
    });
  });
});

describe("walk", () => {
  test("opposite arm and leg swing together", () => {
    for (const c of cast) {
      const clip = CLIP_TABLE.walk;
      const legL: number[] = [];
      const armR: number[] = [];
      const armL: number[] = [];
      for (const t of samples(clip.duration, 32, true)) {
        const mats = boneMatrices(c.skeleton, clipPose(c, clip, t));
        const z = (bone: number): number => mats[bone][14];
        // Forward is -Z: negate so forward is positive.
        legL.push(-(z(BONE.foot_l) - z(BONE.thigh_l)));
        armR.push(-(z(BONE.hand_r) - z(BONE.upperarm_r)));
        armL.push(-(z(BONE.hand_l) - z(BONE.upperarm_l)));
      }
      const corr = (a: number[], b: number[]): number => {
        const ma = a.reduce((s, v) => s + v, 0) / a.length;
        const mb = b.reduce((s, v) => s + v, 0) / b.length;
        let num = 0;
        let da = 0;
        let db = 0;
        for (let i = 0; i < a.length; i++) {
          num += (a[i] - ma) * (b[i] - mb);
          da += (a[i] - ma) ** 2;
          db += (b[i] - mb) ** 2;
        }
        return num / Math.sqrt(da * db);
      };
      expect(corr(legL, armR)).toBeGreaterThan(0.85);
      expect(corr(legL, armL)).toBeLessThan(-0.85);
    }
  });

  test("the stride implies the stated ground speed", () => {
    for (const c of cast) {
      for (const [name, stated] of [
        ["walk", c.walkSpeed],
        ["scurry", c.scurrySpeed],
      ] as const) {
        const clip = CLIP_TABLE[name];
        const n = 240;
        const dt = clip.duration / n;
        let travel = 0;
        let time = 0;
        let prev: Mat4[] | null = null;
        let prevLow = -1;
        for (let i = 0; i <= n; i++) {
          const pose = clipPose(c, clip, i * dt);
          const mats = boneMatrices(c.skeleton, pose);
          const low = [BONE.foot_l, BONE.foot_r]
            .map((bone) =>
              Math.min(
                ...c.soles.map((p) => mat4.transformPoint(mats[bone], p).y),
              ),
            )
            .reduce((best, y, k, arr) => (y < arr[best] ? k : best), 0);
          if (prev && low === prevLow) {
            const bone = low === 0 ? BONE.foot_l : BONE.foot_r;
            // Backwards (+Z) movement of the planted foot relative to the body.
            travel += mats[bone][14] - prev[bone][14];
            time += dt;
          }
          prev = mats;
          prevLow = low;
        }
        const measured = travel / time;
        if (name === "walk") {
          expect(stated).toBeGreaterThan(0.8);
          expect(stated).toBeLessThan(1.7);
        } else {
          expect(stated).toBeGreaterThan(c.walkSpeed * 1.3);
          expect(stated).toBeLessThan(3.2);
        }
        expect(Math.abs(measured - stated) / stated).toBeLessThan(0.15);
      }
    }
    console.log(
      `walk ${cast[0].walkSpeed.toFixed(2)} m/s, scurry ${cast[0].scurrySpeed.toFixed(2)} m/s (height ${cast[0].spec.height} m)`,
    );
  });
});

describe("joints hold together", () => {
  test("seams stay inside their neighbours through every clip", () => {
    let worst = 0;
    let where = "";
    for (const c of cast) {
      for (const name of CLIP_NAMES) {
        const clip = CLIP_TABLE[name];
        for (const t of samples(clip.duration, 16, clip.loop)) {
          const mats = boneMatrices(c.skeleton, clipPose(c, clip, t));
          for (const part of c.parts) {
            for (const seam of part.seams) {
              const others = c.parts.filter((p) =>
                seam.inside.includes(p.bone),
              );
              for (const local of seam.points) {
                const world = mat4.transformPoint(mats[part.bone], local);
                let d = Infinity;
                for (const other of others) {
                  const p = mat4.transformPoint(
                    inverse(mats[other.bone]),
                    world,
                  );
                  d = Math.min(d, distanceOutside(other.mesh, other.pieces, p));
                }
                if (d > worst) {
                  worst = d;
                  where = `${c.spec.kind} ${c.spec.seed} ${name} t=${t.toFixed(2)} bone ${part.bone}`;
                }
              }
            }
          }
        }
      }
    }
    console.log(`widest seam gap ${(worst * 1000).toFixed(1)} mm (${where})`);
    expect(worst).toBeLessThan(0.005);
  });
});

describe("animator", () => {
  const placement = { position: { x: 0, y: 0, z: 0 }, yaw: 0 };
  const headY = (c: Character): number =>
    c.skeleton.bindPositions[BONE.head].y + 0.08;

  test("look-at turns within limits at a limited speed and snaps back from behind", () => {
    const c = cast[0];
    const anim = new CharacterAnimator(c);
    const dt = 1 / 60;
    // Far to the left (90 degrees): clamps at the limit.
    anim.setLookTarget({ x: -5, y: headY(c), z: 0 });
    let prev = anim.look.yaw;
    for (let i = 0; i < 120; i++) {
      anim.update(dt, placement);
      expect(Math.abs(anim.look.yaw - prev)).toBeLessThanOrEqual(
        LOOK.speed * dt + 1e-9,
      );
      prev = anim.look.yaw;
    }
    expect(anim.look.yaw).toBeCloseTo(LOOK.yawLimit, 6);
    // Up high: pitch is limited too.
    anim.setLookTarget({ x: 0, y: 50, z: -1 });
    for (let i = 0; i < 120; i++) anim.update(dt, placement);
    expect(anim.look.pitch).toBeCloseTo(LOOK.pitchUp, 6);
    expect(Math.abs(anim.look.yaw)).toBeLessThan(1e-6);
    // Behind: returns to straight ahead, faster than it turns.
    anim.setLookTarget({ x: -5, y: headY(c), z: 0 });
    for (let i = 0; i < 120; i++) anim.update(dt, placement);
    anim.setLookTarget({ x: 0.3, y: headY(c), z: 5 });
    let frames = 0;
    while (Math.abs(anim.look.yaw) > 1e-6 && frames < 600) {
      anim.update(dt, placement);
      frames++;
    }
    expect(frames).toBeLessThan(Math.ceil(LOOK.yawLimit / (LOOK.speed * dt)));
    // A target on the right with the character turned: still the right sign.
    const turned = { position: { x: 0, y: 0, z: 0 }, yaw: Math.PI / 2 }; // faces -X
    anim.setLookTarget({ x: -3, y: headY(c), z: -1 }); // ahead and to its right
    for (let i = 0; i < 60; i++) anim.update(dt, turned);
    expect(anim.look.yaw).toBeLessThan(-0.2);
  });

  test("cross-fades produce normalised rotations and reach the new clip", () => {
    const c = cast[1];
    const anim = new CharacterAnimator(c);
    anim.update(0.5, placement);
    anim.play("cower");
    for (let i = 0; i < 20; i++) {
      anim.update(1 / 60, placement);
      for (const q of anim.pose().rotations) {
        expect(Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1)).toBeLessThan(1e-6);
      }
    }
    expect(anim.clipName).toBe("cower");
  });

  test("jaw opens the jaw bone only, by up to JAW_OPEN", () => {
    const c = cast[2];
    const anim = new CharacterAnimator(c);
    const closed = anim.pose();
    anim.jaw = 1;
    const open = anim.pose();
    open.rotations.forEach((q, i) => {
      const r = closed.rotations[i];
      const same =
        Math.abs(q.x * r.x + q.y * r.y + q.z * r.z + q.w * r.w) > 1 - 1e-9;
      expect(same).toBe(i !== BONE.jaw);
    });
    // The chin moves down.
    const chinOf = (pose: Pose): Vec3 =>
      mat4.transformPoint(boneMatrices(c.skeleton, pose)[BONE.jaw], {
        x: 0,
        y: -0.06,
        z: -0.08,
      });
    expect(chinOf(open).y).toBeLessThan(chinOf(closed).y - 0.01);
  });

  test("auto idle fidgets now and then and is deterministic", () => {
    const run = (): string[] => {
      const anim = new CharacterAnimator(cast[3]);
      anim.setAuto(true);
      const clips: string[] = [];
      for (let i = 0; i < 60 * 40; i++) {
        anim.update(1 / 60, placement);
        if (clips[clips.length - 1] !== anim.clipName)
          clips.push(anim.clipName);
      }
      return clips;
    };
    const a = run();
    expect(a).toEqual(run());
    expect(a.filter((n) => n !== "idle").length).toBeGreaterThanOrEqual(3);
  });

  test("talk envelope is syllable-like: bursts with pauses, 0..1", () => {
    const env = new TalkEnvelope(4);
    let open = 0;
    let transitions = 0;
    let last = false;
    for (let t = 0; t < env.period; t += 1 / 60) {
      const v = env.at(t);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      const on = v > 0.05;
      if (on) open++;
      if (on !== last) transitions++;
      last = on;
    }
    const share = open / (env.period * 60);
    expect(share).toBeGreaterThan(0.3);
    expect(share).toBeLessThan(0.9);
    expect(transitions / env.period).toBeGreaterThan(4);
  });
});
