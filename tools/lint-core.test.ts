import { describe, expect, test } from "bun:test";
import {
  annotate,
  clusterMask,
  countMask,
  distinctColours,
  looksLikeCoverage,
  looksLikeMaterial,
  magentaMask,
  unstableMask,
  andNotMask,
  closeMask,
  colourMask,
  dilateMask,
  discontinuityMask,
  erodeMask,
  findShimmer,
  openMask,
  stableBoundaryMask,
  stablePixels,
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

function maskOf(width: number, height: number, rects: number[][]): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (const [x, y, w, h] of rects) {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        mask[yy * width + xx] = 1;
      }
    }
  }
  return mask;
}

describe("morphology", () => {
  test("dilate and erode are box operations", () => {
    const mask = maskOf(9, 9, [[4, 4, 1, 1]]);
    expect(countMask(dilateMask(mask, 9, 9, 1))).toBe(9);
    expect(countMask(dilateMask(mask, 9, 9, 2))).toBe(25);
    const block = maskOf(9, 9, [[2, 2, 5, 5]]);
    expect(countMask(erodeMask(block, 9, 9, 1))).toBe(9);
    expect(countMask(erodeMask(block, 9, 9, 3))).toBe(0);
  });

  test("opening removes lines up to 2 px thick but keeps a 3 px block", () => {
    const mask = maskOf(30, 20, [
      [2, 2, 25, 1],
      [2, 6, 25, 2],
      [2, 10, 6, 6],
    ]);
    const opened = openMask(mask, 30, 20, 1);
    expect(countMask(opened.slice(0, 30 * 9))).toBe(0);
    expect(countMask(opened)).toBe(36);
  });

  test("closing fills one-pixel gaps and does not erode at the border", () => {
    const mask = maskOf(10, 10, [
      [0, 0, 4, 10],
      [5, 0, 5, 10],
    ]);
    expect(countMask(closeMask(mask, 10, 10, 1))).toBe(100);
  });
});

describe("edge rules", () => {
  test("discontinuityMask: a step is an edge, a smooth ramp is not (curvature)", () => {
    const ramp = createImage(20, 4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 20; x++) {
        const i = (y * 20 + x) * 4;
        ramp.rgba[i] = ramp.rgba[i + 1] = ramp.rgba[i + 2] = 100 + 3 * x;
      }
    }
    expect(countMask(discontinuityMask(ramp, 2, true))).toBe(0);
    expect(countMask(discontinuityMask(ramp, 2, false))).toBe(80);
    const step = split(20, 4, 10, [100, 100, 100], [160, 160, 160]);
    const edge = discontinuityMask(step, 2, true);
    expect(edge[1 * 20 + 9]).toBe(1);
    expect(edge[1 * 20 + 10]).toBe(1);
    expect(edge[1 * 20 + 3]).toBe(0);
  });

  test("stable boundaries ignore pixels that move", () => {
    const base = split(10, 4, 5, RED, GREEN);
    const moved = split(10, 4, 4, RED, GREEN);
    const stable = stablePixels([base, moved]);
    expect(stable[0 * 10 + 4]).toBe(0);
    expect(countMask(stableBoundaryMask(base, stable))).toBe(0);
    const still = stablePixels([base, split(10, 4, 5, RED, GREEN)]);
    expect(countMask(stableBoundaryMask(base, still))).toBe(8);
  });

  test("colourMask finds a colour in any frame", () => {
    const a = createImage(4, 4, RED);
    const b = createImage(4, 4, RED);
    fillRect(b, 1, 1, 2, 2, BLUE);
    expect(countMask(colourMask([a, b], [BLUE]))).toBe(4);
    expect(countMask(colourMask([a], [BLUE]))).toBe(0);
  });
});

