/**
 * Carries out `SolutionStep`s in a running game with the pilot, knowing
 * nothing about the level but its `LevelData`. Used by `tools/solve.ts`
 * (play a level's whole declared solution) and `tools/push-check.ts`.
 *
 * How each step is done (geometry shared with the module tests, see
 * src/level/rooms/solution.ts):
 *   walk   straight to the point, after waiting (up to 10 s) for any door
 *          slab to leave a doorway on the way; fails if it does not arrive.
 *          A point lower than the feet (off a ledge or a crate): walk off,
 *          land, then finish the walk.
 *   climb  face the point, a short run at it with one jump, keep running
 *          until landed (stopping short of the point), then walk onto it;
 *          a try that falls short goes back to where the step began for
 *          another run-up (CLIMB_TRIES).
 *   press  the button by id from where the player stands, walking straight
 *          to its press spot first if it is out of reach; fails without a
 *          `button_press` event.
 *   carry  walk up to the prop (spawn index) and pick it up, then set it
 *          down as `carryPlan` says (or standing at `from` and releasing
 *          at height `holdY`, when the step gives them); fails unless it
 *          rests within CARRY_TOLERANCE of the target.
 *   push   stand behind the prop and walk into it, re-approaching as
 *          needed; fails unless it rests within PUSH_TOLERANCE.
 *   throw  fetch the prop, come back to where the step began (or to
 *          `from`) and throw it at the point with the ballistic solver
 *          (pilot.throwAt: the prop is let settle in the hand and the pitch is
 *          solved from where it hangs); up to 3 tries, each confirmed by a
 *          `button_press` event within 1 m of the point. Retries aim a little
 *          higher and lower (THROW_LIFTS) because a tumbling crate that grazes
 *          the target's rim does not count, and fetch the missed prop again
 *          only if it landed within reach (low, in the throwing spot's zone);
 *          otherwise the nearest other throwable there (carriable, at least
 *          1 kg, not used by an earlier step, not on a plate).
 *   wait   until the event has happened, counting from the start of the
 *          previous step (so a wait right after the step that causes the
 *          event does not miss it).
 */
import type { ButtonDef, LevelData, SolutionStep } from "../src/core/api";
import { PLAYER, PROP_SPECS } from "../src/core/props";
import { boxOf, boxesOverlap, type Box } from "../src/level/geometry";
import {
  CARRY_TOLERANCE,
  canPress,
  carryPlan,
  fetchPoint,
  HOLD_LOWER,
  holdDistance,
  pressStand,
  PUSH_TOLERANCE,
  pushApproach,
} from "../src/level/rooms/solution";
import type { GameSession } from "./browser";
import type { Pilot, PilotEvent } from "./pilot";
import { horizontalDistance, type Point3 } from "./pilot-math";

const f = (n: number) => n.toFixed(2);

/** How much higher (m) each successive throw aims than the target. */
const THROW_LIFTS = [0, 0.1, -0.1];
/** Tries of one climb. */
const CLIMB_TRIES = 3;
/** Props tried to fetch for one throw (the step's, then others nearby). */
const FETCH_CANDIDATES = 4;

export function describeStep(s: SolutionStep): string {
  switch (s.do) {
    case "walk":
      return `walk to (${f(s.to.x)}, ${f(s.to.z)})${s.to.y ? ` at height ${f(s.to.y)}` : ""}`;
    case "climb":
      return `climb onto (${f(s.to.x)}, ${f(s.to.y)}, ${f(s.to.z)})`;
    case "press":
      return `press ${s.button}`;
    case "carry":
      return `carry prop ${s.prop} to (${f(s.to.x)}, ${f(s.to.y)}, ${f(s.to.z)})${
        s.from ? ` from (${f(s.from.x)}, ${f(s.from.z)})` : ""
      }${s.holdY === undefined ? "" : ` at height ${f(s.holdY)}`}`;
    case "push":
      return `push prop ${s.prop} to (${f(s.to.x)}, ${f(s.to.z)})`;
    case "throw":
      return `throw prop ${s.prop} at (${f(s.at.x)}, ${f(s.at.y)}, ${f(s.at.z)})${
        s.from ? ` from (${f(s.from.x)}, ${f(s.from.z)})` : ""
      }`;
    case "wait":
      return s.for === undefined
        ? `wait ${s.seconds} s`
        : `wait for ${s.for} (${s.seconds} s)`;
  }
}

