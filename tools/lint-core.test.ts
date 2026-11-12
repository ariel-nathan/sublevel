import { describe, expect, test } from "bun:test";
import {
  annotate,
  clusterMask,
  countMask,
  distinctColours,
  looksLikeCoverage,
  looksLikeMaterial,
  magentaMask,
  removeSilhouetteCrawl,
  silhouetteMask,
  unstableMask,
} from "./lint-core";
import { createImage, fillRect, type Image, type Rgb } from "./image";

const RED = [200, 0, 0] as const;
const GREEN = [0, 200, 0] as const;
const BLUE = [0, 0, 200] as const;

/** Image split into a left half of `a` and a right half of `b`. */
function split(
  width: number,
  height: number,
  edge: number,
  a: Rgb,
  b: Rgb,
): Image {
  const image = createImage(width, height, a);
  fillRect(image, edge, 0, width - edge, height, b);
  return image;
}

describe("unstableMask", () => {
  test("flags only pixels that changed", () => {
    const base = createImage(8, 8, RED);
    const other = createImage(8, 8, RED);
    fillRect(other, 2, 3, 2, 2, GREEN);
    const mask = unstableMask(base, [other]);
    expect(countMask(mask)).toBe(4);
    expect(mask[3 * 8 + 2]).toBe(1);
    expect(mask[0]).toBe(0);
  });

  test("tolerance ignores small differences and any frame can flag", () => {
    const base = createImage(4, 4, [100, 100, 100]);
    const near = createImage(4, 4, [105, 100, 100]);
    const far = createImage(4, 4, [100, 100, 100]);
    fillRect(far, 0, 0, 1, 1, [100, 160, 100]);
    expect(countMask(unstableMask(base, [near], 10))).toBe(0);
    expect(countMask(unstableMask(base, [near, far], 10))).toBe(1);
    expect(countMask(unstableMask(base, [near], 0))).toBe(16);
  });

  test("rejects frames of different size", () => {
    expect(() =>
      unstableMask(createImage(4, 4), [createImage(5, 4)]),
    ).toThrow();
  });
});

describe("silhouetteMask", () => {
  test("marks both sides of a straight edge, nothing inside flat areas", () => {
    const image = split(10, 6, 5, RED, GREEN);
    const mask = silhouetteMask(image);
    for (let y = 0; y < 6; y++) {
      expect(mask[y * 10 + 4]).toBe(1);
      expect(mask[y * 10 + 5]).toBe(1);
      expect(mask[y * 10 + 2]).toBe(0);
      expect(mask[y * 10 + 8]).toBe(0);
    }
  });
});

describe("removeSilhouetteCrawl", () => {
  test("drops a one-pixel edge crawl but keeps interior instability", () => {
    const width = 20;
    const height = 12;
    const base = split(width, height, 10, RED, GREEN);
    const silhouette = silhouetteMask(base);
    // The edge moved by one pixel: column 10 now shows the other material.
    const unstable = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      unstable[y * width + 10] = 1;
    }
    // A blob in the middle of the red area, away from any edge.
    for (let y = 3; y < 7; y++) {
      for (let x = 2; x < 6; x++) {
        unstable[y * width + x] = 1;
      }
    }
    const kept = removeSilhouetteCrawl(unstable, silhouette, width, height);
    for (let y = 0; y < height; y++) {
      expect(kept[y * width + 10]).toBe(0);
    }
    expect(countMask(kept)).toBe(16);
  });

  test("keeps a dense unstable patch even when it straddles a material edge", () => {
    const width = 20;
    const height = 12;
    const base = split(width, height, 10, RED, GREEN);
    const silhouette = silhouetteMask(base);
    const unstable = new Uint8Array(width * height);
    for (let y = 3; y < 8; y++) {
      for (let x = 7; x < 14; x++) {
        unstable[y * width + x] = 1;
      }
    }
    const kept = removeSilhouetteCrawl(unstable, silhouette, width, height);
    expect(countMask(kept)).toBe(countMask(unstable));
  });
});

describe("clusterMask", () => {
  test("finds components with bounding boxes, largest first", () => {
    const width = 20;
    const height = 10;
    const mask = new Uint8Array(width * height);
    for (let x = 2; x < 7; x++) {
      mask[2 * width + x] = 1;
      mask[3 * width + x] = 1;
    }
    mask[8 * width + 15] = 1;
    const clusters = clusterMask(mask, width, height);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toEqual({
      pixels: 10,
      minX: 2,
      minY: 2,
      maxX: 6,
      maxY: 3,
    });
    expect(clusters[1]).toEqual({
      pixels: 1,
      minX: 15,
      minY: 8,
      maxX: 15,
      maxY: 8,
    });
  });

  test("8-connectivity joins diagonals, minSize filters, gap bridges holes", () => {
    const width = 10;
    const height = 10;
    const mask = new Uint8Array(width * height);
    mask[1 * width + 1] = 1;
    mask[2 * width + 2] = 1;
    mask[3 * width + 3] = 1;
    mask[3 * width + 6] = 1;
    expect(clusterMask(mask, width, height)).toHaveLength(2);
    expect(clusterMask(mask, width, height, { minSize: 2 })).toHaveLength(1);
    expect(clusterMask(mask, width, height, { gap: 2 })).toHaveLength(1);
  });

  test("handles an empty mask", () => {
    expect(clusterMask(new Uint8Array(16), 4, 4)).toEqual([]);
  });
});

describe("magenta and diagnostic view detection", () => {
  test("magentaMask matches exactly (255, 0, 255)", () => {
    const image = createImage(4, 4, [255, 255, 255]);
    fillRect(image, 1, 1, 2, 1, [255, 0, 255]);
    fillRect(image, 0, 0, 1, 1, [254, 0, 255]);
    expect(countMask(magentaMask(image))).toBe(2);
  });

  test("looksLikeCoverage: white and magenta only", () => {
    const image = createImage(20, 20, [255, 255, 255]);
    fillRect(image, 0, 0, 20, 4, [255, 0, 255]);
    expect(looksLikeCoverage(image)).toBe(true);
    fillRect(image, 0, 10, 20, 10, [120, 90, 60]);
    expect(looksLikeCoverage(image)).toBe(false);
  });

  test("a noisy lit frame is neither coverage nor material", () => {
    const image = createImage(40, 40);
    let seed = 7;
    for (let i = 0; i < image.rgba.length; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      image.rgba[i] = i % 4 === 3 ? 255 : seed >>> 24;
    }
    expect(looksLikeCoverage(image)).toBe(false);
    expect(looksLikeMaterial(image)).toBe(false);
    expect(distinctColours(image)).toBeGreaterThan(200);
  });

  test("a flat-colour frame looks like material view", () => {
    const image = split(40, 40, 20, RED, BLUE);
    expect(looksLikeMaterial(image)).toBe(true);
  });
});

describe("annotate", () => {
  test("paints flagged pixels red without touching the input", () => {
    const base = createImage(12, 12, [10, 20, 30]);
    const mask = new Uint8Array(144);
    mask[5 * 12 + 5] = 1;
    const out = annotate(base, mask, [
      { pixels: 1, minX: 5, minY: 5, maxX: 5, maxY: 5 },
    ]);
    expect(
      Array.from(out.rgba.slice((5 * 12 + 5) * 4, (5 * 12 + 5) * 4 + 3)),
    ).toEqual([255, 0, 0]);
    expect(Array.from(base.rgba.slice(0, 3))).toEqual([10, 20, 30]);
  });
});
