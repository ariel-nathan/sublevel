/**
 * Dev-only visual inspection of geometry junctions (run with
 * `bun src/level/inspect.ts [outDir] [filter]`). Not imported by the game.
 *
 * Opens the game headlessly, opens both doors (door A with its button, door B
 * by dropping the metal crate on the plate), and captures a list of close-up
 * views. Each view is captured twice with the camera shifted by 2 mm; the
 * third image marks in red every pixel that changed between the two, which is
 * where z-fighting shows up (flat areas that flicker under a tiny move).
 */
import { launchGame } from "../../tools/browser";

type V = [number, number, number];

interface View {
  name: string;
  from: V;
  at: V;
  /** Door state for the view. */
  doors: "closed" | "open";
}

const outDir = process.argv[2] ?? "out/inspect";
const filter = process.argv[3] ?? "";

const views: View[] = [];
const both = (name: string, from: V, at: V): void => {
  views.push({ name: `${name}-closed`, from, at, doors: "closed" });
  views.push({ name: `${name}-open`, from, at, doors: "open" });
};

// Door A, lab side and corridor side, straight on, close up and grazing.
both("doorA-lab", [1.5, 1.4, 0.3], [4, 1.1, 0]);
both("doorA-lab-left", [2.9, 1.5, -0.6], [4, 1.5, -1.0]);
both("doorA-lab-graze-left", [3.6, 1.2, 1.4], [4, 1.1, -1.6]);
both("doorA-lab-graze-right", [3.6, 1.2, -2.0], [4, 1.1, 1.0]);
both("doorA-jamb-top", [3.4, 1.6, 0.0], [4.15, 2.2, -0.6]);
both("doorA-corr", [6.5, 1.4, -0.3], [4.3, 1.1, 0]);
both("doorA-corr-graze", [4.9, 1.2, 1.0], [4.3, 1.1, -1.3]);
both("doorA-inside", [4.15, 1.2, 0.0], [4.15, 1.2, -1.0]);
both("doorA-inside-up", [4.15, 1.0, 0.0], [4.15, 2.4, -0.5]);
// Buttons, close up and from the side.
both("buttonLab", [3.3, 1.3, 1.2], [4, 1.2, 1.2]);
both("buttonLab-side", [3.75, 1.25, 1.65], [3.95, 1.2, 1.2]);
both("buttonLab-above", [3.7, 1.5, 1.2], [3.95, 1.2, 1.2]);
both("buttonCorr", [5.0, 1.3, -1.08], [4.3, 1.2, -1.08]);
both("buttonCorr-side", [4.55, 1.25, -0.6], [4.35, 1.2, -1.08]);
// Door B, storage side and hall side.
both("doorB-storage", [11.0, 1.4, 12.3], [13.5, 1.2, 12]);
both("doorB-storage-graze", [12.9, 1.2, 13.4], [13.5, 1.1, 10.4]);
both("doorB-hall", [15.6, 1.4, 12.4], [14.1, 1.2, 12]);
both("doorB-inside", [13.65, 1.2, 12.3], [13.65, 1.2, 11.0]);
// Plate (raised in "closed", pressed in "open").
both("plate", [8.5, 1.2, 10.4], [8.5, 0, 12]);
both("plate-graze", [10.0, 0.3, 12.0], [8.5, 0.02, 12]);
// Other junctions.
both("lab-ceiling-fixture", [0, 1.8, 1.2], [0, 3, 0]);
both("lab-beams", [-2, 1.8, 0], [-1.2, 3, -2.5]);
both("lab-bench-wall", [2.2, 1.3, -1.2], [2.2, 1.0, -3]);
both("lab-sign", [0, 1.7, -1.2], [0, 1.9, -3]);
both("lab-baseboard", [-3.0, 0.6, 0], [-4, 0.05, -1.5]);
both("lab-cabinets", [1.2, 1.4, 0.8], [1.2, 1.2, 2.3]);
both("lab-rack", [-1.4, 1.5, 1.2], [-1.4, 1.4, 2.4]);
both("lab-desk", [-2.4, 1.2, 0.0], [-4, 0.8, 0]);
both("corr-hazard", [5.4, 1.0, 0.2], [5.4, 0.45, -1.25]);
both("corr-pipes", [6.4, 1.6, 0.4], [6.4, 2.5, -1.25]);
both("corr-ceiling", [5.9, 1.6, 0.6], [5.9, 2.8, 0]);
both("corr-bend", [9.5, 1.6, 1.0], [10.8, 2.4, 3.0]);
both("corr-grate", [9.5, 1.6, 2.0], [9.5, 0, 4.0]);
both("corr-machine", [9.3, 1.3, 3.8], [10.3, 1.1, 3.8]);
both("corr-vents", [6.2, 1.4, 0.2], [6.2, 1.2, 1.25]);
both("storage-entry", [9.5, 1.6, 6.5], [9.5, 1.4, 8.0]);
both("storage-mezz", [9.5, 1.5, 12.5], [7.0, 1.0, 13.8]);
both("storage-mezz-top", [7.0, 2.9, 13.6], [7.0, 1.4, 15.2]);
both("storage-shelves", [7.5, 1.4, 10.0], [5.5, 1.0, 10.0]);
both("storage-ceiling", [9, 2.0, 12], [9, 4, 10.5]);
both("storage-east", [11.5, 1.6, 12], [13.5, 1.6, 10.3]);
both("storage-north", [12.0, 1.6, 10.0], [12.3, 1.8, 8]);
both("hall-screen-slot", [23.5, 1.9, 12.0], [24.6, 1.9, 10.95]);
both("hall-door-t", [22.5, 1.5, 9.9], [25.1, 1.2, 9.9]);
both("hall-timed-button", [24.0, 1.4, 12.6], [25.02, 1.2, 13.0]);
both("hall-channel", [19.0, 1.6, 13.4], [19.0, 0, 14.9]);
both("chamber-target", [29.0, 2.0, 9.8], [31.4, 4.2, 9.8]);
both("exit-door", [29.5, 1.5, 10.4], [31.4, 1.2, 9.8]);
both("lock", [32.2, 1.6, 9.8], [34.7, 1.5, 9.8]);
both("lock-ceiling", [32.2, 1.6, 9.8], [32.9, 3, 9.8]);

