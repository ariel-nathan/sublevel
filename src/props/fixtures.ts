/**
 * World-space boxes of the fixtures the world objects draw at fixed places
 * (door slabs, plate slabs, button units) in a given state. Pure: used to
 * place colliders and by tests that check these never share a plane with
 * the level geometry or each other.
 */
import type { Aabb, ButtonDef, DoorDef, PressurePlateDef } from "../core/api";
import { v3, type Vec3 } from "../math";
import {
  BUTTON_BEZEL_HALF,
  BUTTON_DEPTH,
  BUTTON_EMBED,
  BUTTON_LIT_HEIGHT,
  BUTTON_LIT_RADIUS,
  IMPACT_BEZEL_HALF,
  IMPACT_DEPTH,
  IMPACT_EMBED,
  IMPACT_INSET_FRONT,
  IMPACT_INSET_HALF,
  IMPACT_LIT_HEIGHT,
  IMPACT_LIT_RADIUS,
  IMPACT_PLATE_FRONT,
} from "./meshes";
import { PLATE_SINK } from "./plates";

/** A box that is drawn with some of its faces left out. */
export interface FixtureBox {
  /** Which fixture and part, for reports. */
  owner: string;
  box: Aabb;
  /** Faces not drawn ("px", "nx", "py", "ny", "pz", "nz"). */
  skip: string[];
}

/** The door slab after sliding `t` (0 closed, 1 fully open) of its travel. */
export function doorSlabAt(def: DoorDef, t: number): FixtureBox {
  const d = v3.scale(def.openOffset, t);
  return {
    owner: `${def.id} slab`,
    box: { min: v3.add(def.closed.min, d), max: v3.add(def.closed.max, d) },
    skip: [],
  };
}

/** The plate slab as drawn, raised (`pressed` false) or sunk. */
export function plateSlabAt(
  def: PressurePlateDef,
  pressed: boolean,
): FixtureBox[] {
  const down = v3.create(0, pressed ? -PLATE_SINK : 0, 0);
  const box = {
    min: v3.add(def.box.min, down),
    max: v3.add(def.box.max, down),
  };
  return [
    {
      owner: `${def.id} top`,
      box,
      skip: ["px", "nx", "pz", "nz", "ny"],
    },
    { owner: `${def.id} sides`, box, skip: ["py", "ny"] },
  ];
}

/** Axis-aligned box spanning `from`..`to` along a unit axis with a square cross-section. */
function along(
  centre: Vec3,
  facing: Vec3,
  from: number,
  to: number,
  half: number,
): Aabb {
  const a = v3.addScaled(centre, facing, from);
  const b = v3.addScaled(centre, facing, to);
  const h = v3.create(
    facing.x !== 0 ? 0 : half,
    facing.y !== 0 ? 0 : half,
    facing.z !== 0 ? 0 : half,
  );
  return {
    min: v3.sub(v3.min(a, b), h),
    max: v3.add(v3.max(a, b), h),
  };
}

/**
 * The button unit's bezel and knob. The knob (a short cylinder) is given by
 * its bounding box; it looks the same lit red or green. Buttons face along
 * an axis.
 */
export function buttonParts(def: ButtonDef): FixtureBox[] {
  const f = v3.normalize(def.facing);
  const skip = (side: "back" | "front"): string => {
    const axis = f.x !== 0 ? "x" : f.y !== 0 ? "y" : "z";
    const positive = (f.x || f.y || f.z) > 0;
    return `${(side === "front") === positive ? "p" : "n"}${axis}`;
  };
  if (def.mode === "impact") {
    return [
      {
        owner: `${def.id} bezel`,
        box: along(
          def.position,
          f,
          -IMPACT_DEPTH - IMPACT_EMBED,
          IMPACT_PLATE_FRONT,
          IMPACT_BEZEL_HALF,
        ),
        skip: [skip("back")],
      },
      {
        owner: `${def.id} inset`,
        box: along(
          def.position,
          f,
          IMPACT_PLATE_FRONT,
          IMPACT_INSET_FRONT,
          IMPACT_INSET_HALF,
        ),
        skip: [skip("back")],
      },
      {
        owner: `${def.id} knob`,
        box: along(def.position, f, -IMPACT_LIT_HEIGHT, 0, IMPACT_LIT_RADIUS),
        skip: [skip("back")],
      },
    ];
  }
  return [
    {
      owner: `${def.id} bezel`,
      box: along(
        def.position,
        f,
        -BUTTON_DEPTH - BUTTON_EMBED,
        -BUTTON_LIT_HEIGHT,
        BUTTON_BEZEL_HALF,
      ),
      skip: [skip("back")],
    },
    {
      owner: `${def.id} knob`,
      box: along(def.position, f, -BUTTON_LIT_HEIGHT, 0, BUTTON_LIT_RADIUS),
      skip: [skip("back")],
    },
  ];
}

/** The part of a button that stops rays and bodies: its bezel and knob. */
export function buttonCollider(def: ButtonDef): Aabb {
  // The bezel stretched out to the button face (the knob's cap) on its axis.
  const [bezel] = buttonParts(def);
  const tip = def.position;
  return { min: v3.min(bezel.box.min, tip), max: v3.max(bezel.box.max, tip) };
}
