/**
 * Pure detection logic for tools/lint-visual.ts, working on RGBA pixel
 * buffers: unstable pixels, the edge-aliasing rules that separate real
 * z-fighting from them (findShimmer), connected clusters, magenta "no
 * geometry" pixels, and diagnostic-view detection.
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

function colourDelta(image: Image, a: number, b: number): number {
  const i = a * 4;
  const j = b * 4;
  return Math.max(
    Math.abs(image.rgba[i] - image.rgba[j]),
    Math.abs(image.rgba[i + 1] - image.rgba[j + 1]),
    Math.abs(image.rgba[i + 2] - image.rgba[j + 2]),
  );
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

// ---------------------------------------------------------------------------
// Z-fighting discrimination
//
// Real z-fighting is an area effect: inside the interior of a surface the
// depth and normals are smooth, yet the material flips in a noisy 2D pattern
// when the camera moves by millimetres. Edge aliasing is a pixel or two thick
// and sits on a depth edge, a normal edge, a stable material boundary or a
// cut-out edge. The functions below keep only the former.
// ---------------------------------------------------------------------------

/** Box dilation (Chebyshev radius `r`). */
export function dilateMask(
  mask: Uint8Array,
  width: number,
  height: number,
  r: number,
): Uint8Array {
  if (r <= 0) {
    return new Uint8Array(mask);
  }
  const rows = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) {
        continue;
      }
      const hi = Math.min(width - 1, x + r);
      for (let xx = Math.max(0, x - r); xx <= hi; xx++) {
        rows[y * width + xx] = 1;
      }
    }
  }
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!rows[y * width + x]) {
        continue;
      }
      const hi = Math.min(height - 1, y + r);
      for (let yy = Math.max(0, y - r); yy <= hi; yy++) {
        out[yy * width + x] = 1;
      }
    }
  }
  return out;
}

/** Box erosion (Chebyshev radius `r`); pixels outside the image count as empty. */
export function erodeMask(
  mask: Uint8Array,
  width: number,
  height: number,
  r: number,
): Uint8Array {
  const inverted = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    inverted[i] = mask[i] ? 0 : 1;
  }
  const grown = dilateMask(inverted, width, height, r);
  const out = new Uint8Array(mask.length);
  for (let y = r; y < height - r; y++) {
    for (let x = r; x < width - r; x++) {
      const p = y * width + x;
      out[p] = mask[p] && !grown[p] ? 1 : 0;
    }
  }
  return out;
}

/** Opening: keeps only parts at least 2r+1 pixels thick. */
export function openMask(
  mask: Uint8Array,
  width: number,
  height: number,
  r: number,
): Uint8Array {
  return dilateMask(erodeMask(mask, width, height, r), width, height, r);
}

/** Closing: fills gaps of up to 2r pixels. Never grows past the original image. */
export function closeMask(
  mask: Uint8Array,
  width: number,
  height: number,
  r: number,
): Uint8Array {
  // Pad so that erosion does not eat the border.
  const w = width + 2 * r;
  const h = height + 2 * r;
  const padded = new Uint8Array(w * h);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      padded[(y + r) * w + x + r] = mask[y * width + x];
    }
  }
  const closed = erodeMask(dilateMask(padded, w, h, r), w, h, r);
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out[y * width + x] = closed[(y + r) * w + x + r];
    }
  }
  return out;
}

export function orMask(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = a[i] | b[i];
  }
  return out;
}

export function andNotMask(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = a[i] && !b[i] ? 1 : 0;
  }
  return out;
}

/**
 * Pixels where `image` changes abruptly. Without `curvature`: a 4-neighbour
 * differs by more than `threshold` (largest channel; both pixels are marked).
 * With `curvature`: the second difference along x or y exceeds it, so a
 * smooth ramp (depth on a slanted floor) is not an edge but a step is.
 */
export function discontinuityMask(
  image: Image,
  threshold: number,
  curvature = false,
): Uint8Array {
  const { width, height, rgba } = image;
  const mask = emptyMask(image);
  const at = (p: number, c: number): number => rgba[p * 4 + c];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      for (let c = 0; c < 3; c++) {
        const v = at(p, c);
        if (curvature) {
          if (
            x > 0 &&
            x + 1 < width &&
            Math.abs(at(p - 1, c) - 2 * v + at(p + 1, c)) > threshold
          ) {
            mask[p] = 1;
          }
          if (
            y > 0 &&
            y + 1 < height &&
            Math.abs(at(p - width, c) - 2 * v + at(p + width, c)) > threshold
          ) {
            mask[p] = 1;
          }
        } else {
          if (x + 1 < width && Math.abs(at(p + 1, c) - v) > threshold) {
            mask[p] = 1;
            mask[p + 1] = 1;
          }
          if (y + 1 < height && Math.abs(at(p + width, c) - v) > threshold) {
            mask[p] = 1;
            mask[p + width] = 1;
          }
        }
      }
    }
  }
  return mask;
}

