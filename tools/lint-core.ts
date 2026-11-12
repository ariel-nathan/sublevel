/**
 * Pure detection logic for tools/lint-visual.ts, working on RGBA pixel
 * buffers: unstable pixels (z-fighting), silhouette masking, connected
 * clusters, magenta "no geometry" pixels, and diagnostic-view detection.
 * Masks are Uint8Array(width * height) with 1 for "flagged".
 */
import { pixelDelta, strokeRect, type Image } from "./image";

export interface Cluster {
  /** Flagged pixels in the cluster. */
  pixels: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function emptyMask(image: Image): Uint8Array {
  return new Uint8Array(image.width * image.height);
}

export function countMask(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    n += mask[i];
  }
  return n;
}

/**
 * Pixels whose colour in the base frame differs from the same pixel in any
 * of the other frames by more than `tolerance` (largest channel difference).
 * Use tolerance 0 on the flat "material" view.
 */
export function unstableMask(
  base: Image,
  others: readonly Image[],
  tolerance = 0,
): Uint8Array {
  const mask = emptyMask(base);
  for (const other of others) {
    if (other.width !== base.width || other.height !== base.height) {
      throw new Error("unstableMask: frame sizes differ");
    }
    for (let p = 0; p < mask.length; p++) {
      if (!mask[p] && pixelDelta(base, other, p) > tolerance) {
        mask[p] = 1;
      }
    }
  }
  return mask;
}

/**
 * Pixels on a silhouette in `image`: those with a 4-neighbour of a different
 * colour (more than `tolerance` apart), i.e. a 1-pixel edge between two
 * materials.
 */
export function silhouetteMask(image: Image, tolerance = 0): Uint8Array {
  const { width, height } = image;
  const mask = emptyMask(image);
  const differs = (a: number, b: number): boolean =>
    colourDelta(image, a, b) > tolerance;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (
        (x + 1 < width && differs(p, p + 1)) ||
        (y + 1 < height && differs(p, p + width))
      ) {
        mask[p] = 1;
        if (x + 1 < width && differs(p, p + 1)) {
          mask[p + 1] = 1;
        }
        if (y + 1 < height && differs(p, p + width)) {
          mask[p + width] = 1;
        }
      }
    }
  }
  return mask;
}

function colourDelta(image: Image, a: number, b: number): number {
  const i = a * 4;
  const j = b * 4;
  return Math.max(
    Math.abs(image.rgba[i] - image.rgba[j]),
    Math.abs(image.rgba[i + 1] - image.rgba[j + 1]),
    Math.abs(image.rgba[i + 2] - image.rgba[j + 2]),
  );
}

/** Number of flagged pixels among the 8 neighbours of (x, y). */
function neighbourCount(
  mask: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  let n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) {
        continue;
      }
      const xx = x + dx;
      const yy = y + dy;
      if (xx >= 0 && xx < width && yy >= 0 && yy < height) {
        n += mask[yy * width + xx];
      }
    }
  }
  return n;
}

/**
 * Removes unstable pixels that are explained by ordinary edge crawl: those on
 * a silhouette that are not part of a dense unstable area. A thin crawling
 * edge has at most two unstable neighbours per pixel along the line, while a
 * z-fighting region (even one that straddles a material boundary) is dense,
 * so silhouette pixels with at least `denseNeighbours` unstable neighbours
 * stay flagged.
 */
export function removeSilhouetteCrawl(
  unstable: Uint8Array,
  silhouette: Uint8Array,
  width: number,
  height: number,
  denseNeighbours = 3,
): Uint8Array {
  const out = new Uint8Array(unstable.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!unstable[p]) {
        continue;
      }
      if (
        !silhouette[p] ||
        neighbourCount(unstable, width, height, x, y) >= denseNeighbours
      ) {
        out[p] = 1;
      }
    }
  }
  return out;
}

/**
 * Connected groups of flagged pixels. Pixels within `gap` empty pixels of
 * each other join (gap 0 is plain 8-connectivity). Groups smaller than
 * `minSize` flagged pixels are dropped. Largest first.
 */
