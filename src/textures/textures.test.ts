import { describe, expect, test } from "bun:test";
import { MATERIALS, MATERIAL_IDS } from "../core/materials";
import { createTextureSet } from "./index";

const set = createTextureSet(7);

function px(img: { size: number; pixels: Uint8Array }, x: number, y: number) {
  const i = (y * img.size + x) * 4;
  return [img.pixels[i], img.pixels[i + 1], img.pixels[i + 2]];
}

function solid(
  img: { size: number; pixels: Uint8Array },
  x: number,
  y: number,
) {
  return img.pixels[(y * img.size + x) * 4 + 3] === 255;
}

function diff(a: number[], b: number[]): number {
  return (
    (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3
  );
}

describe("textures", () => {
  test("every material has a valid image", () => {
    for (const id of MATERIAL_IDS) {
      const img = set.get(id);
      expect(img).toBeDefined();
      if (!img) continue;
      expect(img.material).toBe(id);
      expect(Number.isInteger(Math.log2(img.size))).toBe(true);
      expect(img.size).toBeGreaterThanOrEqual(16);
      expect(img.size).toBeLessThanOrEqual(128);
      expect(img.pixels.length).toBe(img.size * img.size * 4);
      for (let i = 3; i < img.pixels.length; i += 4) {
        // only the grating has real openings, and alpha is strictly 0 or 255
        if (id === "metal_grate") expect([0, 255]).toContain(img.pixels[i]);
        else expect(img.pixels[i]).toBe(255);
      }
    }
  });

  test("deterministic per seed, varies across seeds", () => {
    const again = createTextureSet(7);
    const other = createTextureSet(8);
    let changed = 0;
    for (const id of MATERIAL_IDS) {
      expect(again.get(id)?.pixels).toEqual(set.get(id)?.pixels);
      const a = set.get(id)?.pixels;
      const b = other.get(id)?.pixels;
      if (a && b && a.some((v, i) => v !== b[i])) changed++;
    }
    expect(changed).toBeGreaterThan(5);
  });

  test("tiles seamlessly", () => {
    for (const id of MATERIAL_IDS) {
      const img = set.get(id);
      if (!img) continue;
      const n = img.size;
      let wrapX = 0;
      let wrapY = 0;
      let inX = 0;
      let inY = 0;
      // colour under a cut-out hole is meaningless: compare solid pairs only
      const d = (x0: number, y0: number, x1: number, y1: number) =>
        solid(img, x0, y0) && solid(img, x1, y1)
          ? diff(px(img, x0, y0), px(img, x1, y1))
          : 0;
      for (let i = 0; i < n; i++) {
        wrapX += d(n - 1, i, 0, i);
        wrapY += d(i, n - 1, i, 0);
        for (let j = 0; j < n - 1; j++) {
          inX += d(j, i, j + 1, i);
          inY += d(i, j, i, j + 1);
        }
      }
      wrapX /= n;
      wrapY /= n;
      inX /= n * (n - 1);
      inY /= n * (n - 1);
      expect(wrapX).toBeLessThanOrEqual(inX * 1.6 + 4);
      expect(wrapY).toBeLessThanOrEqual(inY * 1.6 + 4);
    }
  });

  test("grate: open fraction in range, bars thick, alpha tiles", () => {
    const img = set.get("metal_grate");
    expect(img).toBeDefined();
    if (!img) return;
    const n = img.size;
    const a = (x: number, y: number) => img.pixels[(y * n + x) * 4 + 3];
    let open = 0;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) if (a(x, y) === 0) open++;
    const frac = open / (n * n);
    expect(frac).toBeGreaterThanOrEqual(0.35);
    expect(frac).toBeLessThanOrEqual(0.5);
    // periodic with 16 texels in both directions, which divides the size: so
    // alpha tiles seamlessly across the wrap
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        expect(a(x, y)).toBe(a((x + 16) % n, y));
        expect(a(x, y)).toBe(a(x, (y + 16) % n));
      }
    }
    // every run of solid texels along a row is at least 2 wide
    for (let y = 0; y < n; y++) {
      let run = 0;
      for (let x = 0; x < 2 * n; x++) {
        if (a(x % n, y) === 255) run++;
        else {
          if (run > 0) expect(run).toBeGreaterThanOrEqual(2);
          run = 0;
        }
      }
    }
  });

  test("lab_wall is a full-height 128 section", () => {
    expect(set.get("lab_wall")?.size).toBe(128);
  });

  test("not flat, sane palette, brightness by emissiveness", () => {
    for (const id of MATERIAL_IDS) {
      const img = set.get(id);
      if (!img) continue;
      const colours = new Set<number>();
      let sum = 0;
      let sumSq = 0;
      let maxSum = 0;
      let blown = 0;
      const count = img.size * img.size;
      for (let i = 0; i < count; i++) {
        const r = img.pixels[i * 4];
        const g = img.pixels[i * 4 + 1];
        const b = img.pixels[i * 4 + 2];
        colours.add((r << 16) | (g << 8) | b);
        const l = 0.3 * r + 0.59 * g + 0.11 * b;
        sum += l;
        sumSq += l * l;
        maxSum += Math.max(r, g, b);
        if (r > 250 && g > 250 && b > 250) blown++;
      }
      const mean = sum / count;
      expect(sumSq / count - mean * mean).toBeGreaterThan(4);
      expect(colours.size).toBeGreaterThanOrEqual(5);
      expect(colours.size).toBeLessThanOrEqual(32);
      expect(blown).toBe(0);
      if (MATERIALS[id].emissive) {
        expect(maxSum / count).toBeGreaterThan(85);
      } else {
        expect(mean).toBeLessThan(225);
      }
    }
  });

  test("generates quickly", () => {
    const start = performance.now();
    createTextureSet(99);
    expect(performance.now() - start).toBeLessThan(1500);
  });
});
