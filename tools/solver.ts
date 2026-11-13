/**
 * Carries out `SolutionStep`s in a running game with the pilot, knowing
 * nothing about the level but its `LevelData`. Used by `tools/solve.ts`
 * (play a level's whole declared solution) and `tools/push-check.ts`.
 *
 * How each step is done (geometry shared with the module tests, see
 * src/level/rooms/solution.ts):
 *   walk   straight to the point, after waiting (up to 10 s) for any door
 *          slab to leave a doorway on the way; fails if it does not arrive.
 *   press  the button by id from where the player stands, walking straight
 *          to its press spot first if it is out of reach; fails without a
 *          `button_press` event.
 *   carry  walk up to the prop (spawn index) and pick it up, then set it
 *          down as `carryPlan` says; fails unless it rests within
 *          CARRY_TOLERANCE of the target.
 *   push   stand behind the prop and walk into it, re-approaching as
 *          needed; fails unless it rests within PUSH_TOLERANCE.
 *   throw  fetch the prop, come back to where the step began and throw it
 *          at the point with the ballistic solver; up to 3 tries, each
 *          confirmed by a `button_press` event within 1 m of the point.
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
  pressStand,
  PUSH_TOLERANCE,
  pushApproach,
} from "../src/level/rooms/solution";
import type { GameSession } from "./browser";
import type { Pilot, PilotEvent } from "./pilot";
import { horizontalDistance, type Point3 } from "./pilot-math";

const f = (n: number) => n.toFixed(2);

export function describeStep(s: SolutionStep): string {
  switch (s.do) {
    case "walk":
      return `walk to (${f(s.to.x)}, ${f(s.to.z)})`;
    case "press":
      return `press ${s.button}`;
    case "carry":
      return `carry prop ${s.prop} to (${f(s.to.x)}, ${f(s.to.y)}, ${f(s.to.z)})`;
    case "push":
      return `push prop ${s.prop} to (${f(s.to.x)}, ${f(s.to.z)})`;
    case "throw":
      return `throw prop ${s.prop} at (${f(s.at.x)}, ${f(s.at.y)}, ${f(s.at.z)})`;
    case "wait":
      return `wait for ${s.for} (${s.seconds} s)`;
  }
}

export class Solver {
  /** Physics body id of each prop, by spawn index. */
  private bodyOf: number[] = [];
  private solids: Box[] = [];
  private plates: Box[] = [];
  private stepStart = 0;
  private previousStart = 0;

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
    switch (step.do) {
      case "walk":
        return (await this.walk(step.to)) ? null : "did not arrive";
      case "press":
        return this.press(step.button);
      case "carry":
        return this.carry(step.prop, step.to);
      case "push":
        return this.push(step.prop, step.to);
      case "throw":
        return this.throwAt(step.prop, step.at);
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

  async walk(to: { x: number; z: number }): Promise<boolean> {
    const feet = (await this.pilot.state()).player.feet;
    if (!(await this.doorsClear(feet, to))) return false;
    const result = await this.pilot.walkTo(to.x, to.z, {
      direct: true,
      tolerance: 0.15,
    });
    return result.arrived;
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

  private async carry(prop: number, to: Point3): Promise<string | null> {
    const from = (await this.pilot.state()).player.feet;
    if (!(await this.fetch(prop))) return "could not pick it up";
    const plan = carryPlan(
      this.level.props[prop].kind,
      from,
      to,
      await this.clearNow(this.bodyOf[prop]),
      this.plates,
      from.y,
    );
    if (!plan) return "no clear way to set it down";
    const rest = await this.pilot.setDown(
      to.x,
      to.y,
      to.z,
      plan.stand,
      plan.pitchDeg,
    );
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

  private async throwAt(prop: number, at: Point3): Promise<string | null> {
    const from = (await this.pilot.state()).player.feet;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (!(await this.fetch(prop))) return "could not pick it up";
      const here = (await this.pilot.state()).player.feet;
      if (horizontalDistance(here, from) > 0.15 && !(await this.walk(from))) {
        return "could not get back to the throwing spot";
      }
      const mark = (await this.pilot.state()).step;
      await this.pilot.throwAt(at.x, at.y, at.z);
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
    return "three throws missed";
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