/** Pixels whose colour is identical in every frame. */
export function stablePixels(frames: readonly Image[]): Uint8Array {
  const [first, ...rest] = frames;
  const mask = new Uint8Array(first.width * first.height).fill(1);
  for (const other of rest) {
    for (let p = 0; p < mask.length; p++) {
      if (mask[p] && pixelDelta(first, other, p) > 0) {
        mask[p] = 0;
      }
    }
  }
  return mask;
}

/**
 * Material boundaries that do not move: pairs of 4-adjacent pixels that are
 * both stable and of different colour in `base`. Both pixels are marked.
 */
export function stableBoundaryMask(
  base: Image,
  stable: Uint8Array,
): Uint8Array {
  const { width, height } = base;
  const mask = emptyMask(base);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!stable[p]) {
        continue;
      }
      if (x + 1 < width && stable[p + 1] && colourDelta(base, p, p + 1) > 0) {
        mask[p] = 1;
        mask[p + 1] = 1;
      }
      if (
        y + 1 < height &&
        stable[p + width] &&
        colourDelta(base, p, p + width) > 0
      ) {
        mask[p] = 1;
        mask[p + width] = 1;
      }
    }
  }
  return mask;
}

export type Colour3 = readonly [number, number, number];

/** Pixels that have one of `colours` in any of the frames. */
export function colourMask(
  frames: readonly Image[],
  colours: readonly Colour3[],
): Uint8Array {
  const mask = emptyMask(frames[0]);
  for (const image of frames) {
    for (let p = 0; p < mask.length; p++) {
      const i = p * 4;
      for (const c of colours) {
        if (
          image.rgba[i] === c[0] &&
          image.rgba[i + 1] === c[1] &&
          image.rgba[i + 2] === c[2]
        ) {
          mask[p] = 1;
          break;
        }
      }
    }
  }
  return mask;
}

export interface ShimmerInput {
  /** Material view at the base pose. */
  base: Image;
  /** Material view at slightly moved poses. */
  jittered: readonly Image[];
  /** Depth view at the base pose. */
  depth: Image;
  /** Normals view at the base pose. */
  normals: Image;
  /** Debug colours of see-through (alpha cut-out) materials. */
  cutouts?: readonly Colour3[];
}

export interface ShimmerOptions {
  /** Pixels within this distance of an edge are explained as aliasing. */
  edgeRadius?: number;
  /** Depth second difference (0..255 levels) above which depth has an edge. */
  depthStep?: number;
  /** Normal channel step (0..255) above which normals have an edge. */
  normalStep?: number;
  /** The unstable area must contain a square of side 2r+1. */
  thicknessRadius?: number;
  /** Smallest cluster (pixels, after the thickness rule) worth reporting. */
  minSize?: number;
}

export interface ShimmerResult {
  /** Pixels that changed in any jittered frame. */
  unstable: Uint8Array;
  /** Pixels explained by edges and cut-outs. */
  explained: Uint8Array;
  /** Pixels that survive every rule. */
  flagged: Uint8Array;
  clusters: Cluster[];
}

/**
 * Finds z-fighting: material flips that form a thick area away from any
 * depth edge, normal edge, stable material boundary or cut-out surface.
 */
export function findShimmer(
  input: ShimmerInput,
  options: ShimmerOptions = {},
): ShimmerResult {
  const edgeRadius = options.edgeRadius ?? 2;
  const depthStep = options.depthStep ?? 2;
  const normalStep = options.normalStep ?? 8;
  const thicknessRadius = options.thicknessRadius ?? 1;
  const minSize = options.minSize ?? 12;
  const { base, depth, normals } = input;
  const { width, height } = base;
  const frames = [base, ...input.jittered];

  const unstable = unstableMask(base, input.jittered, 0);
  const stable = stablePixels(frames);
  let edges = orMask(
    discontinuityMask(depth, depthStep, true),
    discontinuityMask(normals, normalStep),
  );
  edges = orMask(edges, stableBoundaryMask(base, stable));
  if (input.cutouts && input.cutouts.length > 0) {
    edges = orMask(edges, colourMask(frames, input.cutouts));
  }
  const explained = dilateMask(edges, width, height, edgeRadius);
  const candidates = andNotMask(unstable, explained);
  const filled = andNotMask(closeMask(candidates, width, height, 1), explained);
  const thick = openMask(filled, width, height, thicknessRadius);
  const flagged = andNotMask(thick, explained);
  const clusters = clusterMask(flagged, width, height, { minSize, gap: 1 });
  return { unstable, explained, flagged, clusters };
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
