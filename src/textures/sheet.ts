import type { TextureSet } from "../core/api";
import { MATERIAL_IDS, type MaterialId } from "../core/materials";

export interface SheetOptions {
  /** Upscale factor per texel. */
  scale: number;
  /** How many times each texture is tiled in both directions. */
  tiles: number;
  columns: number;
  gap: number;
  /** Extra space under each cell (for labels in the browser demo). */
  labelHeight: number;
  /** Subset and order of materials. */
  only?: readonly MaterialId[];
}

export interface Sheet {
  width: number;
  height: number;
  rgba: Uint8Array;
  /** Pixel rectangle of each cell, in order. */
  cells: { material: MaterialId; x: number; y: number; w: number; h: number }[];
}

/** Lays textures out in a grid, each tiled and enlarged with nearest-neighbour. */
export function buildSheet(set: TextureSet, opts: SheetOptions): Sheet {
  const ids = opts.only ?? MATERIAL_IDS;
  const maxSize = Math.max(...ids.map((id) => set.get(id)?.size ?? 16));
  const cellW = maxSize * opts.tiles * opts.scale;
  const cellH = cellW + opts.labelHeight;
  const rows = Math.ceil(ids.length / opts.columns);
  const width = opts.gap + opts.columns * (cellW + opts.gap);
  const height = opts.gap + rows * (cellH + opts.gap);
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = 110;
    rgba[i * 4 + 1] = 110;
    rgba[i * 4 + 2] = 112;
    rgba[i * 4 + 3] = 255;
  }
  const cells: Sheet["cells"] = [];
  ids.forEach((id, index) => {
    const tex = set.get(id);
    if (!tex) return;
    const ox = opts.gap + (index % opts.columns) * (cellW + opts.gap);
    const oy = opts.gap + Math.floor(index / opts.columns) * (cellH + opts.gap);
    const w = tex.size * opts.tiles * opts.scale;
    for (let y = 0; y < w; y++) {
      const sy = Math.floor(y / opts.scale) % tex.size;
      for (let x = 0; x < w; x++) {
        const sx = Math.floor(x / opts.scale) % tex.size;
        const s = (sy * tex.size + sx) * 4;
        const d = ((oy + y) * width + ox + x) * 4;
        // cut-out holes show a dark checker so they are visible on the sheet
        const a = tex.pixels[s + 3] >= 128 ? 1 : 0;
        const checker = ((x >> 3) + (y >> 3)) % 2 === 0 ? 34 : 54;
        rgba[d] = a ? tex.pixels[s] : checker;
        rgba[d + 1] = a ? tex.pixels[s + 1] : checker;
        rgba[d + 2] = a ? tex.pixels[s + 2] : checker + 4;
        rgba[d + 3] = 255;
      }
    }
    cells.push({ material: id, x: ox, y: oy, w, h: w });
  });
  return { width, height, rgba, cells };
}
