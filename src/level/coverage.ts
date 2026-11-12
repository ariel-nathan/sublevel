/**
 * Dev-only hole finder (run with `bun src/level/coverage.ts [outDir]`). Not
 * imported by the game.
 *
 * Uses the renderer's "coverage" debug view (geometry white on pure magenta)
 * and counts magenta pixels: every one is a missing face. Checks three fixed
 * reference cameras, then a sweep of positions in every room at crouch, eye
 * and jump height looking in eight directions and up/down, with both doors
 * closed and then open. Images with holes are written to `outDir`.
 */
import { launchGame } from "../../tools/browser";

type V = [number, number, number];
const outDir = process.argv[2] ?? "out/coverage";

const reference: { name: string; pos: V; yaw: number; pitch: number }[] = [
  { name: "ref-lab", pos: [1.6, 1.6, 0.3], yaw: -90, pitch: 0 },
  { name: "ref-corridor", pos: [5, 1.65, 0], yaw: -90, pitch: 0 },
  { name: "ref-storage", pos: [6.2, 3.2, 8.6], yaw: -135, pitch: -22 },
];

/** Floor positions in player-reachable air (x, z) and their floor height. */
const spots: [number, number, number][] = [
  [-3, -1.8, 0],
  [-2, 1.6, 0],
  [0, -1.5, 0],
  [0, 1.5, 0],
  [2.5, -1.5, 0],
  [3.4, 0, 0],
  [3.4, 1.8, 0],
  [3.4, -1.9, 0],
  [-3.4, 2.2, 0],
  [4.15, 0, 0],
  [5, 0, 0],
  [6.5, 0.6, 0],
  [8, -0.5, 0],
  [9.5, 0, 0],
  [9.5, 2.5, 0],
  [9.5, 4.5, 0],
  [9.5, 7, 0],
  [9.5, 8.5, 0],
  [7, 9.5, 0],
  [8.5, 12, 0],
  [11, 11, 0],
  [12.5, 13, 0],
  [10, 14, 0],
  [12.5, 10.3, 0],
  [13.65, 12, 0],
  [14.5, 12, 0],
  [15.3, 11.5, 0],
  [7, 15, 1.4],
  [6, 14.2, 1.4],
];
const heights = [0.6, 1.6, 2.2];
/** Doorway spots stay below the lintel. */
const cap = (x: number): number => (x === 4.15 || x === 13.65 ? 2.0 : 9);

const session = await launchGame({ width: 1280, height: 960 });
const results: string[] = [];
try {
  await session.evaluate("__harness.step(5)");
  await session.evaluate('__harness.setDebugView("coverage")');
  const shoot = async (name: string, pos: V, yaw: number, pitch: number) => {
    const r = await session.evaluate<{
      n: number;
      url: string | null;
    }>(`(async () => {
      const h = window.__harness;
      h.setCamera({ position: { x: ${pos[0]}, y: ${pos[1]}, z: ${pos[2]} }, yawDeg: ${yaw}, pitchDeg: ${pitch} });
      const url = h.capture();
      const img = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = url; });
      const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
      const x = c.getContext("2d"); x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 240 && d[i+1] < 15 && d[i+2] > 240) n++;
      return { n, url: n > 0 ? url : null };
    })()`);
    if (r.url) {
      await Bun.write(
        `${outDir}/${name}.png`,
        Buffer.from(r.url.split(",")[1], "base64"),
      );
    }
    return r.n;
  };
  const sweep = async (state: string) => {
    for (const ref of reference) {
      const n = await shoot(
        `${ref.name}-${state}`,
        ref.pos,
        ref.yaw,
        ref.pitch,
      );
      results.push(`${ref.name}-${state}: ${n}`);
    }
    let total = 0;
    let views = 0;
    for (const [x, z, floor] of spots) {
      for (const h of heights) {
        for (let k = 0; k < 8; k++) {
          for (const pitch of [-40, 0, 40]) {
            const name = `${state}-${x}_${Math.min(floor + h, cap(x))}_${z}-y${k * 45}-p${pitch}`;
            const n = await shoot(
              name,
              [x, Math.min(floor + h, cap(x)), z],
              k * 45,
              pitch,
            );
            views++;
            total += n;
            if (n > 0) results.push(`${name}: ${n}`);
          }
        }
        for (const pitch of [-89, 89]) {
          const name = `${state}-${x}_${Math.min(floor + h, cap(x))}_${z}-p${pitch}`;
          const n = await shoot(
            name,
            [x, Math.min(floor + h, cap(x)), z],
            0,
            pitch,
          );
          views++;
          total += n;
          if (n > 0) results.push(`${name}: ${n}`);
        }
      }
    }
    results.push(`${state}: ${views} views, ${total} magenta px in total`);
  };
  await sweep("closed");
  await session.evaluate(`(() => {
    const g = window.__game;
    const b = g.level.data.buttons[0].position;
    g.world.use({ collider: { kind: "static", id: 0 }, point: b,
      normal: { x: -1, y: 0, z: 0 }, distance: 1 });
    const crate = g.physics.bodies().find((x) => x.tag === "crate_metal");
    const p = g.level.data.plates[0].box;
    g.physics.setBodyPose(crate.id, { x: (p.min.x + p.max.x) / 2,
      y: p.max.y + crate.halfExtents.y + 0.01, z: (p.min.z + p.max.z) / 2 });
    __harness.step(240);
  })()`);
  await sweep("open");
} finally {
  await session.close();
}
console.log(results.join("\n"));