export function clusterMask(
  mask: Uint8Array,
  width: number,
  height: number,
  options: { minSize?: number; gap?: number } = {},
): Cluster[] {
  const minSize = options.minSize ?? 1;
  const reach = (options.gap ?? 0) + 1;
  const seen = new Uint8Array(mask.length);
  const clusters: Cluster[] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) {
      continue;
    }
    const cluster: Cluster = {
      pixels: 0,
      minX: width,
      minY: height,
      maxX: -1,
      maxY: -1,
    };
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const p = stack.pop()!;
      const x = p % width;
      const y = (p - x) / width;
      cluster.pixels++;
      cluster.minX = Math.min(cluster.minX, x);
      cluster.maxX = Math.max(cluster.maxX, x);
      cluster.minY = Math.min(cluster.minY, y);
      cluster.maxY = Math.max(cluster.maxY, y);
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || xx >= width || yy < 0 || yy >= height) {
            continue;
          }
          const q = yy * width + xx;
          if (mask[q] && !seen[q]) {
            seen[q] = 1;
            stack.push(q);
          }
        }
      }
    }
    if (cluster.pixels >= minSize) {
      clusters.push(cluster);
    }
  }
  return clusters.sort((a, b) => b.pixels - a.pixels);
}

/** Pixels that are pure magenta (255, 0, 255): no geometry in "coverage". */
export function magentaMask(image: Image): Uint8Array {
  const mask = emptyMask(image);
  for (let p = 0; p < mask.length; p++) {
    const i = p * 4;
    if (
      image.rgba[i] === 255 &&
      image.rgba[i + 1] === 0 &&
      image.rgba[i + 2] === 255
    ) {
      mask[p] = 1;
    }
  }
  return mask;
}

/**
 * True if a frame looks like the "coverage" view: nearly every pixel is
 * either pure white or pure magenta. A normal lit frame never is.
 */
export function looksLikeCoverage(image: Image): boolean {
  let flat = 0;
  const count = image.width * image.height;
  for (let p = 0; p < count; p++) {
    const i = p * 4;
    const r = image.rgba[i];
    const g = image.rgba[i + 1];
    const b = image.rgba[i + 2];
    if (r === 255 && b === 255 && (g === 0 || g === 255)) {
      flat++;
    }
  }
  return count > 0 && flat / count >= 0.95;
}

/** Number of distinct colours in a frame (a flat-colour view has few). */
export function distinctColours(image: Image, limit = 4096): number {
  const seen = new Set<number>();
  const count = image.width * image.height;
  for (let p = 0; p < count && seen.size <= limit; p++) {
    const i = p * 4;
    seen.add(
      (image.rgba[i] << 16) | (image.rgba[i + 1] << 8) | image.rgba[i + 2],
    );
  }
  return seen.size;
}

/** True if a frame looks like the flat-colour "material" view. */
export function looksLikeMaterial(image: Image): boolean {
  return distinctColours(image, 200) <= 64;
}

/** Copy of `base` with flagged pixels painted red and clusters boxed. */
export function annotate(
  base: Image,
  mask: Uint8Array,
  clusters: readonly Cluster[],
  boxColour: readonly [number, number, number] = [255, 255, 0],
): Image {
  const out: Image = {
    width: base.width,
    height: base.height,
    rgba: new Uint8Array(base.rgba),
  };
  for (let p = 0; p < mask.length; p++) {
    if (mask[p]) {
      out.rgba[p * 4] = 255;
      out.rgba[p * 4 + 1] = 0;
      out.rgba[p * 4 + 2] = 0;
    }
  }
  for (const c of clusters) {
    strokeRect(
      out,
      Math.max(0, c.minX - 2),
      Math.max(0, c.minY - 2),
      c.maxX - c.minX + 5,
      c.maxY - c.minY + 5,
      boxColour,
    );
  }
  return out;
}
