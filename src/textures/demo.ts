import { createTextureSet } from "./index";
import { buildSheet } from "./sheet";

const set = createTextureSet(1998);
const sheet = buildSheet(set, {
  scale: 2,
  tiles: 2,
  columns: 4,
  gap: 16,
  labelHeight: 20,
});
const canvas = document.getElementById("sheet") as HTMLCanvasElement;
canvas.width = sheet.width;
canvas.height = sheet.height;
const ctx = canvas.getContext("2d");
if (ctx) {
  ctx.putImageData(
    new ImageData(new Uint8ClampedArray(sheet.rgba), sheet.width, sheet.height),
    0,
    0,
  );
  ctx.font = "14px monospace";
  ctx.fillStyle = "#fff";
  for (const cell of sheet.cells) {
    const tex = set.get(cell.material);
    ctx.fillText(
      `${cell.material} (${tex?.size})`,
      cell.x,
      cell.y + cell.h + 15,
    );
  }
}
