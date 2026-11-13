/**
 * Named viewpoints for the visual review tools (tour, lint-visual), and the
 * helpers to put the game in a door state and capture frames from them.
 *
 * Coordinates are world metres; yaw 0 looks along -Z and positive yaw turns
 * left (yaw -90 looks along +X, 90 along -X, 180 along +Z).
 */
import type { DebugView } from "../src/core/api";
import type { GameSession } from "./browser";
import type { Image } from "./image";
import { Pilot } from "./pilot";
import { viewBasis, type Point3 } from "./pilot-math";
import { decodePng } from "./png";

export type DoorState = "closed" | "open";

export interface Viewpoint {
  name: string;
  /** Camera position. */
  pos: readonly [number, number, number];
  yaw: number;
  pitch: number;
  /** The door state this view belongs to in the tour. */
  doors: DoorState;
}

const view = (
  name: string,
  pos: readonly [number, number, number],
  yaw: number,
  pitch: number,
  doors: DoorState = "closed",
): Viewpoint => ({ name, pos, yaw, pitch, doors });

export const VIEWS: readonly Viewpoint[] = [
  // Lab
  view("lab-spawn", [-2, 1.65, 1.6], -90, 0),
  view("lab-west-desk", [3.3, 1.65, 0.2], 90, -5),
  view("lab-north-benches", [0, 1.6, 1.8], 0, 0),
  view("lab-south-cabinets", [1.5, 1.6, -1.2], 180, 0),
  view("lab-ceiling", [0, 1.65, 0], -90, 60),
  view("lab-ne-corner-floor", [1.2, 1.9, 1.5], -32, -20),
  view("lab-sw-corner-floor", [-1, 1.65, 0.5], 130, -23),
  view("lab-east-wall-north", [1.5, 1.6, -1.5], -90, 0),
  view("lab-door-a-closed", [1.8, 1.65, 0], -90, 0),
  view("lab-button-closeup", [2.9, 1.5, 1.2], -90, -8),
  // Door A open
  view("lab-door-a-open", [1.8, 1.65, 0], -90, 0, "open"),
  view("door-a-slab-in-wall", [2.9, 1.5, -0.6], -70, 0, "open"),
  view("corridor-back-into-lab", [6, 1.65, 0], 90, 0, "open"),
  // Corridor
  view("corridor-door-a-closed", [6.5, 1.65, 0], 90, 0),
  view("corridor-button-closeup", [5.4, 1.3, -0.95], 90, 0),
  view("corridor-east", [5, 1.65, 0], -90, 0),
  view("corridor-hazard-wall", [7.5, 1.6, 0.5], 50, -23),
  view("corridor-bend-corner", [8.6, 1.65, -0.3], -125, 0),
  view("corridor-south-run", [9.55, 1.65, 0], 180, 0),
  view("corridor-grate-floor", [9.55, 1.65, 3], 180, -50),
  view("corridor-machine", [8.6, 1.5, 3.8], -90, 0),
  view("corridor-to-storage", [9.55, 1.65, 4.5], 180, 0),
  // Storage room
  view("storage-entry", [9.55, 1.65, 8.4], 180, 0),
  view("storage-far-corner", [6.5, 1.65, 8.6], -137, 0),
  view("storage-plate", [8.5, 1.65, 9.4], 180, -32),
  view("storage-mezzanine", [10.5, 1.65, 11.5], 135, 0),
  view("storage-door-b-closed", [10.5, 1.65, 12], -90, 0),
  view("storage-west-shelves", [9, 1.65, 10], 90, 0),
  view("storage-ceiling", [9.5, 1.65, 12], 180, 55),
  view("storage-barrels", [9.5, 1.5, 12], -135, -13),
  view("storage-north-doorway", [9.5, 1.65, 12], -20, -5),
  // Filtration hall, door B closed (the camera is placed, not walked)
  view("hall-from-door-b", [14.6, 1.65, 12.3], -85, 2),
  view("hall-overview", [14.6, 3.6, 11.5], -112, -20),
  view("hall-timed-button", [23.9, 1.5, 13], -90, -5),
  view("hall-button-to-door-t", [23.8, 1.65, 13], -25, -4),
  view("hall-screen-slot", [22, 1.9, 12.3], -30, 0),
  view("hall-lane", [15, 1.65, 9.6], -90, 0),
  view("hall-lane-door-t-closed", [22.5, 1.65, 9.8], -90, -3),
  view("hall-lane-floor", [16, 1.9, 9], -120, -25),
  view("hall-vessels", [20.5, 1.65, 11.8], 150, 0),
  view("hall-pump-corner", [21, 1.65, 12.5], -130, -5),
  view("hall-back-to-door-b", [22, 1.65, 12.5], 90, 0),
  view("hall-ceiling", [19.5, 1.65, 12], -90, 60),
  view("hall-sw-corner-floor", [17.5, 1.9, 12.5], 135, -25),
  // Valve chamber and egress lock, their doors closed
  view("chamber-exit-door-closed", [28.5, 1.65, 9.8], -90, 0),
  view("chamber-target-closeup", [29.9, 3.5, 9.8], -90, 25),
  view("chamber-door-t-inside", [28, 1.65, 10.4], 90, -3),
  view("chamber-manifold", [28.5, 1.65, 10.5], 30, -8),
  view("chamber-console", [28.5, 1.65, 10], 140, -8),
  view("chamber-ceiling", [28.5, 1.65, 9.8], -90, 65),
  view("lock-closed", [33.6, 1.6, 9.8], 90, 0),
  // Every door open: door B by the plate, door T wedged by a small crate,
  // the exit door by a crate thrown at its target
  view("storage-door-b-open", [10.5, 1.65, 12], -90, 0, "open"),
  view("hall-through-door-b", [12.5, 1.65, 12], -90, 0, "open"),
  view("hall-back-to-storage", [15.4, 1.6, 12], 90, 0, "open"),
  view("hall-door-t-wedged", [22.8, 1.65, 9.9], -90, -4, "open"),
  view("hall-wedge-through-slot", [24.3, 1.75, 12], -25, -15, "open"),
  view("hall-button-to-door-t-open", [23.8, 1.65, 13], -25, -4, "open"),
  view("chamber-from-door-t", [26, 1.65, 9.8], -90, 8, "open"),
  view("chamber-target-from-floor", [28, 1.65, 9.8], -90, 32, "open"),
  view("chamber-back-to-hall", [30.5, 1.65, 9.8], 90, 0, "open"),
  view("lock-from-chamber", [30, 1.65, 9.8], -90, 0, "open"),
  view("lock-screen", [32.3, 1.6, 9.8], -90, 0, "open"),
  view("lock-corner", [32.2, 1.6, 8.7], -150, -10, "open"),
  view("lock-back-to-chamber", [34.3, 1.6, 9.8], 90, 0, "open"),
];