export class Solver {
  /** Physics body id of each prop, by spawn index. */
  private bodyOf: number[] = [];
  private solids: Box[] = [];
  private plates: Box[] = [];
  private stepStart = 0;
  private previousStart = 0;
  /** Props (spawn indices) earlier steps carried, pushed or threw. */
  private used = new Set<number>();

  private constructor(
    readonly session: GameSession,
    readonly pilot: Pilot,
    readonly level: LevelData,
  ) {}

  /**
   * Reads the level from the page and maps props to bodies. Call before
   * the simulation has moved anything: bodies are created in spawn order,
   * and each is checked by kind and starting position.
   */
  static async create(session: GameSession, pilot: Pilot): Promise<Solver> {
    const level = await session.evaluate<LevelData>("__game.level.data");
    const solver = new Solver(session, pilot, level);
    const colliders = await session.evaluate<{ min: Point3; max: Point3 }[]>(
      "__game.level.colliders",
    );
    solver.solids = colliders.map(boxOf);
    solver.plates = level.plates.map((p) => boxOf(p.box));
    const bodies = (await pilot.state()).bodies
      .slice()
      .sort((a, b) => a.id - b.id);
    const taken = new Set<number>();
    level.props.forEach((spawn, i) => {
      const matches = (b: (typeof bodies)[number]) =>
        !taken.has(b.id) &&
        b.tag === spawn.kind &&
        Math.hypot(
          b.position.x - spawn.position.x,
          b.position.y - spawn.position.y,
          b.position.z - spawn.position.z,
        ) < 0.05;
      const body =
        bodies[i] && matches(bodies[i]) ? bodies[i] : bodies.find(matches);
      if (!body) throw new Error(`no body matches prop ${i} (${spawn.kind})`);
      taken.add(body.id);
      solver.bodyOf[i] = body.id;
    });
    return solver;
  }

  body(prop: number): number {
    return this.bodyOf[prop];
  }

  /** Carries out one step. Returns null, or what went wrong. */
  async run(step: SolutionStep): Promise<string | null> {
    this.previousStart = this.stepStart;
    this.stepStart = (await this.pilot.state()).step;
    const result = await this.runStep(step);
    if ("prop" in step) this.used.add(step.prop);
    return result;
  }

  private async runStep(step: SolutionStep): Promise<string | null> {
    switch (step.do) {
      case "walk":
        return (await this.walk(step.to)) ? null : "did not arrive";
      case "climb":
        return this.climb(step.to);
      case "press":
        return this.press(step.button);
      case "carry":
        return this.carry(step.prop, step.to, step.from, step.holdY);
      case "push":
        return this.push(step.prop, step.to);
      case "throw":
        return this.throwAt(step.prop, step.at, step.from);
      case "wait":
        if (step.for === undefined) {
          // A plain delay.
          await this.pilot.wait(Math.round(step.seconds * 60));
          return null;
        }
        return this.wait(step.for, step.seconds);
    }
  }

  /** Static geometry plus the bodies where they are now, except `ignore`. */
  private async clearNow(ignore: number): Promise<(b: Box) => boolean> {
    const bodies = (await this.pilot.state()).bodies.filter(
      (b) => b.id !== ignore,
    );
    const boxes = bodies.flatMap((b) => {
      const spec = PROP_SPECS[b.tag as keyof typeof PROP_SPECS];
      if (!spec) return [];
      const r = Math.max(spec.halfExtents.x, spec.halfExtents.z);
      const h = spec.halfExtents.y;
      return [
        {
          x0: b.position.x - r,
          x1: b.position.x + r,
          y0: b.position.y - h,
          y1: b.position.y + h,
          z0: b.position.z - r,
          z1: b.position.z + r,
        },
      ];
    });
    return (box) =>
      !this.solids.some((s) => boxesOverlap(s, box, 1e-4)) &&
      !boxes.some((s) => boxesOverlap(s, box, 1e-4));
  }

