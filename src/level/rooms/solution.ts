/**
 * How a solution step is carried out, as geometry: where the player stands
 * to press, fetch, set down, push and throw. Shared by the solver bot
 * (tools/solve.ts), which acts on it, and by the module tests, which check
 * every step of every module against the brushes before anyone plays it
 * (`verifySolution`). Pure: no DOM, no physics.
 */
import type {
  ButtonDef,
  PropKind,
  PropSpawn,
  SolutionStep,
} from "../../core/api";
import { PLAYER, PROP_SPECS } from "../../core/props";
import type { Vec3 } from "../../math";
import { boxesOverlap, propBox, type Box } from "../geometry";

// Carrying, from src/player/tuning.ts: the held body hangs `holdDistance`
// ahead of the eye along the view, lowered by HOLD_LOWER.
export const HOLD_DISTANCE = 1.15;
export const HOLD_CLEARANCE = 0.55;
export const HOLD_LOWER = 0.15;
// Throwing, also from src/player/tuning.ts.
export const THROW_SPEED_LIGHT = 11;
export const THROW_SPEED_HEAVY = 5;
export const THROW_LIGHT_MASS = 8;
export const THROW_UP = 1.0;
const G = 9.81;

/** Horizontal distance from a button at which the bot stands to press it. */
export const PRESS_STAND = 1.0;
/** A prop farther than this (horizontally) is walked up to before pick-up. */
export const FETCH_REACH = 1.7;
/** ...to this distance from it. */
export const FETCH_STAND = 1.3;
/** Lowest release height above a carried prop's resting height. */
export const DROP_LIFT = 0.25;
/** A set-down prop must come to rest this close to its target (bot check). */
export const CARRY_TOLERANCE = 0.4;
/**
 * How far a carried prop may graze geometry on its way (see carryPlan):
 * the hold is a spring, and a prop that catches an edge by a few
 * centimetres slides round it.
 */
export const CARRY_GRAZE = 0.05;
/** A pushed prop must come to rest this close to its target. */
export const PUSH_TOLERANCE = 0.35;
/** Gap kept between the player and a prop it is about to push. */
export const PUSH_GAP = 0.15;

export interface Point2 {
  x: number;
  z: number;
}

const hyp = (a: Point2, b: Point2): number => Math.hypot(a.x - b.x, a.z - b.z);

/** Point `standOff` metres from `target` on the side facing `from`. */
export function standPoint(
  target: Point2,
  from: Point2,
  standOff: number,
): Point2 {
  const dx = from.x - target.x;
  const dz = from.z - target.z;
  const length = Math.hypot(dx, dz);
  if (length < 1e-9) return { x: target.x - standOff, z: target.z };
  return {
    x: target.x + (dx / length) * standOff,
    z: target.z + (dz / length) * standOff,
  };
}

/** Where the player stands to press a button (feet at floor height y). */
export function pressStand(button: ButtonDef, y = 0): Vec3 {
  return {
    x: button.position.x + button.facing.x * PRESS_STAND,
    y,
    z: button.position.z + button.facing.z * PRESS_STAND,
  };
}

/** True if a standing player at `feet` can press the button. */
export function canPress(button: ButtonDef, feet: Vec3): boolean {
  if (button.mode === "impact") return false;
  const eye = { x: feet.x, y: feet.y + PLAYER.eyeHeight, z: feet.z };
  const d = Math.hypot(
    eye.x - button.position.x,
    eye.y - button.position.y,
    eye.z - button.position.z,
  );
  const ahead =
    (feet.x - button.position.x) * button.facing.x +
    (feet.z - button.position.z) * button.facing.z;
  return d <= PLAYER.reach - 0.3 && ahead > 0.3;
}

/** Where the player stands to pick a prop up, coming from `from`. */
export function fetchPoint(prop: Point2, from: Point2): Point2 {
  return hyp(prop, from) > FETCH_REACH
    ? standPoint(prop, from, FETCH_STAND)
    : { x: from.x, z: from.z };
}

/** How far ahead of the eye a carried prop of this kind hangs. */
export function holdDistance(kind: PropKind): number {
  const h = PROP_SPECS[kind].halfExtents;
  return Math.max(HOLD_DISTANCE, Math.hypot(h.x, h.y, h.z) + HOLD_CLEARANCE);
}

/** Throw speed for a prop of this mass (src/player/tuning.ts throwSpeed). */
export function throwSpeed(mass: number): number {
  const t =
    (mass - THROW_LIGHT_MASS) / (PLAYER.maxCarryMass - THROW_LIGHT_MASS);
  const k = Math.min(1, Math.max(0, t));
  return THROW_SPEED_LIGHT + (THROW_SPEED_HEAVY - THROW_SPEED_LIGHT) * k;
}

