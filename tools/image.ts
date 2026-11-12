/**
 * Pure RGBA image helpers for the tools: a tiny 3x5 bitmap font, contact
 * sheets and image differences. No browser, no file access.
 */
import type { DecodedPng } from "./png";

export type Image = DecodedPng;
export type Rgb = readonly [number, number, number];

export function createImage(
  width: number,
  height: number,
  fill: Rgb = [0, 0, 0],
): Image {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = fill[0];
    rgba[i * 4 + 1] = fill[1];
    rgba[i * 4 + 2] = fill[2];
    rgba[i * 4 + 3] = 255;
  }
  return { width, height, rgba };
}

export function fillRect(
  image: Image,
  x: number,
  y: number,
  w: number,
  h: number,
  colour: Rgb,
): void {
  for (let yy = Math.max(0, y); yy < Math.min(image.height, y + h); yy++) {
    for (let xx = Math.max(0, x); xx < Math.min(image.width, x + w); xx++) {
      const i = (yy * image.width + xx) * 4;
      image.rgba[i] = colour[0];
      image.rgba[i + 1] = colour[1];
      image.rgba[i + 2] = colour[2];
      image.rgba[i + 3] = 255;
    }
  }
}

/** Copies `src` into `dst` with its top-left corner at (x, y). */
export function blit(dst: Image, src: Image, x: number, y: number): void {
  for (let sy = 0; sy < src.height; sy++) {
    const dy = y + sy;
    if (dy < 0 || dy >= dst.height) {
      continue;
    }
    for (let sx = 0; sx < src.width; sx++) {
      const dx = x + sx;
      if (dx < 0 || dx >= dst.width) {
        continue;
      }
      const s = (sy * src.width + sx) * 4;
      const d = (dy * dst.width + dx) * 4;
      dst.rgba[d] = src.rgba[s];
      dst.rgba[d + 1] = src.rgba[s + 1];
      dst.rgba[d + 2] = src.rgba[s + 2];
      dst.rgba[d + 3] = 255;
    }
  }
}

/** Outline of a rectangle, `thickness` px, inside the given bounds. */
export function strokeRect(
  image: Image,
  x: number,
  y: number,
  w: number,
  h: number,
  colour: Rgb,
  thickness = 1,
): void {
  fillRect(image, x, y, w, thickness, colour);
  fillRect(image, x, y + h - thickness, w, thickness, colour);
  fillRect(image, x, y, thickness, h, colour);
  fillRect(image, x + w - thickness, y, thickness, h, colour);
}

// --- 3x5 font -----------------------------------------------------------------

const GLYPHS: Record<string, string> = {
  "0": "###/#.#/#.#/#.#/###",
  "1": ".#./##./.#./.#./###",
  "2": "###/..#/###/#../###",
  "3": "###/..#/###/..#/###",
  "4": "#.#/#.#/###/..#/..#",
  "5": "###/#../###/..#/###",
  "6": "###/#../###/#.#/###",
  "7": "###/..#/.#./.#./.#.",
  "8": "###/#.#/###/#.#/###",
  "9": "###/#.#/###/..#/###",
  A: ".#./#.#/###/#.#/#.#",
  B: "##./#.#/##./#.#/##.",
  C: ".##/#../#../#../.##",
  D: "##./#.#/#.#/#.#/##.",
  E: "###/#../##./#../###",
  F: "###/#../##./#../#..",
  G: ".##/#../#.#/#.#/.##",
  H: "#.#/#.#/###/#.#/#.#",
  I: "###/.#./.#./.#./###",
  J: "..#/..#/..#/#.#/.#.",
  K: "#.#/#.#/##./#.#/#.#",
  L: "#../#../#../#../###",
  M: "#.#/###/###/#.#/#.#",
  N: "###/#.#/#.#/#.#/#.#",
  O: ".#./#.#/#.#/#.#/.#.",
  P: "##./#.#/##./#../#..",
  Q: ".#./#.#/#.#/###/.##",
  R: "##./#.#/##./#.#/#.#",
  S: ".##/#../.#./..#/##.",
  T: "###/.#./.#./.#./.#.",
  U: "#.#/#.#/#.#/#.#/###",
  V: "#.#/#.#/#.#/#.#/.#.",
  W: "#.#/#.#/###/###/#.#",
  X: "#.#/#.#/.#./#.#/#.#",
  Y: "#.#/#.#/.#./.#./.#.",
  Z: "###/..#/.#./#../###",
  "-": ".../.../###/.../...",
  _: ".../.../.../.../###",
  ".": ".../.../.../.../.#.",
  ":": ".../.#./.../.#./...",
  "/": "..#/..#/.#./#../#..",
  "%": "#.#/..#/.#./#../#.#",
  "+": ".../.#./###/.#./...",
  " ": ".../.../.../.../...",
};

/** Width in pixels of `text` drawn at `scale`. */
export function textWidth(text: string, scale = 1): number {
  return text.length === 0 ? 0 : (text.length * 4 - 1) * scale;
}