  /** Waits until no door slab is in the way of walking from a to b. */
  private async doorsClear(
    a: Point3,
    b: { x: number; z: number },
  ): Promise<boolean> {
    const r = PLAYER.halfWidth;
    const lane: Box = {
      x0: Math.min(a.x, b.x) - r,
      x1: Math.max(a.x, b.x) + r,
      y0: 0.1,
      y1: PLAYER.standHeight,
      z0: Math.min(a.z, b.z) - r,
      z1: Math.max(a.z, b.z) + r,
    };
    for (const door of this.level.doors) {
      const c = boxOf(door.closed);
      if (!boxesOverlap(lane, c)) continue;
      const probe = JSON.stringify({
        min: { x: c.x0 + 0.01, y: c.y0 + 0.01, z: c.z0 + 0.01 },
        max: { x: c.x1 - 0.01, y: c.y1 - 0.01, z: c.z1 - 0.01 },
      });
      let waited = 0;
      while (
        await this.session.evaluate<boolean>(
          `__game.physics.overlapBox(${probe}).some((c) => c.kind === "kinematic")`,
        )
      ) {
        if (waited >= 600) {
          this.pilot.log(`door ${door.id} stayed in the doorway`);
          return false;
        }
        await this.session.evaluate("__harness.step(5)");
        waited += 5;
      }
      if (waited > 0) {
        this.pilot.log(`waited ${waited} steps for door ${door.id}`);
      }
    }
    return true;
  }

  async walk(to: { x: number; y?: number; z: number }): Promise<boolean> {
    const feet = (await this.pilot.state()).player.feet;
    if (!(await this.doorsClear(feet, to))) return false;
    if (to.y !== undefined && to.y < feet.y - 0.25) {
      await this.dropOff(feet, to);
    }
    const result = await this.pilot.walkTo(to.x, to.z, {
      direct: true,
      tolerance: 0.15,
    });
    return result.arrived;
  }

  /**
   * Steps down off a ledge on the way from `feet` to `to`: walks to just
   * before the edge (the last point with solid ground at the feet's height
   * on the way), then creeps over it and lets go of the keys until landed,
   * so that the run's momentum does not carry the player far past it.
   */
  private async dropOff(
    feet: Point3,
    to: { x: number; z: number },
  ): Promise<void> {
    const length = horizontalDistance(feet, to);
    const ux = (to.x - feet.x) / length;
    const uz = (to.z - feet.z) / length;
    const supported = (x: number, z: number) =>
      this.solids.some(
        (b) =>
          Math.abs(b.y1 - feet.y) < 0.06 &&
          x >= b.x0 &&
          x <= b.x1 &&
          z >= b.z0 &&
          z <= b.z1,
      );
    let edge = 0;
    while (
      edge + 0.05 <= length &&
      supported(feet.x + ux * (edge + 0.05), feet.z + uz * (edge + 0.05))
    )
      edge += 0.05;
    const stop = Math.max(0, edge - 0.25);
    if (stop > 0.1) {
      await this.pilot.walkTo(feet.x + ux * stop, feet.z + uz * stop, {
        direct: true,
        tolerance: 0.1,
      });
    }
    const yaw = (Math.atan2(-ux, -uz) * 180) / Math.PI;
    const pitch = (await this.pilot.state()).player.pitchDeg;
    await this.pilot.look(yaw, pitch, true);
    // Creep until airborne (the feet leave the edge once the body's centre
    // is about its radius past it), then let go and land.
    let airborne = false;
    for (let i = 0; i < 90 && !airborne; i++) {
      await this.session.evaluate(`__harness.step(1, {"moveZ":0.6})`);
      airborne = !(await this.pilot.state()).player.onGround;
    }
    // Brake in the air (as much as air control allows), then fall.
    for (let i = 0; i < 120; i++) {
      await this.session.evaluate(
        `__harness.step(1, {"moveZ":${i < 8 ? -1 : 0}})`,
      );
      if ((await this.pilot.state()).player.onGround) break;
    }
    await this.pilot.wait(15);
    const now = (await this.pilot.state()).player.feet;
    this.pilot.log(
      `dropped off the edge${airborne ? "" : " (never airborne)"} to (${f(now.x)}, ${f(now.y)}, ${f(now.z)})`,
    );
  }