/** Filters views by case-insensitive substring of the name. */
export function selectViews(
  views: readonly Viewpoint[],
  only: string | undefined,
): Viewpoint[] {
  if (!only) {
    return [...views];
  }
  const needle = only.toLowerCase();
  return views.filter((v) => v.name.toLowerCase().includes(needle));
}

/**
 * In-page script that opens the doors beyond door B and leaves the timed
 * door wedged: presses the timed button (as the use key would), throws a
 * chamber crate at the exit door's impact target, and once the timed door
 * is open puts the lane's small crate in its doorway. Steps 100 steps,
 * well inside the timed button's countdown, so the timed door is still
 * open when the steps end. Shared with src/level/coverage.ts.
 */
export const OPEN_FAR_DOORS_SCRIPT = `(() => {
  const g = window.__game;
  const d = g.level.data;
  const timed = d.buttons.find((b) => b.mode === "timed");
  const target = d.buttons.find((b) => b.mode === "impact");
  const door = d.doors.find((x) => x.id === timed.target);
  g.world.use({ collider: { kind: "static", id: 0 }, point: timed.position,
    normal: timed.facing, distance: 1 });
  const smalls = g.physics.bodies().filter((b) => b.tag === "crate_wood_small");
  const thrown = smalls.find((b) => b.position.x > door.closed.max.x &&
    b.position.x < target.position.x);
  const f = target.facing;
  g.physics.setBodyPose(thrown.id, { x: target.position.x + f.x * 0.4,
    y: target.position.y, z: target.position.z + f.z * 0.4 });
  g.physics.setBodyVelocity(thrown.id, { x: -f.x * 8, y: 0, z: -f.z * 8 });
  __harness.step(80);
  const wedge = smalls.find((b) => b.position.x < door.closed.min.x &&
    b.position.z < door.closed.min.z);
  g.physics.setBodyPose(wedge.id, { x: (door.closed.min.x + door.closed.max.x) / 2 - 0.12,
    y: 0.26, z: door.closed.max.z - 0.5 });
  __harness.step(20);
})()`;