/** Draws `text` (letters are upper-cased; unknown characters are blank). */
export function drawText(
  image: Image,
  text: string,
  x: number,
  y: number,
  colour: Rgb,
  scale = 1,
): void {
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const rows = (GLYPHS[ch] ?? GLYPHS[" "]).split("/");
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 3; c++) {
        if (rows[r][c] === "#") {
          fillRect(image, cx + c * scale, y + r * scale, scale, scale, colour);
        }
      }
    }
    cx += 4 * scale;
  }
}

/** Draws text on a dark box so it stays readable over any picture. */
export function drawLabel(
  image: Image,
  text: string,
  x: number,
  y: number,
  scale = 2,
): void {
  const pad = scale;
  fillRect(
    image,
    x,
    y,
    textWidth(text, scale) + pad * 2,
    5 * scale + pad * 2,
    [0, 0, 0],
  );
  drawText(image, text, x + pad, y + pad, [255, 255, 255], scale);
}

// --- Contact sheets -------------------------------------------------------------

export interface SheetItem {
  image: Image;
  label: string;
}

export interface Sheet {
  image: Image;
  /** Which items (by index) are in this sheet, row-major. */
  items: number[];
}

/**
 * Lays frames out in a grid with a thin separator and a label stamped in the
 * corner of each. Splits into several sheets of at most `rows` rows.
 * All frames are assumed to be the same size as the first.
 */
export function contactSheets(
  items: readonly SheetItem[],
  options: { cols?: number; rows?: number; separator?: number } = {},
): Sheet[] {
  const cols = options.cols ?? 3;
  const rows = options.rows ?? 4;
  const gap = options.separator ?? 2;
  if (items.length === 0) {
    return [];
  }
  const cellW = items[0].image.width;
  const cellH = items[0].image.height;
  const perSheet = cols * rows;
  const sheets: Sheet[] = [];
  for (let start = 0; start < items.length; start += perSheet) {
    const chunk = items.slice(start, start + perSheet);
    const usedRows = Math.ceil(chunk.length / cols);
    const usedCols = Math.min(cols, chunk.length);
    const image = createImage(
      usedCols * cellW + (usedCols + 1) * gap,
      usedRows * cellH + (usedRows + 1) * gap,
      [40, 40, 48],
    );
    chunk.forEach((item, i) => {
      const x = gap + (i % cols) * (cellW + gap);
      const y = gap + Math.floor(i / cols) * (cellH + gap);
      blit(image, item.image, x, y);
      drawLabel(image, item.label, x, y, 2);
    });
    sheets.push({
      image,
      items: chunk.map((_, i) => start + i),
    });
  }
  return sheets;
}

// --- Differences ----------------------------------------------------------------

export interface DiffResult {
  /** Amplified absolute difference, greyscale-ish, same size as the inputs. */
  image: Image;
  changedPixels: number;
  changedPercent: number;
}

/** Largest per-channel difference at one pixel. */
export function pixelDelta(a: Image, b: Image, pixel: number): number {
  const i = pixel * 4;
  return Math.max(
    Math.abs(a.rgba[i] - b.rgba[i]),
    Math.abs(a.rgba[i + 1] - b.rgba[i + 1]),
    Math.abs(a.rgba[i + 2] - b.rgba[i + 2]),
  );
}

/**
 * Compares two same-size images. A pixel counts as changed when any channel
 * differs by more than `threshold`. The picture shows the difference times
 * `gain` (changed pixels are at least dim red so tiny changes stay visible).
 */
export function diffImages(
  a: Image,
  b: Image,
  options: { threshold?: number; gain?: number } = {},
): DiffResult {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error("diffImages: image sizes differ");
  }
  const threshold = options.threshold ?? 2;
  const gain = options.gain ?? 8;
  const image = createImage(a.width, a.height);
  let changed = 0;
  const count = a.width * a.height;
  for (let p = 0; p < count; p++) {
    const delta = pixelDelta(a, b, p);
    const i = p * 4;
    const level = Math.min(255, delta * gain);
    if (delta > threshold) {
      changed++;
      image.rgba[i] = Math.max(level, 90);
      image.rgba[i + 1] = level;
      image.rgba[i + 2] = level;
    } else {
      image.rgba[i] = level;
      image.rgba[i + 1] = level;
      image.rgba[i + 2] = level;
    }
  }
  return {
    image,
    changedPixels: changed,
    changedPercent: count === 0 ? 0 : (changed / count) * 100,
  };
}

/** Places images side by side with a separator. */
export function hstack(images: readonly Image[], gap = 2): Image {
  const height = Math.max(...images.map((image) => image.height));
  const width =
    images.reduce((sum, image) => sum + image.width, 0) +
    gap * (images.length + 1);
  const out = createImage(width, height + gap * 2, [40, 40, 48]);
  let x = gap;
  for (const image of images) {
    blit(out, image, x, gap);
    x += image.width + gap;
  }
  return out;
}

/** Stacks images vertically with a separator, left-aligned. */
export function vstack(images: readonly Image[], gap = 2): Image {
  const width = Math.max(...images.map((image) => image.width));
  const height =
    images.reduce((sum, image) => sum + image.height, 0) +
    gap * (images.length + 1);
  const out = createImage(width + gap * 2, height, [40, 40, 48]);
  let y = gap;
  for (const image of images) {
    blit(out, image, gap, y);
    y += image.height + gap;
  }
  return out;
}