/** Something that answers "is this box free of solid geometry?". */
export type Clear = (box: Box) => boolean;

/** The standing player's box at `feet`, above the step height. */
export function bodyBox(feet: Point2 & { y?: number }, margin = 0): Box {
  const y = feet.y ?? 0;
  const h = PLAYER.halfWidth + margin;
  return {
    x0: feet.x - h,
    x1: feet.x + h,
    y0: y + PLAYER.stepHeight + 0.01,
    y1: y + PLAYER.standHeight,
    z0: feet.z - h,
    z1: feet.z + h,
  };
}

/** True if a player walking straight from `a` to `b` touches nothing. */
export function walkClear(a: Vec3, b: Point2, clear: Clear): boolean {
  const n = Math.max(1, Math.ceil(hyp(a, b) / 0.05));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = { x: a.x + (b.x - a.x) * t, y: a.y, z: a.z + (b.z - a.z) * t };
    if (!clear(bodyBox(p))) return false;
  }
  return true;
}

/** A prop-sized box (kind's half extents) centred at `c`. */
export function kindBox(kind: PropKind, c: Vec3, grow = 0): Box {
  const h = PROP_SPECS[kind].halfExtents;
  return {
    x0: c.x - h.x - grow,
    x1: c.x + h.x + grow,
    y0: c.y - h.y - grow,
    y1: c.y + h.y + grow,
    z0: c.z - h.z - grow,
    z1: c.z + h.z + grow,
  };
}

export interface CarryPlan {
  /** Where the player stands to let go. */
  stand: Point2;
  /** Height of the prop's centre when it is let go. */
  holdY: number;
  /** View pitch (degrees) that holds it there. */
  pitchDeg: number;
}

/**
 * How to set a carried prop down so that it rests at `to`: the player
 * stands on the side of `to` facing `from`, as far as the hold distance at
 * the chosen pitch, and lets go with the prop hanging `holdY` high. The
 * lowest release height (at least DROP_LIFT above rest) is chosen for which
 * the player's spot is free and off every plate, and the prop's way from in
 * front of the player to above `to`, and down, is clear.
 */
export function carryPlan(
  kind: PropKind,
  from: Point2,
  to: Vec3,
  clear: Clear,
  plates: Box[] = [],
  floorY = 0,
): CarryPlan | null {
  const distance = holdDistance(kind);
  const eyeY = floorY + PLAYER.eyeHeight;
  const half = PROP_SPECS[kind].halfExtents;
  for (let lift = DROP_LIFT; lift <= 2.2; lift += 0.05) {
    const holdY = to.y + lift;
    const sin = (holdY + HOLD_LOWER - eyeY) / distance;
    if (sin < -1 || sin > 1) continue;
    const pitchDeg = (Math.asin(sin) * 180) / Math.PI;
    if (pitchDeg < -60 || pitchDeg > 20) continue;
    const flat = distance * Math.cos((pitchDeg * Math.PI) / 180);
    const stand = standPoint(to, from, flat);
    const body = bodyBox({ ...stand, y: floorY }, 0.02);
    if (!clear(body)) continue;
    const onPlate = plates.some((p) =>
      boxesOverlap({ ...body, y0: floorY - 0.1, y1: floorY + 1 }, p),
    );
    if (onPlate) continue;
    // The prop from in front of the player to above the target (the hold
    // is springy: grazing something by up to CARRY_GRAZE is fine)...
    const dx = (to.x - stand.x) / flat;
    const dz = (to.z - stand.z) / flat;
    const start = PLAYER.halfWidth + Math.max(half.x, half.z) + 0.05;
    let ok = true;
    for (let d = start; d <= flat + 1e-9 && ok; d += 0.05) {
      ok = clear(
        kindBox(
          kind,
          { x: stand.x + dx * d, y: holdY, z: stand.z + dz * d },
          -CARRY_GRAZE,
        ),
      );
    }
    // ...and the drop to rest.
    for (let y = holdY; y >= to.y && ok; y -= 0.05) {
      ok = clear(kindBox(kind, { x: to.x, y, z: to.z }, 0.005));
    }
    if (ok) return { stand, holdY, pitchDeg };
  }
  return null;
}

/**
 * The view pitch (degrees) at which a prop released at height 0 passes
 * `distance` metres away `rise` metres up, thrown at `speed` along the view
 * plus THROW_UP straight up. The flatter arc; null if out of range.
 */