  /**
   * Climbs onto a higher surface: faces the point, one jump with a run at
   * it, keeps running until landed (stopping short of the point), then
   * walks onto the spot. A try that falls short goes back to where the
   * step began for another run-up; at most CLIMB_TRIES.
   */
  private async climb(to: Point3): Promise<string | null> {
    const start = (await this.pilot.state()).player.feet;
    for (let attempt = 1; attempt <= CLIMB_TRIES; attempt++) {
      let f = (await this.pilot.state()).player.feet;
      if (attempt > 1) {
        if (Math.abs(f.y - start.y) > 0.2) {
          return `fell to height ${f.y.toFixed(2)} on try ${attempt - 1}`;
        }
        await this.pilot.walkTo(start.x, start.z, {
          direct: true,
          tolerance: 0.15,
        });
        f = (await this.pilot.state()).player.feet;
      }
      const yaw = (Math.atan2(-(to.x - f.x), -(to.z - f.z)) * 180) / Math.PI;
      await this.pilot.look(yaw, -20, true);
      await this.session.evaluate(`__harness.step(1, {"moveZ":1,"jump":true})`);
      for (let i = 0; i < 40; i++) {
        const s = await this.pilot.state();
        const d = Math.hypot(to.x - s.player.feet.x, to.z - s.player.feet.z);
        if (i > 4 && s.player.onGround) break;
        await this.session.evaluate(
          `__harness.step(2, {"moveZ":${d > 0.3 ? 1 : 0}})`,
        );
      }
      const now = (await this.pilot.state()).player.feet;
      if (now.y > to.y - 0.2) {
        const walked = await this.pilot.walkTo(to.x, to.z, {
          direct: true,
          tolerance: 0.15,
        });
        return walked.arrived ? null : "landed but could not reach the spot";
      }
      this.pilot.log(
        `climb ${attempt} fell short (feet at y ${now.y.toFixed(2)})`,
      );
    }
    return `${CLIMB_TRIES} climbs fell short`;
  }

  private button(id: string): ButtonDef {
    const b = this.level.buttons.find((x) => x.id === id);
    if (!b) throw new Error(`no button "${id}"`);
    return b;
  }

  private async press(id: string): Promise<string | null> {
    const b = this.button(id);
    const feet = (await this.pilot.state()).player.feet;
    if (!canPress(b, feet) && !(await this.walk(pressStand(b, feet.y)))) {
      return "could not reach the button";
    }
    const p = b.position;
    return (await this.pilot.pressHere(p.x, p.y, p.z))
      ? null
      : "no button_press event";
  }

  /** Walks up to a prop if needed and picks it up. */
  private async fetch(prop: number): Promise<boolean> {
    const id = this.bodyOf[prop];
    const state = await this.pilot.state();
    const body = state.bodies.find((b) => b.id === id);
    if (!body) return false;
    const spot = fetchPoint(body.position, state.player.feet);
    if (
      horizontalDistance(spot, state.player.feet) > 0.05 &&
      !(await this.walk(spot))
    ) {
      return false;
    }
    return this.pilot.pickUp(id);
  }

  private async carry(
    prop: number,
    to: Point3,
    stand?: { x: number; z: number },
    holdY?: number,
  ): Promise<string | null> {
    const from = (await this.pilot.state()).player.feet;
    if (!(await this.fetch(prop))) return "could not pick it up";
    const kind = this.level.props[prop].kind;
    const auto = carryPlan(
      kind,
      from,
      to,
      await this.clearNow(this.bodyOf[prop]),
      this.plates,
      from.y,
    );
    if (!auto && (stand === undefined || holdY === undefined)) {
      return "no clear way to set it down";
    }
    // The step's own spot and release height win over the planned ones.
    const at = stand ?? auto!.stand;
    const release = holdY ?? auto!.holdY;
    let pitchDeg = auto?.pitchDeg ?? 0;
    if (stand !== undefined || holdY !== undefined) {
      const eyeY = from.y + PLAYER.eyeHeight;
      const sin = (release + HOLD_LOWER - eyeY) / holdDistance(kind);
      if (sin < -1 || sin > 1) return "the release height is out of reach";
      pitchDeg = (Math.asin(sin) * 180) / Math.PI;
    }
    const rest = await this.pilot.setDown(to.x, to.y, to.z, at, pitchDeg);
    if (!rest) return "could not set it down";
    const off = horizontalDistance(rest, to);
    return off <= CARRY_TOLERANCE && Math.abs(rest.y - to.y) < 0.3
      ? null
      : `it rests ${f(off)} m from the target`;
  }

  private async push(prop: number, to: Point3): Promise<string | null> {
    const kind = this.level.props[prop].kind;
    const end = await this.pilot.pushTo(
      this.bodyOf[prop],
      to.x,
      to.z,
      (at) => pushApproach(kind, at, to),
      PUSH_TOLERANCE,
    );
    return end && horizontalDistance(end, to) <= PUSH_TOLERANCE
      ? null
      : `it stopped ${end ? f(horizontalDistance(end, to)) : "?"} m short`;
  }