/**
 * Brings the game to the "doors open" state: door A via its lab button (the
 * way a player does it), door B by teleporting the metal crate onto the
 * pressure plate, then the doors beyond (OPEN_FAR_DOORS_SCRIPT). Idempotent
 * only on a fresh game.
 */
export async function openDoors(pilot: Pilot): Promise<void> {
  const pressed = await pilot.pressButtonAt(3.91, 1.2, 1.2, { x: -2, z: 1.2 });
  if (!pressed) {
    throw new Error("could not press the lab button to open door A");
  }
  const crates = await pilot.bodies("crate_metal");
  if (crates.length === 0) {
    throw new Error("no crate_metal body to put on the plate");
  }
  await pilot.session.evaluate(
    `__game.physics.setBodyPose(${crates[0].id}, { x: 8.5, y: 0.4, z: 12 })`,
  );
  await pilot.wait(200);
  await pilot.session.evaluate(OPEN_FAR_DOORS_SCRIPT);
  await pilot.wait(1);
  const events = await pilot.events();
  const opened = events.filter((e) => e.type === "door_open").length;
  const closed = events.filter((e) => e.type === "door_close").length;
  if (opened < 4 || closed > 0) {
    throw new Error(
      `expected all four doors to open, saw ${opened} door_open and ${closed} door_close events`,
    );
  }
}

export interface Pose {
  position: Point3;
  yawDeg: number;
  pitchDeg: number;
}

export function poseOf(v: Viewpoint, offset?: Point3): Pose {
  return {
    position: {
      x: v.pos[0] + (offset?.x ?? 0),
      y: v.pos[1] + (offset?.y ?? 0),
      z: v.pos[2] + (offset?.z ?? 0),
    },
    yawDeg: v.yaw,
    pitchDeg: v.pitch,
  };
}

/** Camera offsets used to jitter a view: `mm` millimetres right and forward. */
export function jitterOffsets(
  v: Viewpoint,
  mm: number,
): { right: Point3; forward: Point3 } {
  const { forward, right } = viewBasis({ yawDeg: v.yaw, pitchDeg: v.pitch });
  const m = mm / 1000;
  return {
    right: { x: right.x * m, y: right.y * m, z: right.z * m },
    forward: { x: forward.x * m, y: forward.y * m, z: forward.z * m },
  };
}

export function setPose(session: GameSession, pose: Pose): Promise<void> {
  return session.evaluate(`__harness.setCamera(${JSON.stringify(pose)})`);
}

export function setDebugView(
  session: GameSession,
  debugView: DebugView,
): Promise<void> {
  return session.evaluate(
    `__harness.setDebugView(${JSON.stringify(debugView)})`,
  );
}

/** Captures the last frame as a decoded image (no file written). */
export async function grabFrame(session: GameSession): Promise<Image> {
  const dataUrl = await session.evaluate<string>("__harness.capture()");
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return decodePng(new Uint8Array(Buffer.from(base64, "base64")));
}
