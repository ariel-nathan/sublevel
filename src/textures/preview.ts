/**
 * Dev-only: renders contact sheets to out/*.png.
 *   bun src/textures/preview.ts [seed]
 * Every texture is shown 4x, tiled 2x2, in MATERIAL_IDS order, left to right.
 */
import { MATERIAL_IDS, type MaterialId } from "../core/materials";
import { writePng } from "../../tools/png";
import { createTextureSet } from "./index";
import { buildSheet } from "./sheet";

const seed = Number(process.argv[2] ?? 1998);
const set = createTextureSet(seed);

const groups: Record<string, readonly MaterialId[]> = {
  textures: MATERIAL_IDS,
  textures_arch: [
    "concrete_wall",
    "concrete_floor",
    "ceiling_panel",
    "lab_wall",
    "lab_floor_tile",
    "metal_panel",
    "metal_grate",
    "hazard_stripe",
  ],
  textures_misc: [
    "door_steel",
    "pressure_plate",
    "sign_warning",
    "pipe",
    "plastic_white",
    "rubber_dark",
  ],
  textures_props: [
    "crate_wood",
    "crate_wood_weak",
    "crate_metal",
    "barrel_side",
    "barrel_top",
  ],
  textures_emissive: [
    "light_panel",
    "button_red",
    "button_green",
    "monitor_screen",
  ],
};

for (const [name, only] of Object.entries(groups)) {
  const big = name !== "textures";
  const sheet = buildSheet(set, {
    scale: big ? 4 : 2,
    tiles: 2,
    columns: big ? 3 : 6,
    gap: 8,
    labelHeight: 0,
    only,
  });
  await writePng(`out/${name}.png`, sheet.width, sheet.height, sheet.rgba);
}
console.log("grid order (row-major, 6 per row in textures.png):");
MATERIAL_IDS.forEach((id, i) => console.log(`${i}: ${id}`));