  private async throwAt(
    prop: number,
    at: Point3,
    stand?: { x: number; z: number },
  ): Promise<string | null> {
    const from = stand ?? (await this.pilot.state()).player.feet;
    for (let attempt = 1; attempt <= THROW_LIFTS.length; attempt++) {
      // The step's prop first; after a miss, wherever it landed, or another
      // throwable of the room if it landed out of reach.
      const candidates = await this.throwables(prop, from, attempt === 1);
      let held = -1;
      for (const candidate of candidates.slice(0, FETCH_CANDIDATES)) {
        if (await this.fetch(candidate)) {
          held = candidate;
          break;
        }
        this.pilot.log(`could not pick up prop ${candidate}`);
      }
      if (held < 0) return "could not pick anything up to throw";
      if (held !== prop) this.pilot.log(`throw ${attempt}: prop ${held}`);
      const here = (await this.pilot.state()).player.feet;
      if (horizontalDistance(here, from) > 0.15 && !(await this.walk(from))) {
        return "could not get back to the throwing spot";
      }
      const mark = (await this.pilot.state()).step;
      const aimed = await this.pilot.throwAt(
        at.x,
        at.y,
        at.z,
        THROW_LIFTS[attempt - 1],
      );
      if (!aimed) return "the target is out of range";
      const hit = await this.pilot.waitForEvent(
        "a hit near the target",
        (e: PilotEvent) => {
          const p = e.position as Point3 | undefined;
          return (
            e.type === "button_press" &&
            e.step >= mark &&
            p !== undefined &&
            Math.hypot(p.x - at.x, p.y - at.y, p.z - at.z) < 1
          );
        },
        120,
      );
      if (hit) return null;
      this.pilot.log(`throw ${attempt} missed`);
    }
    return `${THROW_LIFTS.length} throws missed`;
  }

  /**
   * Props to throw, best first: `prop` (always on the first try, later only
   * if it lies within reach: low, in the throwing spot's zone), then the
   * room's other throwables nearest `from`: carriable, at least 1 kg, not
   * used by an earlier step, not on a plate, low, in the same zone.
   */
  private async throwables(
    prop: number,
    from: { x: number; z: number },
    first: boolean,
  ): Promise<number[]> {
    const bodies = (await this.pilot.state()).bodies;
    const zone = this.level.zones
      .map((z) => boxOf(z.box))
      .find(
        (b) =>
          from.x >= b.x0 && from.x <= b.x1 && from.z >= b.z0 && from.z <= b.z1,
      );
    const near = (p: Point3) =>
      p.y < 1.5 &&
      (zone
        ? p.x >= zone.x0 && p.x <= zone.x1 && p.z >= zone.z0 && p.z <= zone.z1
        : horizontalDistance(p, from) < 8);
    const where = (i: number) =>
      bodies.find((b) => b.id === this.bodyOf[i])?.position ?? null;
    const out: number[] = [];
    const own = where(prop);
    if (first || (own && near(own))) out.push(prop);
    const others = this.level.props
      .map((spawn, i) => ({
        i,
        mass: PROP_SPECS[spawn.kind].mass,
        at: where(i),
      }))
      .filter(
        (c) =>
          c.i !== prop &&
          !this.used.has(c.i) &&
          c.at !== null &&
          c.mass >= 1 &&
          c.mass <= PLAYER.maxCarryMass &&
          near(c.at) &&
          !this.plates.some(
            (p) =>
              c.at!.x >= p.x0 - 0.2 &&
              c.at!.x <= p.x1 + 0.2 &&
              c.at!.z >= p.z0 - 0.2 &&
              c.at!.z <= p.z1 + 0.2,
          ),
      )
      .sort(
        (a, b) =>
          horizontalDistance(a.at!, from) - horizontalDistance(b.at!, from),
      );
    out.push(...others.map((c) => c.i));
    return out;
  }

  private async wait(type: string, seconds: number): Promise<string | null> {
    const already = (await this.pilot.events(this.previousStart - 1)).some(
      (e) => e.type === type,
    );
    if (already) {
      this.pilot.log(`${type} already happened`);
      return null;
    }
    const got = await this.pilot.waitForEvent(
      type,
      (e) => e.type === type,
      Math.round(seconds * 60),
    );
    return got ? null : "it did not happen";
  }
}
