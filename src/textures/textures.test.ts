import { describe, expect, test } from "bun:test";
import { MATERIALS, MATERIAL_IDS } from "../core/materials";
import { createTextureSet } from "./index";

const set = createTextureSet(7);

function px(img: { size: number; pixels: Uint8Array }, x: number, y: number) {
  const i = (y * img.size + x) * 4;
  return [img.pixels[i], img.pixels[i + 1], img.pixels[i + 2]];
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
        expect(img.pixels[i]).toBe(255);
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
      for (let i = 0; i < n; i++) {
        wrapX += diff(px(img, n - 1, i), px(img, 0, i));
        wrapY += diff(px(img, i, n - 1), px(img, i, 0));
        for (let j = 0; j < n - 1; j++) {
          inX += diff(px(img, j, i), px(img, j + 1, i));
          inY += diff(px(img, i, j), px(img, i, j + 1));
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