describe("findShimmer", () => {
  const W = 48;
  const H = 32;
  /** Depth grey ramp (smooth), optionally with a step at column `edge`. */
  function depthImage(edge?: number): Image {
    const image = createImage(W, H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v =
          120 + Math.floor(x / 8) + (edge !== undefined && x >= edge ? 60 : 0);
        const i = (y * W + x) * 4;
        image.rgba[i] = image.rgba[i + 1] = image.rgba[i + 2] = v;
      }
    }
    return image;
  }
  const flatNormals = (): Image => createImage(W, H, [128, 255, 128]);
  /** Deterministic pseudo-random bit. */
  const noise = (x: number, y: number, frame: number): boolean => {
    let h = (x * 374761393 + y * 668265263 + frame * 2147483647) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    return ((h ^ (h >>> 16)) & 1) === 1;
  };
  const run = (
    base: Image,
    jittered: Image[],
    depth = depthImage(),
    normals = flatNormals(),
    cutouts: readonly (readonly [number, number, number])[] = [],
  ) => findShimmer({ base, jittered, depth, normals, cutouts });

  test("a 1 px silhouette crawl on a depth edge is ignored", () => {
    const base = split(W, H, 24, RED, GREEN);
    const jittered = [23, 25, 23, 24, 25].map((e) =>
      split(W, H, e, RED, GREEN),
    );
    const result = run(base, jittered, depthImage(24));
    expect(countMask(result.unstable)).toBeGreaterThan(0);
    expect(result.clusters).toHaveLength(0);
  });

  test("a crawl that moves up to 2 px is still ignored", () => {
    const base = split(W, H, 24, RED, GREEN);
    const jittered = [22, 26, 22, 24, 26].map((e) =>
      split(W, H, e, RED, GREEN),
    );
    expect(run(base, jittered, depthImage(24)).clusters).toHaveLength(0);
  });

  test("an edge with no depth or normal step that slides 3 px with the camera is ignored", () => {
    // A frame band against its wall, close up: same normal, depth saturated.
    const base = split(W, H, 24, RED, GREEN);
    const jittered = [25, 26, 27, 25, 23].map((e) =>
      split(W, H, e, RED, GREEN),
    );
    expect(run(base, jittered).clusters).toHaveLength(0);
  });

  test("the same 4 px band flipping in noise (not as one edge) is flagged", () => {
    const base = split(W, H, 24, RED, GREEN);
    const jittered = [0, 1, 2, 3, 4].map((frame) => {
      const image = split(W, H, 24, RED, GREEN);
      for (let y = 0; y < H; y++) {
        for (let x = 22; x < 27; x++) {
          if (noise(x, y, frame))
            fillRect(image, x, y, 1, 1, x < 24 ? GREEN : RED);
        }
      }
      return image;
    });
    expect(run(base, jittered).clusters.length).toBeGreaterThan(0);
  });

  test("a thin line between same-material neighbours, no edge anywhere, is ignored", () => {
    const base = createImage(W, H, RED);
    const jittered = [0, 1, 2, 3, 4].map((f) => {
      const image = createImage(W, H, RED);
      fillRect(image, 0, 15, W, f % 2 === 0 ? 2 : 1, GREEN);
      return image;
    });
    expect(run(base, jittered).clusters).toHaveLength(0);
  });

  test("an interior noisy block with smooth depth and constant normals is flagged", () => {
    const base = createImage(W, H, RED);
    const jittered = [0, 1, 2, 3, 4].map((frame) => {
      const image = createImage(W, H, RED);
      for (let y = 8; y < 24; y++) {
        for (let x = 12; x < 32; x++) {
          if (noise(x, y, frame)) {
            fillRect(image, x, y, 1, 1, GREEN);
          }
        }
      }
      return image;
    });
    const result = run(base, jittered);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].pixels).toBeGreaterThan(200);
    expect(result.clusters[0].minX).toBeGreaterThanOrEqual(12);
    expect(result.clusters[0].maxX).toBeLessThanOrEqual(31);
  });

  test("a solid flipping block is flagged", () => {
    const base = createImage(W, H, RED);
    const flipped = createImage(W, H, RED);
    fillRect(flipped, 10, 8, 20, 12, GREEN);
    const result = run(base, [flipped, base, flipped, base, flipped]);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].pixels).toBe(240);
  });

  test("a block next to, but not on, an edge is flagged", () => {
    const base = split(W, H, 6, BLUE, RED);
    const flipped = split(W, H, 6, BLUE, RED);
    fillRect(flipped, 14, 8, 20, 12, GREEN);
    const result = run(
      base,
      [flipped, base, flipped, base, flipped],
      depthImage(6),
    );
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].pixels).toBeGreaterThan(200);
  });

  test("a block overlapping the edge zone is flagged outside of it", () => {
    const base = split(W, H, 6, BLUE, RED);
    const flipped = split(W, H, 6, BLUE, RED);
    fillRect(flipped, 4, 8, 26, 12, GREEN);
    const result = run(
      base,
      [flipped, base, flipped, base, flipped],
      depthImage(6),
    );
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].minX).toBeGreaterThanOrEqual(9);
    expect(result.clusters[0].maxX).toBe(29);
  });

  test("a normals step alone explains a crawl (no depth step)", () => {
    const base = split(W, H, 24, RED, GREEN);
    const jittered = [23, 25, 23, 24, 25].map((e) =>
      split(W, H, e, RED, GREEN),
    );
    const normals = split(W, H, 24, [128, 255, 128], [255, 128, 128]);
    expect(run(base, jittered, depthImage(), normals).clusters).toHaveLength(0);
  });

  test("a cut-out lattice is ignored even when its cells are thick", () => {
    const GRATE = [0, 160, 255] as const;
    const make = (shift: number): Image => {
      const image = createImage(W, H, RED);
      // 4x4 px bars of grate, with the background showing between them.
      for (let y = 4; y < 28; y++) {
        for (let x = 4; x < 44; x++) {
          const bar =
            (Math.floor((x + shift) / 4) + Math.floor(y / 4)) % 2 === 0;
          fillRect(image, x, y, 1, 1, bar ? GRATE : GREEN);
        }
      }
      return image;
    };
    const base = make(0);
    const jittered = [1, 2, 4, 3, 1].map(make);
    expect(
      run(base, jittered, depthImage(), flatNormals(), []).clusters.length,
    ).toBeGreaterThan(0);
    expect(
      run(base, jittered, depthImage(), flatNormals(), [GRATE]).clusters,
    ).toHaveLength(0);
  });

  test("results are masks of the right size and flagged is a subset of unstable", () => {
    const base = createImage(W, H, RED);
    const flipped = createImage(W, H, RED);
    fillRect(flipped, 10, 8, 20, 12, GREEN);
    const result = run(base, [flipped]);
    expect(result.flagged).toHaveLength(W * H);
    expect(countMask(andNotMask(result.flagged, result.unstable))).toBe(0);
  });
});
