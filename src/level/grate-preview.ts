/**
 * Dev-only look at the corridor floor grate and the pit under it (run with
 * `bun src/level/grate-preview.ts [outDir]`). Not imported by the game.
 *
 * Captures fixed cameras on, before and beside the grate in the normal,
 * material and coverage views, each also with the camera moved 2 mm (pixels
 * that change between the two in the material view are z-fighting
 * candidates). Counts magenta (missing geometry) in the coverage view. Then
 * drops and throws a small crate onto the grate and reports where it ends up.
 * To see through the grate the material's texture must have cut-out gaps.
 */
import { launchGame } from "../../tools/browser";
import { GRATE_THICKNESS } from "./rooms/room";

type V = [number, number, number];
const outDir = process.argv[2] ?? "out/grate-preview";

const cams: { name: string; pos: V; yaw: number; pitch: number }[] = [
  { name: "on-grate-down", pos: [9.3, 1.65, 4.0], yaw: 0, pitch: -89 },
  { name: "on-grate-ahead", pos: [9.0, 1.65, 3.0], yaw: 180, pitch: -55 },
  { name: "on-grate-machine", pos: [9.2, 1.65, 3.8], yaw: -90, pitch: -45 },
  { name: "before-glancing", pos: [9.55, 1.65, 1.0], yaw: 180, pitch: -22 },
  {
    name: "before-very-glancing",
    pos: [9.55, 1.65, 0.0],
    yaw: 180,
    pitch: -12,
  },
  { name: "south-glancing", pos: [9.55, 1.65, 7.2], yaw: 0, pitch: -25 },
  { name: "crouch-edge", pos: [9.0, 0.85, 2.3], yaw: 180, pitch: -50 },
  { name: "crouch-edge-west", pos: [8.7, 0.85, 2.35], yaw: 160, pitch: -65 },
  { name: "crouch-low", pos: [10.0, 0.6, 2.2], yaw: 200, pitch: -20 },
];

const session = await launchGame({ width: 1280, height: 960 });
const lines: string[] = [];
try {
  await session.evaluate("__harness.step(5)");
  const shoot = async (pos: V, yaw: number, pitch: number): Promise<string> =>
    session.evaluate<string>(`(() => {
      const h = window.__harness;
      h.setCamera({ position: { x: ${pos[0]}, y: ${pos[1]}, z: ${pos[2]} }, yawDeg: ${yaw}, pitchDeg: ${pitch} });
      return h.capture();
    })()`);
  const stats = (a: string, b: string) =>
    session.evaluate<{ magenta: number; changed: number }>(`(async () => {
      const load = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = src; });
      const pix = async (src) => {
        const img = await load(src);
        const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
        const x = c.getContext("2d"); x.drawImage(img, 0, 0);
        return x.getImageData(0, 0, c.width, c.height).data;
      };
      const p = await pix(${JSON.stringify(a)});
      const q = await pix(${JSON.stringify(b)});
      let magenta = 0, changed = 0;
      for (let i = 0; i < p.length; i += 4) {
        if (p[i] > 240 && p[i+1] < 15 && p[i+2] > 240) magenta++;
        if (p[i] !== q[i] || p[i+1] !== q[i+1] || p[i+2] !== q[i+2]) changed++;
      }
      return { magenta, changed };
    })()`);
  const save = (path: string, url: string) =>
    Bun.write(path, Buffer.from(url.split(",")[1], "base64"));

  for (const view of ["none", "material", "coverage"]) {
    await session.evaluate(`__harness.setDebugView(${JSON.stringify(view)})`);
    for (const c of cams) {
      const a = await shoot(c.pos, c.yaw, c.pitch);
      const b = await shoot(
        [c.pos[0] + 0.002, c.pos[1] + 0.002, c.pos[2] + 0.002],
        c.yaw,
        c.pitch,
      );
      await save(`${outDir}/${c.name}-${view}.png`, a);
      const s = await stats(a, b);
      lines.push(
        `${view.padEnd(9)} ${c.name.padEnd(22)} magenta ${s.magenta}  changed after 2 mm ${s.changed}`,
      );
    }
  }
  await session.evaluate('__harness.setDebugView("none")');
  await session.evaluate("__harness.setCamera(null)");

  // Physics: a 0.5 m crate dropped from 3 m and thrown down at 15 m/s. The
  // corridor ceiling is at 2.8 m, so the 3 m drop starts just under it with
  // the speed it would have gained over the missing 0.75 m.
  const v3m = -Math.sqrt(2 * 9.81 * 0.75);
  const trials: { name: string; at: V; vel: V }[] = [
    { name: "drop 3 m, middle", at: [9.3, 2.5, 4.0], vel: [0, v3m, 0] },
    { name: "drop 3 m, over beam", at: [9.3, 2.5, 3.5], vel: [0, v3m, 0] },
    { name: "drop 3 m, near edge", at: [8.6, 2.5, 2.8], vel: [0, v3m, 0] },
    { name: "throw 15 m/s down", at: [9.3, 1.5, 4.0], vel: [0, -15, 0] },
    { name: "throw 15 m/s down, beam", at: [9.3, 1.5, 4.5], vel: [0, -15, 0] },
    { name: "throw 15 m/s angled", at: [9.0, 1.6, 3.0], vel: [2, -14, 4] },
    { name: "throw 25 m/s down", at: [9.3, 2.0, 4.2], vel: [0, -25, 0] },
  ];
  for (const t of trials) {
    const r = await session.evaluate<{ y: number; min: number }>(`(() => {
      const g = window.__game;
      const b = g.physics.bodies().find((x) => x.tag === "crate_wood_small");
      g.physics.setBodyPose(b.id, { x: ${t.at[0]}, y: ${t.at[1]}, z: ${t.at[2]} }, { x: 0, y: 0, z: 0, w: 1 });
      g.physics.setBodyVelocity(b.id, { x: ${t.vel[0]}, y: ${t.vel[1]}, z: ${t.vel[2]} }, { x: 0, y: 0, z: 0 });
      let min = Infinity;
      for (let i = 0; i < 180; i++) {
        __harness.step(1);
        min = Math.min(min, g.physics.getBody(b.id).position.y);
      }
      return { y: g.physics.getBody(b.id).position.y, min };
    })()`);
    // Resting on the grate, the centre is half the crate height above y = 0.
    const ok = r.min > 0.25 - GRATE_THICKNESS;
    lines.push(
      `${t.name.padEnd(26)} rest y ${r.y.toFixed(3)}  lowest ${r.min.toFixed(3)}  ${ok ? "OK" : "FELL THROUGH"}`,
    );
  }
} finally {
  await session.close();
}
console.log(lines.join("\n"));
