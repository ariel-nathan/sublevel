/** Measures pixel crawl: how much of the image flickers during a slow turn. */
import { launchGame } from "./browser";
import { decodePng } from "./png";

const VIEWS = [
  { name: "lab-door", x: 1.6, y: 1.6, z: 0.3, yaw: -90, pitch: 0 },
  { name: "corridor", x: 5, y: 1.65, z: 0, yaw: -90, pitch: 0 },
  { name: "storage", x: 9.55, y: 1.65, z: 8.4, yaw: 180, pitch: 0 },
];
const STEPS = 24;
const STEP_DEG = 0.04;

const s = await launchGame({ width: 1920, height: 1080 });
try {
  await s.evaluate("__harness.step(10)");
  console.log(
    "internal size:",
    await s.evaluate("JSON.stringify(__harness.size())"),
  );
  for (const view of VIEWS) {
    let previous: Uint8Array | null = null;
    let changed = 0;
    let strong = 0;
    let total = 0;
    for (let i = 0; i <= STEPS; i++) {
      const yaw = view.yaw + i * STEP_DEG;
      const dataUrl = await s.evaluate<string>(
        `(__harness.setCamera({position:{x:${view.x},y:${view.y},z:${view.z}},yawDeg:${yaw},pitchDeg:${view.pitch}}), __harness.capture())`,
      );
      const png = decodePng(
        new Uint8Array(
          Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"),
        ),
      );
      const pixels = png.rgba;
      if (previous) {
        for (let p = 0; p < pixels.length; p += 4) {
          const d = Math.max(
            Math.abs(pixels[p] - previous[p]),
            Math.abs(pixels[p + 1] - previous[p + 1]),
            Math.abs(pixels[p + 2] - previous[p + 2]),
          );
          if (d > 12) changed++;
          if (d > 48) strong++;
          total++;
        }
      }
      previous = pixels;
    }
    console.log(
      `${view.name.padEnd(10)} changed ${((100 * changed) / total).toFixed(2)}%  strongly changed ${((100 * strong) / total).toFixed(2)}%  (per ${STEP_DEG} degree step)`,
    );
  }
} finally {
  await s.close();
}
