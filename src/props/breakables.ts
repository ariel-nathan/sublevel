import type { BodyState, PhysicsWorld } from "../core/api";
import type { Rng } from "../core/rng";
import { quat, v3, type Quat, type Vec3 } from "../math";
import { PLANK_PRESETS } from "./meshes";

/**
 * Contact impulse (N·s) above which a weak crate falls apart.
 *
 * Against something immovable the impulse is about m (1 + e) v, m = 15 kg for
 * the weak crate. Measured in the real solver: dropped from 1 m about 72, from
 * 2 m about 104; thrown at a wall at 3 m/s about 43, at 5 m/s about 79, at
 * 8 m/s about 130. So a hard throw or a 2 m drop breaks it with margin, a lob
 * under ~3 m/s does not. Against a 25 kg crate the pair behaves like a
 * 9.4 kg reduced mass: thrown at it at 4 m/s gives about 21, 5 m/s 38, 6 m/s
 * 51, 8 m/s 75, so it needs a real throw (about 6 m/s). Setting a crate down
 * (under 1 m/s, below 15 N·s) or lowering a 25 kg crate onto it (a drop of
 * under ~0.2 m, below 40 N·s) stays well under.
 */
export const BREAK_IMPULSE = 50;

export const DEBRIS_LIFETIME = 8;
export const DEBRIS_FADE = 0.4;
export const DEBRIS_MIN_COUNT = 6;
export const DEBRIS_MAX_COUNT = 8;

export interface DebrisSpawn {
  bodyId: number;
  preset: number;
  position: Vec3;
  orientation: Quat;
}

/**
 * Creates 6 to 8 plank bodies where a crate was. Planks are stacked in
 * separate layers so none overlap at the start, then sent flying with the
 * crate's own velocity plus an outward scatter and spin.
 */
export function spawnDebris(
  physics: PhysicsWorld,
  rng: Rng,
  crate: BodyState,
): DebrisSpawn[] {
  const count = rng.int(DEBRIS_MIN_COUNT, DEBRIS_MAX_COUNT);
  const layers = [...Array(count).keys()];
  for (let i = layers.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [layers[i], layers[j]] = [layers[j], layers[i]];
  }
  const spacing = (crate.halfExtents.y * 1.6) / (count - 1);
  const spawns: DebrisSpawn[] = [];
  for (let i = 0; i < count; i++) {
    const preset = rng.int(0, PLANK_PRESETS.length - 1);
    const spec = PLANK_PRESETS[preset];
    const local = v3.create(
      rng.range(-0.1, 0.1),
      -crate.halfExtents.y * 0.8 + layers[i] * spacing,
      rng.range(-0.1, 0.1),
    );
    const position = v3.add(
      crate.position,
      quat.rotate(crate.orientation, local),
    );
    const orientation = quat.multiply(
      quat.fromAxisAngle(v3.create(0, 1, 0), rng.range(0, Math.PI * 2)),
      quat.fromAxisAngle(v3.create(1, 0, 0), rng.range(-0.08, 0.08)),
    );
    let out = v3.create(
      position.x - crate.position.x,
      0,
      position.z - crate.position.z,
    );
    if (v3.lengthSq(out) < 1e-6) {
      const angle = rng.range(0, Math.PI * 2);
      out = v3.create(Math.cos(angle), 0, Math.sin(angle));
    }
    out = v3.normalize(out);
    const outward = rng.range(1.0, 2.8);
    const velocity = v3.create(
      crate.linearVelocity.x + out.x * outward,
      crate.linearVelocity.y + rng.range(0.5, 2.0),
      crate.linearVelocity.z + out.z * outward,
    );
    const spin = v3.create(
      rng.range(-6, 6),
      rng.range(-6, 6),
      rng.range(-6, 6),
    );
    const bodyId = physics.addBody({
      position,
      orientation,
      halfExtents: v3.clone(spec.half),
      mass: spec.mass,
      friction: 0.5,
      restitution: 0.15,
      linearVelocity: velocity,
      angularVelocity: spin,
      tag: "debris",
    });
    spawns.push({ bodyId, preset, position, orientation });
  }
  return spawns;
}
