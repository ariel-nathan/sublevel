// Dev script: screenshots the renderer demo with and without bounds on the
// flickering light. usage: bun src/render/boundsdemo.ts <outdir>
import { launchGame } from "../../tools/browser";
const dir = process.argv[2] ?? "out/bounds";
for (const bounds of [0, 1]) {
  const s = await launchGame({
    page: "demos/render.html",
    query: `h=360&t=0&bounds=${bounds}&view=lighting`,
  });
  await new Promise((r) => setTimeout(r, 1500));
  await s.screenshot(`${dir}/demo-bounds${bounds}.png`);
  console.log(s.consoleLines.join("\n"));
  await s.close();
}
