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
  // Door B open and the exit alcove
  view("storage-door-b-open", [10.5, 1.65, 12], -90, 0, "open"),
  view("alcove-from-door", [12.5, 1.65, 12], -90, 0, "open"),
  view("alcove-screen", [14.3, 1.6, 12], -90, 0, "open"),
  view("alcove-corner", [14.2, 1.6, 11.4], -150, -10, "open"),
  view("alcove-back-to-storage", [15.4, 1.6, 12], 90, 0, "open"),
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
 * Brings the game to the "doors open" state: door A via its lab button (the
 * way a player does it) and door B by teleporting the metal crate onto the
 * pressure plate. Idempotent only on a fresh game.
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
  const events = await pilot.events();
  const opened = events.filter((e) => e.type === "door_open").length;
  if (opened < 2) {
    throw new Error(
      `expected both doors to open, saw ${opened} door_open events`,
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
