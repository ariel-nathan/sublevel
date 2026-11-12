// Dev-only: exact pixel checks of the debug views (colour histograms).
import { launchGame } from "../../tools/browser";

const cameras = [
  { position: { x: 1.6, y: 1.6, z: 0.3 }, yawDeg: -90, pitchDeg: 0 },
  { position: { x: 5, y: 1.65, z: 0 }, yawDeg: -90, pitchDeg: 0 },
  { position: { x: 6.2, y: 3.2, z: 8.6 }, yawDeg: -135, pitchDeg: -22 },
];
const session = await launchGame();
try {
  await session.evaluate("__harness.step(30)");
  for (const view of ["coverage", "material", "depth", "normals"]) {
    for (let i = 0; i < cameras.length; i++) {
      await session.evaluate(
        `__harness.setCamera(${JSON.stringify(cameras[i])})`,
      );
      await session.evaluate(`__harness.setDebugView("${view}")`);
      const hist = await session.evaluate<string>(`(async () => {
        const img = new Image();
        img.src = __harness.capture();
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width; c.height = img.height;
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        const h = new Map();
        for (let p = 0; p < d.length; p += 4) {
          const k = d[p] + "," + d[p+1] + "," + d[p+2];
          h.set(k, (h.get(k) ?? 0) + 1);
        }
        const sorted = [...h.entries()].sort((a, b) => b[1] - a[1]);
        return JSON.stringify({ distinct: h.size, top: sorted.slice(0, 30) });
      })()`);
      console.log(view, i, hist.slice(0, 700));
    }
  }
} finally {
  await session.close();
}