export function throwPitch(
  distance: number,
  rise: number,
  speed: number,
): number | null {
  const heightAt = (deg: number): number => {
    const a = (deg * Math.PI) / 180;
    const vx = speed * Math.cos(a);
    const vy = speed * Math.sin(a) + THROW_UP;
    const t = distance / vx;
    return vy * t - (G * t * t) / 2;
  };
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
  if (best < rise || heightAt(lo) > rise) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (heightAt(mid) < rise) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * True if a prop of this kind thrown by a player standing at `feet` flies
 * clear of the geometry to the point `at` (ignoring the last 0.3 m, where it
 * meets its target).
 */
export function throwClear(
  kind: PropKind,
  feet: Vec3,
  at: Vec3,
  clear: Clear,
): boolean {
  const speed = throwSpeed(PROP_SPECS[kind].mass);
  const distance = holdDistance(kind);
  const dx = at.x - feet.x;
  const dz = at.z - feet.z;
  const flatTotal = Math.hypot(dx, dz);
  // The body leaves from about the hold point; solve from the eye height.
  const o = { x: feet.x, y: feet.y + PLAYER.eyeHeight, z: feet.z };
  const pitch = throwPitch(flatTotal - distance * 0.8, at.y - o.y, speed);
  if (pitch === null) return false;
  const a = (pitch * Math.PI) / 180;
  const vx = speed * Math.cos(a);
  const vy = speed * Math.sin(a) + THROW_UP;
  const ux = dx / flatTotal;
  const uz = dz / flatTotal;
  const startFlat = distance * 0.8;
  const t1 = (flatTotal - startFlat) / vx;
  const steps = 40;
  for (let k = 0; k < steps; k++) {
    const t = (t1 * k) / steps;
    const f = startFlat + vx * t;
    if (flatTotal - f < 0.3) break;
    const p = {
      x: o.x + ux * f,
      y: o.y + vy * t - (G * t * t) / 2,
      z: o.z + uz * f,
    };
    if (!clear(kindBox(kind, p, 0.02))) return false;
  }
  return true;
}

/** Where the player stands to push a prop at `from` towards `to`. */
export function pushApproach(kind: PropKind, from: Point2, to: Point2): Point2 {
  const half = PROP_SPECS[kind].halfExtents;
  const length = hyp(from, to);
  const ux = (to.x - from.x) / length;
  const uz = (to.z - from.z) / length;
  // The prop's extent along the push direction (axis-aligned box).
  const extent = Math.abs(ux) * half.x + Math.abs(uz) * half.z;
  const back =
    extent + PLAYER.halfWidth / Math.max(Math.abs(ux), Math.abs(uz)) + PUSH_GAP;
  return { x: from.x - ux * back, z: from.z - uz * back };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/** What a solution is checked against. */
export interface SolutionWorld {
  /** Solid boxes: brush colliders (skirting raised) and closed nothing else. */
  solids: Box[];
  /** Tops a player can stand on: brush boxes. */
  floors: Box[];
  props: PropSpawn[];
  buttons: ButtonDef[];
  plates: Box[];
  /** Region every walk must stay in (the module's footprint), if any. */
  within?: Box[];
}

/**
 * Plays a solution on paper from `start` and returns what is wrong with it
 * (empty if nothing): walks off the floor or into brushes or props, buttons
 * out of reach, props too heavy to carry or not heavy enough to need
 * pushing, set-downs and throws with no clear way. Props moved by the
 * solution are tracked; a thrown one is no longer an obstacle.
 */
export function verifySolution(
  steps: SolutionStep[],
  start: Vec3,
  world: SolutionWorld,
): string[] {
  const problems: string[] = [];
  const props = world.props.map((p) => ({ ...p, position: { ...p.position } }));
  const gone = new Set<number>();
  let feet: Vec3 = { ...start };
  const solidClear =
    (ignore: number): Clear =>
    (box) =>
      !world.solids.some((s) => boxesOverlap(s, box, 1e-4)) &&
      !props.some(
        (p, i) =>
          i !== ignore && !gone.has(i) && boxesOverlap(propBox(p), box, 1e-4),
      );
  const onFloor = (p: Point2): boolean =>
    world.floors.some(
      (f) =>
        Math.abs(f.y1 - feet.y) < 0.05 &&
        p.x >= f.x0 - 1e-6 &&
        p.x <= f.x1 + 1e-6 &&
        p.z >= f.z0 - 1e-6 &&
        p.z <= f.z1 + 1e-6,
    );
  const inRegion = (p: Point2): boolean =>
    !world.within ||
    world.within.some(
      (b) =>
        p.x >= b.x0 - 1e-6 &&
        p.x <= b.x1 + 1e-6 &&
        p.z >= b.z0 - 1e-6 &&
        p.z <= b.z1 + 1e-6,
    );
  const walk = (to: Point2, label: string, ignore = -1): void => {
    const n = Math.max(1, Math.ceil(hyp(feet, to) / 0.1));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const p = {
        x: feet.x + (to.x - feet.x) * t,
        z: feet.z + (to.z - feet.z) * t,
      };
      if (!onFloor(p) || !inRegion(p)) {
        problems.push(
          `${label}: (${p.x.toFixed(2)}, ${p.z.toFixed(2)}) is off the floor`,
        );
        break;
      }
    }
    if (!walkClear(feet, to, solidClear(ignore))) {
      problems.push(
        `${label}: the way from (${feet.x.toFixed(2)}, ${feet.z.toFixed(2)}) to (${to.x.toFixed(2)}, ${to.z.toFixed(2)}) is blocked`,
      );
    }
    feet = { x: to.x, y: feet.y, z: to.z };
  };
  const prop = (i: number, label: string) => {
    if (i < 0 || i >= props.length || gone.has(i)) {
      problems.push(`${label}: no prop ${i}`);
      return null;
    }
    return props[i];
  };
  steps.forEach((step, n) => {
    const label = `step ${n} (${step.do})`;
    switch (step.do) {
      case "walk":
        walk(step.to, label);
        feet = { ...feet, y: step.to.y };
        break;
      case "press": {
        const b = world.buttons.find((x) => x.id === step.button);
        if (!b) problems.push(`${label}: no button "${step.button}"`);
        else if (!canPress(b, feet)) {
          problems.push(`${label}: "${b.id}" is out of reach`);
        }
        break;
      }
      case "carry":
      case "throw": {
        const p = prop(step.prop, label);
        if (!p) break;
        const spec = PROP_SPECS[p.kind];
        if (spec.mass > PLAYER.maxCarryMass) {
          problems.push(`${label}: a ${p.kind} is too heavy to carry`);
          break;
        }
        const origin = { ...feet };
        const fetch = fetchPoint(p.position, feet);
        walk(fetch, `${label} fetching`, step.prop);
        if (step.do === "carry") {
          const plan = carryPlan(
            p.kind,
            origin,
            step.to,
            solidClear(step.prop),
            world.plates,
            feet.y,
          );
          if (!plan) {
            problems.push(
              `${label}: no clear way to set it down at the target`,
            );
            break;
          }
          walk(plan.stand, `${label} setting down`, step.prop);
          p.position = { ...step.to };
        } else {
          walk(origin, `${label} returning to throw`, step.prop);
          if (!throwClear(p.kind, feet, step.at, solidClear(step.prop))) {
            problems.push(`${label}: no clear throw at the target`);
          }
          gone.add(step.prop);
        }
        break;
      }
      case "push": {
        const p = prop(step.prop, label);
        if (!p) break;
        const box = propBox(p);
        const dist = hyp(p.position, step.to);
        const n2 = Math.max(1, Math.ceil(dist / 0.05));
        for (let i = 0; i <= n2; i++) {
          const t = i / n2;
          const c = {
            x: p.position.x + (step.to.x - p.position.x) * t,
            z: p.position.z + (step.to.z - p.position.z) * t,
          };
          const swept = {
            ...box,
            x0: box.x0 - p.position.x + c.x,
            x1: box.x1 - p.position.x + c.x,
            y0: box.y0 + 0.01,
            z0: box.z0 - p.position.z + c.z,
            z1: box.z1 - p.position.z + c.z,
          };
          if (!solidClear(step.prop)(swept)) {
            problems.push(`${label}: the push path is blocked`);
            break;
          }
        }
        const approach = pushApproach(p.kind, p.position, step.to);
        walk(approach, `${label} approaching`, -1);
        p.position = { ...step.to };
        // The player ends up just behind it.
        const back = pushApproach(p.kind, step.to, {
          x: step.to.x + (step.to.x - approach.x),
          z: step.to.z + (step.to.z - approach.z),
        });
        feet = { x: back.x, y: feet.y, z: back.z };
        break;
      }
      case "wait":
        if (!(step.seconds > 0)) problems.push(`${label}: no time to wait`);
        break;
    }
  });
  return problems;
}
