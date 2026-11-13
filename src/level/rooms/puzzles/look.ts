/**
 * `bun src/level/rooms/puzzles/look.ts <room> [--seed N] [--view v]`:
 * development tool (never imported by the game). Builds the development
 * level `?rooms=<room>&seed=N` (seed 0: the module's defaults), works out
 * viewpoints inside the room (entry view, overview from a corner, each
 * button, plate and locked door, the view back from the exit) and saves a
 * contact sheet of them to out/look/<room>-<seed>[-view].png. Doors are as
 * built (closed).
 */
import type { DebugView } from "../../../core/api";
import type { Vec3 } from "../../../math";
import { launchGame } from "../../../../tools/browser";
import { contactSheets } from "../../../../tools/image";
import { writePng } from "../../../../tools/png";
import { grabFrame, setDebugView, setPose } from "../../../../tools/views";
import { assembleRoomsLevel } from "../../dev";
import { boxOf } from "../../geometry";
import { doorwayPoints } from "../room";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const room = args[0];
const seed = Number(flag("--seed") ?? "1");
const view = (flag("--view") ?? "none") as DebugView;
const name = seed === 0 ? `${room}!default` : room;

const { rooms } = assembleRoomsLevel([name], seed === 0 ? 1 : seed);
const placed = rooms.find((r) => r.name.startsWith("r1."))!;
const fp = placed.plan.footprint.slice(0, 1).map(boxOf);
const inner = {
  x0: Math.min(...fp.map((b) => b.x0)) + 0.4,
  x1: Math.max(...fp.map((b) => b.x1)) - 0.4,
  z0: Math.min(...fp.map((b) => b.z0)) + 0.4,
  z1: Math.max(...fp.map((b) => b.z1)) - 0.4,
  y1: Math.max(...fp.map((b) => b.y1)) - 0.45,
};
const centre = { x: (inner.x0 + inner.x1) / 2, z: (inner.z0 + inner.z1) / 2 };
const clampIn = (p: Vec3): Vec3 => ({
  x: Math.min(inner.x1, Math.max(inner.x0, p.x)),
  y: Math.min(inner.y1, Math.max(0.3, p.y)),
  z: Math.min(inner.z1, Math.max(inner.z0, p.z)),
});

interface Shot {
  label: string;
  position: Vec3;
  yawDeg: number;
  pitchDeg: number;
}

function aim(label: string, from: Vec3, to: Vec3): Shot {
  const p = clampIn(from);
  const dx = to.x - p.x;
  const dy = to.y - p.y;
  const dz = to.z - p.z;
  return {
    label,
    position: p,
    yawDeg: (Math.atan2(-dx, -dz) * 180) / Math.PI,
    pitchDeg: (Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI,
  };
}

const shots: Shot[] = [];
const entry = placed.plan.entry!.connector;
const e = entry.position;
const f = entry.facing;
shots.push(
  aim(
    "entry",
    { x: e.x + f.x * 0.9, y: 1.65, z: e.z + f.z * 0.9 },
    { x: e.x + f.x * 10, y: 1.3, z: e.z + f.z * 10 },
  ),
);
// Overviews from the two entry-side corners.
const corners = [
  { x: inner.x0, z: inner.z0 },
  { x: inner.x1, z: inner.z1 },
  { x: inner.x0, z: inner.z1 },
  { x: inner.x1, z: inner.z0 },
].sort(
  (a, b) => Math.hypot(a.x - e.x, a.z - e.z) - Math.hypot(b.x - e.x, b.z - e.z),
);
for (const c of corners.slice(0, 2)) {
  shots.push(
    aim(
      "overview",
      { x: c.x, y: Math.min(inner.y1, 3.0), z: c.z },
      { x: 2 * centre.x - c.x, y: 0.3, z: 2 * centre.z - c.z },
    ),
  );
}
for (const b of placed.parts.buttons) {
  shots.push(
    aim(
      b.id.split(".").pop()!,
      {
        x: b.position.x + b.facing.x * 3.2,
        y: 1.7,
        z: b.position.z + b.facing.z * 3.2,
      },
      b.position,
    ),
  );
}
for (const p of placed.parts.plates) {
  const c = boxOf(p.box);
  const m = { x: (c.x0 + c.x1) / 2, y: 0, z: (c.z0 + c.z1) / 2 };
  const dx = e.x - m.x;
  const dz = e.z - m.z;
  const d = Math.hypot(dx, dz) || 1;
  shots.push(
    aim(
      p.id.split(".").pop()!,
      { x: m.x + (dx / d) * 3.5, y: 2.6, z: m.z + (dz / d) * 3.5 },
      m,
    ),
  );
}
for (const door of placed.parts.doors) {
  const c = boxOf(door.closed);
  const m = { x: (c.x0 + c.x1) / 2, y: 1.2, z: (c.z0 + c.z1) / 2 };
  const alongZ = c.x1 - c.x0 < c.z1 - c.z0;
  const n = alongZ
    ? { x: Math.sign(centre.x - m.x) || 1, z: 0 }
    : { x: 0, z: Math.sign(centre.z - m.z) || 1 };
  shots.push(
    aim(
      door.id.split(".").pop()!,
      { x: m.x + n.x * 4, y: 1.7, z: m.z + n.z * 4 },
      m,
    ),
  );
}
const exit = placed.plan.exits[0]?.connector;
if (exit) {
  const b = doorwayPoints(exit).before;
  shots.push(
    aim(
      "from-exit",
      { x: b.x - exit.facing.x * 0.6, y: 1.65, z: b.z - exit.facing.z * 0.6 },
      { x: e.x, y: 1.2, z: e.z },
    ),
  );
}

const session = await launchGame({
  query: `harness&rooms=${name}&seed=${seed === 0 ? 1 : seed}`,
});
try {
  if (view !== "none") await setDebugView(session, view);
  const items = [];
  for (const s of shots) {
    await setPose(session, s);
    items.push({ label: s.label, image: await grabFrame(session) });
  }
  const sheets = contactSheets(items, { cols: 3, rows: 3 });
  for (const [i, sheet] of sheets.entries()) {
    const path = `out/look/${room}-${seed}${view === "none" ? "" : `-${view}`}${i ? `-${i}` : ""}.png`;
    await writePng(
      path,
      sheet.image.width,
      sheet.image.height,
      sheet.image.rgba,
    );
    console.log(`wrote ${path}`);
  }
} finally {
  await session.close();
}