function pose(from: V, at: V, dx = 0) {
  const d = [at[0] - from[0], at[1] - from[1], at[2] - from[2]];
  const yaw = Math.atan2(-d[0], -d[2]);
  const pitch = Math.atan2(d[1], Math.hypot(d[0], d[2]));
  return {
    position: { x: from[0] + dx, y: from[1], z: from[2] },
    yawDeg: (yaw * 180) / Math.PI,
    pitchDeg: (pitch * 180) / Math.PI,
  };
}

const session = await launchGame({ width: 1280, height: 960 });
try {
  await session.evaluate("__harness.step(5)");
  let state: "closed" | "open" = "closed";
  const openDoors = async (): Promise<void> => {
    // Door A: press the lab button. Door B: put the metal crate on the plate.
    await session.evaluate(`(() => {
      const g = window.__game;
      const b = g.level.data.buttons[0].position;
      g.world.use({ collider: { kind: "static", id: 0 }, point: b,
        normal: { x: -1, y: 0, z: 0 }, distance: 1 });
      const crate = g.physics.bodies().find((x) => x.tag === "crate_metal");
      const p = g.level.data.plates[0].box;
      g.physics.setBodyPose(crate.id, { x: (p.min.x + p.max.x) / 2,
        y: p.max.y + crate.halfExtents.y + 0.01, z: (p.min.z + p.max.z) / 2 });
    })()`);
    await session.evaluate("__harness.step(240)");
  };
  for (const view of views) {
    if (filter && !view.name.includes(filter)) continue;
    if (view.doors === "open" && state === "closed") {
      // Views are grouped so that every closed view is taken first.
      continue;
    }
    await shoot(view);
  }
  await openDoors();
  state = "open";
  for (const view of views) {
    if (filter && !view.name.includes(filter)) continue;
    if (view.doors !== "open") continue;
    await shoot(view);
  }
  const errors = session.consoleLines.filter((l) => /error/i.test(l));
  if (errors.length > 0) console.log(errors.join("\n"));
} finally {
  await session.close();
}

async function shoot(view: View): Promise<void> {
  const a = pose(view.from, view.at);
  const b = pose(view.from, view.at, 0.002);
  const result = await session.evaluate<{
    changed: number;
    diff: string;
  }>(`(async () => {
    const h = window.__harness;
    h.setCamera(${JSON.stringify(a)});
    const one = h.capture();
    h.setCamera(${JSON.stringify(b)});
    const two = h.capture();
    h.setCamera(${JSON.stringify(a)});
    const load = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = src; });
    const [ia, ib] = await Promise.all([load(one), load(two)]);
    const w = ia.width, hh = ia.height;
    const c = document.createElement("canvas"); c.width = w * 2; c.height = hh;
    const x = c.getContext("2d");
    x.drawImage(ia, 0, 0); const da = x.getImageData(0, 0, w, hh);
    x.drawImage(ib, 0, 0); const db = x.getImageData(0, 0, w, hh);
    const out = x.createImageData(w, hh);
    let changed = 0;
    for (let i = 0; i < da.data.length; i += 4) {
      const d = Math.abs(da.data[i] - db.data[i]) + Math.abs(da.data[i+1] - db.data[i+1]) + Math.abs(da.data[i+2] - db.data[i+2]);
      const g = (da.data[i] + da.data[i+1] + da.data[i+2]) / 6;
      if (d > 40) { changed++; out.data[i] = 255; out.data[i+1] = 0; out.data[i+2] = 0; }
      else { out.data[i] = g; out.data[i+1] = g; out.data[i+2] = g; }
      out.data[i+3] = 255;
    }
    x.drawImage(ia, 0, 0);
    x.putImageData(out, w, 0);
    return { changed, diff: c.toDataURL("image/png") };
  })()`);
  const png = Buffer.from(result.diff.split(",")[1], "base64");
  await Bun.write(`${outDir}/${view.name}.png`, png);
  console.log(`${view.name.padEnd(32)} changed ${result.changed}`);
}
