// Dev-only: captures every debug view from a few cameras into out/render/.
// Usage: bun src/render/debug-preview.ts [outDir] [views,comma]
import { launchGame } from "../../tools/browser";

const outDir = process.argv[2] ?? "out/render";
const views = (
  process.argv[3] ?? "none,coverage,material,depth,normals,lighting"
).split(",");
const cameras = [
  { position: { x: 1.6, y: 1.6, z: 0.3 }, yawDeg: -90, pitchDeg: 0 },
  { position: { x: 5, y: 1.65, z: 0 }, yawDeg: -90, pitchDeg: 0 },
  { position: { x: 6.2, y: 3.2, z: 8.6 }, yawDeg: -135, pitchDeg: -22 },
];
const session = await launchGame();
try {
  await session.evaluate("__harness.step(30)");
  for (const view of views) {
    for (let i = 0; i < cameras.length; i++) {
      await session.evaluate(
        `__harness.setCamera(${JSON.stringify(cameras[i])})`,
      );
      await session.evaluate(`__harness.setDebugView(${JSON.stringify(view)})`);
      await session.captureFrame(`${outDir}/${view}-${i}.png`);
    }
  }
  const bad = session.consoleLines.filter((l) => /error|warn/i.test(l));
  console.log(bad.length ? bad.join("\n") : "console clean");
} finally {
  await session.close();
}
