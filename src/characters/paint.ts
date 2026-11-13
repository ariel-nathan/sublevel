/**
 * Paints a character's texture atlas by code: a small hand-pixelled face,
 * hair, skin, and the clothes of the archetype, with flat colours, simple
 * baked shading and a little dirt, then reduced to a limited palette.
 * Layout and row conventions are in layout.ts and body.ts.
 */
import type { MeshImage } from "../core/mesh";
import { createRng, type Rng } from "../core/rng";
import { Canvas, hex, mix, Noise, scale, type RGB } from "../textures/gfx";
import type { AtlasRows } from "./body";
import { ATLAS, ATLAS_SIZE, headRow } from "./layout";
import type { BodyMetrics } from "./skeleton";
import type { CharacterSpec, GuardOutfit, ScientistOutfit } from "./spec";

type Rect = { x: number; y: number; w: number; h: number };

class Painter {
  readonly c: Canvas;
  constructor() {
    this.c = new Canvas(ATLAS_SIZE, [128, 128, 128]);
  }

  fill(r: Rect, col: RGB): void {
    this.c.rect(r.x, r.y, r.w, r.h, col);
  }

  /** Sets a pixel if it lies inside `clip`. */
  set(x: number, y: number, col: RGB, clip?: Rect): void {
    x = Math.floor(x);
    y = Math.floor(y);
    if (
      clip &&
      (x < clip.x || y < clip.y || x >= clip.x + clip.w || y >= clip.y + clip.h)
    ) {
      return;
    }
    if (x < 0 || y < 0 || x >= ATLAS_SIZE || y >= ATLAS_SIZE) {
      return;
    }
    this.c.set(x, y, col);
  }

  blend(x: number, y: number, col: RGB, a: number, clip?: Rect): void {
    x = Math.floor(x);
    y = Math.floor(y);
    if (
      clip &&
      (x < clip.x || y < clip.y || x >= clip.x + clip.w || y >= clip.y + clip.h)
    ) {
      return;
    }
    if (x < 0 || y < 0 || x >= ATLAS_SIZE || y >= ATLAS_SIZE) {
      return;
    }
    this.c.blend(x, y, col, a);
  }

  shade(x: number, y: number, f: number, clip?: Rect): void {
    x = Math.floor(x);
    y = Math.floor(y);
    if (
      clip &&
      (x < clip.x || y < clip.y || x >= clip.x + clip.w || y >= clip.y + clip.h)
    ) {
      return;
    }
    if (x < 0 || y < 0 || x >= ATLAS_SIZE || y >= ATLAS_SIZE) {
      return;
    }
    this.c.shade(x, y, f);
  }

  get(x: number, y: number): RGB {
    return this.c.get(x, y);
  }

  hline(x0: number, x1: number, y: number, col: RGB, clip?: Rect): void {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
      this.set(x, y, col, clip);
    }
  }

  vline(x: number, y0: number, y1: number, col: RGB, clip?: Rect): void {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
      this.set(x, y, col, clip);
    }
  }

  /** Each pixel of a rect; return a colour to replace it. */
  each(r: Rect, fn: (x: number, y: number, c: RGB) => RGB | void): void {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const out = fn(x, y, this.c.get(x, y));
        if (out) {
          this.c.set(x, y, out);
        }
      }
    }
  }
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const darker = (c: RGB, f: number): RGB => scale(c, f);
const lighter = (c: RGB, f: number): RGB => mix(c, [255, 255, 255], f);

/** Horizontal distance from the front of a wrap band: 0 front, 1 back. */
function aroundFromFront(x: number, band: Rect): number {
  const centre = band.x + band.w / 2;
  return Math.min(1, Math.abs(x + 0.5 - centre) / (band.w / 2));
}

/** Mirror of a pixel column across the middle of a band. */
const mirror = (x: number, band: Rect): number => 2 * band.x + band.w - 1 - x;

export function paintAtlas(
  spec: CharacterSpec,
  m: BodyMetrics,
  rows: AtlasRows,
): MeshImage {
  const p = new Painter();
  const rng = createRng((spec.seed * 2654435761 + 77) >>> 0);
  const noise = new Noise((spec.seed ^ 0x51ab) >>> 0);
  const skin = hex(spec.skin);
  const hair = hex(spec.hair.color);

  // --- Swatches ---------------------------------------------------------------
  p.fill(ATLAS.mouth, [52, 22, 20]);
  p.set(ATLAS.mouth.x + 3, ATLAS.mouth.y + 5, [110, 48, 44]);
  p.set(ATLAS.mouth.x + 4, ATLAS.mouth.y + 5, [110, 48, 44]);
  p.fill(ATLAS.hair, hair);
  p.fill(ATLAS.skin, darker(skin, 0.86));
  p.fill(ATLAS.sole, [34, 30, 28]);

  paintHead(p, spec, rng);
  paintNeck(p, spec);
  paintHands(p, spec);
  if (spec.outfit.type === "scientist") {
    paintScientist(p, spec, spec.outfit, m, rows, rng);
  } else {
    paintGuard(p, spec, spec.outfit, m, rows, rng);
  }

  // Dirt and wear on clothes (not on skin).
  for (const band of [
    ATLAS.torso,
    ATLAS.skirt,
    ATLAS.arm,
    ATLAS.leg,
    ATLAS.foot,
  ]) {
    p.each(band, (x, y, c) => {
      const n = noise.fbm(x / 32, y / 32, 4, 4, 3, 5);
      const f = 1 - Math.max(0, n - 0.6) * 0.18 + (rng.next() - 0.5) * 0.03;
      return scale(c, f);
    });
  }
  return { size: ATLAS_SIZE, pixels: toRgba5(p.c) };
}

/**
 * Opaque RGBA8 with each channel reduced to 5 bits (32 levels), as the
 * 15-bit textures of the era. Much cheaper than a fitted palette.
 */
function toRgba5(c: Canvas): Uint8Array {
  const n = c.size * c.size;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    for (let ch = 0; ch < 3; ch++) {
      const v = Math.max(8, Math.min(247, c.data[i * 3 + ch]));
      out[i * 4 + ch] = Math.round(Math.round(v / 8.226) * 8.226);
    }
    out[i * 4 + 3] = 255;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Head
// ---------------------------------------------------------------------------

const ROW = (f: number): number => Math.round(headRow(f) - 0.5);

function paintHead(p: Painter, spec: CharacterSpec, rng: Rng): void {
  const skin = hex(spec.skin);
  const hairCol = hex(spec.hair.color);
  const head = ATLAS.head;
  const jaw = ATLAS.jaw;
  const face: Rect = { x: 0, y: 0, w: 64, h: 56 };
  const age = spec.age;
  const dark = spec.skin < 0x9a0000;

  // Base skin with soft baked shading: darker round the back and under the jaw.
  p.each(face, (x, y) => {
    const a = aroundFromFront(x, head);
    let f = 1 - a * 0.12;
    if (y >= jaw.y) {
      f *= 1 - ((y - jaw.y) / jaw.h) * 0.12;
    }
    if (y < 8) {
      f *= 0.96;
    }
    return scale(skin, f);
  });

  const shadow = (x: number, y: number, k: number): void =>
    p.shade(x, y, k, face);
  const mirrored = (
    x: number,
    y: number,
    fn: (x: number, y: number) => void,
  ): void => {
    fn(x, y);
    fn(mirror(x, head), y);
  };

  const eyeY = ROW(0.553);
  const browY = ROW(0.628);
  const noseY = ROW(0.4);
  const mouthY = ATLAS.head.y + ATLAS.head.h - 1; // 43: last head row

  // Cheeks, eye sockets and the cheekbone.
  for (let y = eyeY - 2; y <= eyeY + 1; y++) {
    for (let x = 21; x <= 28; x++) {
      mirrored(x, y, (xx, yy) => shadow(xx, yy, 0.94));
    }
  }
  for (let y = eyeY + 3; y <= mouthY; y++) {
    for (let x = 18; x <= 21; x++) {
      mirrored(x, y, (xx, yy) => shadow(xx, yy, 0.93));
    }
  }
  mirrored(22, eyeY + 3, (x, y) => p.blend(x, y, [255, 240, 225], 0.07));
  mirrored(23, eyeY + 3, (x, y) => p.blend(x, y, [255, 240, 225], 0.07));

  // Ears (where the ear cards are mapped): rim, inner shadow.
  const earTop = ROW(0.63);
  const earBottom = ROW(0.41);
  for (let y = earTop; y <= earBottom; y++) {
    for (let x = 9; x <= 15; x++) {
      const edge = x === 9 || x === 15 || y === earTop || y === earBottom;
      mirrored(x, y, (xx, yy) => shadow(xx, yy, edge ? 0.8 : 0.97));
    }
    if (y > earTop + 1 && y < earBottom - 1) {
      mirrored(11, y, (xx, yy) => shadow(xx, yy, 0.78));
      mirrored(12, y, (xx, yy) => shadow(xx, yy, 0.86));
    }
  }

  // Eyes: lid line, whites, iris; four pixels wide, symmetric about the centre.
  const white: RGB = mix([226, 222, 212], skin, 0.18);
  const iris = hex(spec.eyes);
  const lid = darker(skin, dark ? 0.42 : 0.38);
  const eye = (x0: number): void => {
    p.hline(x0 - 1, x0 + 3, eyeY - 1, lid);
    p.set(x0, eyeY, white);
    p.set(x0 + 1, eyeY, iris);
    p.set(x0 + 2, eyeY, iris);
    p.set(x0 + 3, eyeY, white);
    p.blend(x0 + 1, eyeY + 1, iris, 0.25);
    p.blend(x0 + 2, eyeY + 1, iris, 0.25);
  };
  eye(23);
  eye(37);
  // Lower lids and bags with age.
  for (let x = 23; x <= 26; x++) {
    mirrored(x, eyeY + 1, (xx, yy) => shadow(xx, yy, 0.9 - age * 0.06));
  }
  if (age > 0.55) {
    mirrored(27, eyeY, (x, y) => shadow(x, y, 0.85));
    mirrored(27, eyeY + 1, (x, y) => shadow(x, y, 0.88));
  }

  // Brows.
  const browCol = mix(
    darker(hairCol, 0.75),
    skin,
    spec.hair.style === "bald" ? 0.35 : 0.1,
  );
  const browThick = spec.figure === "a" ? 2 : 1;
  for (let x = 22; x <= 27; x++) {
    const y = browY + (x === 22 ? 1 : 0);
    mirrored(x, y, (xx, yy) => p.set(xx, yy, browCol));
    if (browThick > 1 && x >= 24) {
      mirrored(x, y + 1, (xx, yy) => p.blend(xx, yy, browCol, 0.5));
    }
  }

  // Nose: lit bridge, shadow on the far side, nostrils and the shadow below.
  for (let y = browY + 2; y < noseY - 1; y++) {
    p.blend(31, y, [255, 245, 235], 0.06);
    shadow(33, y, 0.9);
  }
  shadow(33, noseY - 2, 0.82);
  shadow(34, noseY - 1, 0.85);
  p.set(30, noseY - 1, darker(skin, 0.55));
  p.set(33, noseY - 1, darker(skin, 0.55));
  for (let x = 29; x <= 34; x++) {
    shadow(x, noseY, 0.82);
  }
  // Philtrum.
  shadow(31, noseY + 2, 0.94);
  shadow(32, noseY + 2, 0.94);

  // Mouth: upper lip and mouth line on the head, lower lip on the jaw.
  const lip = mix(darker(skin, 0.8), [150, 60, 60], dark ? 0.12 : 0.28);
  p.hline(28, 35, mouthY - 1, mix(lip, skin, 0.35));
  p.hline(28, 35, mouthY, darker(lip, 0.62));
  p.set(27, mouthY, darker(skin, 0.75));
  p.set(36, mouthY, darker(skin, 0.75));
  p.hline(29, 34, jaw.y, lighter(lip, 0.08));
  p.hline(29, 34, jaw.y + 2, darker(skin, 0.88));
  // Chin.
  for (let x = 29; x <= 34; x++) {
    p.blend(x, jaw.y + 6, [255, 240, 225], 0.06);
  }
  for (let x = 14; x <= 49; x++) {
    shadow(x, jaw.y + jaw.h - 1, 0.82);
  }

  // Age lines.
  if (age > 0.4) {
    mirrored(28, noseY + 1, (x, y) => shadow(x, y, 0.86));
    mirrored(27, noseY + 3, (x, y) => shadow(x, y, 0.86));
    mirrored(27, noseY + 5, (x, y) => shadow(x, y, 0.88));
  }
  if (age > 0.65) {
    for (let x = 26; x <= 37; x++) {
      shadow(x, browY - 4, 0.92);
      if (x > 27 && x < 36) {
        shadow(x, browY - 6, 0.94);
      }
    }
  }

  paintHair(p, spec, rng);
  paintFacialHair(p, spec, rng, mouthY);

  // Glasses: thin frames round both eyes, a bridge and arms to the ears.
  if (spec.glasses !== null) {
    const frame = hex(spec.glasses);
    const lens = (x0: number): void => {
      for (let x = x0; x <= x0 + 7; x++) {
        p.set(x, eyeY - 2, frame);
        p.set(x, eyeY + 2, frame);
      }
      for (let y = eyeY - 2; y <= eyeY + 2; y++) {
        p.set(x0, y, frame);
        p.set(x0 + 7, y, frame);
      }
      for (let y = eyeY - 1; y <= eyeY + 1; y++) {
        for (let x = x0 + 1; x <= x0 + 6; x++) {
          p.blend(x, y, [235, 240, 245], 0.14);
        }
      }
      p.blend(x0 + 2, eyeY - 1, [255, 255, 255], 0.35);
    };
    lens(21);
    lens(35);
    p.hline(29, 34, eyeY - 1, frame);
    p.hline(14, 20, eyeY - 1, darker(frame, 0.9));
    p.hline(43, 49, eyeY - 1, darker(frame, 0.9));
  }
}

/** Lowest hair row at distance `a` from the front (0) to the back (1). */
function hairBottom(style: CharacterSpec["hair"]["style"], a: number): number {
  const front = ROW(0.865);
  const temple = ROW(0.8);
  const ear = ROW(0.64);
  const side = ROW(0.5);
  const nape = 41;
  const lerp = (u: number, v: number, t: number): number =>
    u + (v - u) * clamp01(t);
  switch (style) {
    case "bald":
      return a < 0.5 ? -1 : lerp(ear, nape - 3, (a - 0.5) / 0.3);
    case "receding":
      if (a < 0.12) return front - 3;
      if (a < 0.3) return lerp(front - 6, temple - 2, (a - 0.12) / 0.18);
      if (a < 0.42) return lerp(temple, side, (a - 0.3) / 0.12);
      if (a < 0.56) return ear;
      return lerp(ear, nape, (a - 0.56) / 0.2);
    case "long":
      if (a < 0.16) return front;
      if (a < 0.3) return lerp(front, side + 2, (a - 0.16) / 0.14);
      return 55;
    default:
      if (a < 0.17) return front + (style === "side_part" ? 0 : 0);
      if (a < 0.3) return lerp(front, temple + 2, (a - 0.17) / 0.13);
      if (a < 0.43) return lerp(temple + 2, side + 1, (a - 0.3) / 0.13);
      if (a < 0.56) return ear;
      return lerp(
        ear,
        style === "tied_back" ? nape + 1 : nape,
        (a - 0.56) / 0.16,
      );
  }
}

function paintHair(p: Painter, spec: CharacterSpec, rng: Rng): void {
  const style = spec.hair.style;
  const col = hex(spec.hair.color);
  const head = ATLAS.head;
  const region: Rect = { x: 0, y: 0, w: 64, h: 56 };
  const hi = lighter(col, 0.18);
  const lo = darker(col, 0.7);
  // Strands: a per-column offset so the hair edge and strokes look drawn.
  const jitter = Array.from({ length: 64 }, () => rng.int(-1, 1));
  const strand = Array.from({ length: 64 }, () => rng.next());
  if (style === "bald") {
    // Shine on the scalp.
    for (let x = 26; x <= 37; x++) {
      for (let y = 2; y <= 6; y++) {
        p.blend(x, y, [255, 245, 235], 0.05 + (y === 4 ? 0.04 : 0));
      }
    }
  }
  p.each(region, (x, y, c) => {
    const a = aroundFromFront(x, head);
    let bottom = hairBottom(style, a);
    const earZone = a > 0.39 && a < 0.6 && style !== "long";
    if (bottom >= 0) {
      bottom += Math.abs(jitter[x]) > 0 && !earZone ? jitter[x] * 0.5 : 0;
    }
    const isHair =
      style === "bald"
        ? bottom >= 0 && y >= ROW(0.66) && y <= bottom
        : y <= bottom && (y < ATLAS.jaw.y || style === "long");
    if (!isHair) {
      return;
    }
    // Long hair leaves the face open.
    if (
      style === "long" &&
      y >= ROW(0.86) &&
      a < 0.3 &&
      y > hairBottom("short", a)
    ) {
      return;
    }
    let shade = 1;
    if (y < 3) shade *= 1.08;
    if (strand[x] < 0.3) shade *= 0.88;
    else if (strand[x] > 0.82) shade *= 1.1;
    if ((y + x * 3) % 7 === 0) shade *= 0.92;
    const edge = y === Math.floor(bottom);
    const base = edge ? mix(col, c, 0.45) : col;
    return scale(base, shade);
  });
  if (style === "side_part") {
    // Parting on the character's left, combed over.
    const px = mirror(25, head);
    for (let y = 0; y <= ROW(0.9); y++) {
      p.set(px, y, mix(col, hex(spec.skin), 0.45));
      p.set(px + 1, y, hi);
    }
  }
  if (style === "short" || style === "receding" || style === "side_part") {
    for (let x = 22; x <= 41; x++) {
      if ((x * 7) % 5 === 0) p.set(x, 2, hi);
    }
  }
  if (style === "tied_back") {
    // Hair pulled back: strokes towards the back, and the tie.
    for (let x = 0; x <= 63; x += 3) {
      p.blend(x, 6, lo, 0.4);
    }
  }
  // Hair pieces (ponytail / long hair at the back) and the plain hair swatch.
  p.each(ATLAS.hairPiece, (x, y) => {
    const s = strand[x % 64] < 0.35 ? 0.86 : strand[x % 64] > 0.8 ? 1.1 : 1;
    return scale(col, s * (1 - (y - ATLAS.hairPiece.y) * 0.01));
  });
  if (style === "tied_back") {
    p.fill({ x: ATLAS.hairPiece.x, y: 113, w: 32, h: 2 }, [40, 36, 34]);
  }
  // Sideburns in front of the ears.
  if (style !== "bald" && style !== "long") {
    for (let y = ROW(0.62); y <= ROW(0.46); y++) {
      p.set(17, y, mix(col, hex(spec.skin), 0.35));
      p.set(mirror(17, head), y, mix(col, hex(spec.skin), 0.35));
    }
  }
}

function paintFacialHair(
  p: Painter,
  spec: CharacterSpec,
  rng: Rng,
  mouthY: number,
): void {
  const col = hex(spec.hair.color);
  const skin = hex(spec.skin);
  const head = ATLAS.head;
  const jaw = ATLAS.jaw;
  const kind = spec.facialHair;
  if (kind === "none") {
    return;
  }
  const stubble = mix(skin, col, 0.4);
  const inBeardArea = (x: number, y: number): boolean => {
    const a = aroundFromFront(x, head);
    if (y >= jaw.y) {
      return a < 0.46;
    }
    if (y >= mouthY - 4 && a < 0.2) return true; // upper lip
    return y >= ROW(0.44) && a > 0.18 && a < 0.44; // cheeks and jawline
  };
  const lowerLip = (x: number, y: number): boolean =>
    (y === jaw.y || y === jaw.y + 1) && x >= 29 && x <= 34;
  const mouthLine = (x: number, y: number): boolean =>
    y === mouthY && x >= 27 && x <= 36;
  if (kind === "stubble") {
    p.each({ x: 0, y: 30, w: 64, h: 26 }, (x, y, c) => {
      if (!inBeardArea(x, y) || lowerLip(x, y) || mouthLine(x, y)) return;
      return rng.next() < 0.55 ? mix(c, stubble, 0.6) : mix(c, stubble, 0.25);
    });
    return;
  }
  // Moustache.
  for (let y = mouthY - 3; y <= mouthY - 1; y++) {
    const inset = y === mouthY - 3 ? 1 : 0;
    for (let x = 27 + inset; x <= 36 - inset; x++) {
      p.set(x, y, (x + y) % 3 === 0 ? darker(col, 0.85) : col);
    }
  }
  p.set(26, mouthY, col);
  p.set(37, mouthY, col);
  if (kind === "beard") {
    p.each({ x: 0, y: 30, w: 64, h: 26 }, (x, y, c) => {
      if (!inBeardArea(x, y) || lowerLip(x, y) || mouthLine(x, y)) return;
      const a = aroundFromFront(x, head);
      const edge = y < jaw.y && (a > 0.4 || y === ROW(0.44));
      const s = rng.next() < 0.3 ? 0.85 : 1;
      return edge ? mix(c, col, 0.55) : scale(col, s);
    });
  }
}

// ---------------------------------------------------------------------------
// Neck and hands
// ---------------------------------------------------------------------------

function paintNeck(p: Painter, spec: CharacterSpec): void {
  const skin = hex(spec.skin);
  p.each(ATLAS.neck, (x, y) => {
    const a = aroundFromFront(x, ATLAS.neck);
    const top = y - ATLAS.neck.y < 3 ? 0.78 + (y - ATLAS.neck.y) * 0.05 : 0.92;
    return scale(skin, top * (1 - a * 0.08));
  });
  // Adam's apple / throat shadow.
  if (spec.figure === "a") {
    p.shade(ATLAS.neck.x + 8, ATLAS.neck.y + 4, 0.9);
  }
}

function paintHands(p: Painter, spec: CharacterSpec): void {
  const skin = hex(spec.skin);
  const h = ATLAS.hand;
  p.each(h, (x, y) => {
    const knuckles = y - h.y === 7 ? 0.9 : 1;
    return scale(skin, 0.97 * knuckles * (1 - (y - h.y) * 0.006));
  });
  // Finger separations on the back of the hand and on the palm.
  for (const x of [h.x + 3, h.x + 5, h.x + 11, h.x + 13]) {
    p.vline(x, h.y + 9, h.y + 15, darker(skin, 0.72));
  }
  // Palm crease.
  p.hline(h.x + 10, h.x + 14, h.y + 6, darker(skin, 0.82));
}

// ---------------------------------------------------------------------------
// Clothes
// ---------------------------------------------------------------------------

/** Baked folds and side shading on a wrap band. */
function clothShading(p: Painter, band: Rect, rng: Rng, strength = 1): void {
  const folds = Array.from({ length: band.w }, () => rng.next());
  p.each(band, (x, y, c) => {
    const a = aroundFromFront(x, band);
    let f = 1 - a * 0.1 * strength;
    if (folds[x - band.x] < 0.06) f *= 0.95;
    return scale(c, f);
  });
}

function paintTrousers(
  p: Painter,
  col: RGB,
  rows: AtlasRows,
  m: BodyMetrics,
  rng: Rng,
  bootTop: number | null,
  boots: RGB,
): void {
  const leg = ATLAS.leg;
  p.fill(leg, col);
  clothShading(p, leg, rng);
  const front = leg.x + leg.w / 2;
  for (let y = leg.y + 2; y < leg.y + leg.h; y++) {
    p.blend(front - 1, y, [255, 255, 255], 0.08); // crease
    p.shade(leg.x + 8, y, 0.9); // outer seam
  }
  const knee = Math.round(rows.leg(m.hipY - m.kneeY));
  for (const dx of [-3, -1, 2]) {
    p.hline(front - 4, front + 3, knee + dx, darker(col, 0.88));
  }
  const ankle = Math.round(rows.leg(m.hipY - m.ankleY));
  if (bootTop !== null) {
    for (let y = bootTop; y < leg.y + leg.h; y++) {
      p.hline(
        leg.x,
        leg.x + leg.w - 1,
        y,
        y === bootTop ? darker(col, 0.6) : boots,
      );
    }
    p.hline(leg.x, leg.x + leg.w - 1, bootTop - 1, darker(col, 0.8));
  } else {
    p.hline(leg.x, leg.x + leg.w - 1, ankle - 1, darker(col, 0.78));
  }
  p.fill(ATLAS.trouser, darker(col, 0.8));
}

function paintShoes(p: Painter, col: RGB, boots: boolean): void {
  const f = ATLAS.foot;
  p.fill(f, col);
  p.each(f, (x, y, c) => {
    // Top seam at the band edges; the sole along the middle (the bottom).
    const a = aroundFromFront(x, f); // 0 bottom, 1 top
    if (a < 0.2) return [34, 30, 28];
    if (a < 0.28) return darker(col, 0.7);
    const heel = y - f.y < 3 ? 0.85 : 1;
    return scale(c, (0.8 + a * 0.25) * heel);
  });
  // Laces over the instep.
  for (let y = f.y + 4; y <= f.y + 9; y += 2) {
    p.hline(f.x, f.x + 1, y, [190, 186, 176]);
    p.hline(f.x + f.w - 2, f.x + f.w - 1, y, [190, 186, 176]);
  }
  if (boots) {
    for (let y = f.y; y < f.y + 4; y++) {
      p.hline(
        f.x,
        f.x + f.w - 1,
        y,
        y === f.y ? darker(col, 0.8) : lighter(col, 0.04),
      );
    }
  } else {
    // Toe cap.
    p.hline(f.x + 4, f.x + f.w - 5, f.y + 13, darker(col, 0.8));
  }
}

function paintScientist(
  p: Painter,
  spec: CharacterSpec,
  o: ScientistOutfit,
  m: BodyMetrics,
  rows: AtlasRows,
  rng: Rng,
): void {
  const coat = hex(o.coat);
  const shirt = hex(o.shirt);
  const trousers = hex(o.trousers);
  const skin = hex(spec.skin);
  const t = ATLAS.torso;
  const cx = t.x + t.w / 2; // 96: front centre is between 95 and 96
  const line = darker(coat, 0.68);
  const mirrorT = (x: number): number => mirror(x, t);

  p.fill(t, coat);
  clothShading(p, t, rng);

  const neckRow = t.y + 3;
  const chest = Math.round(rows.torso(m.shoulderY - 0.13 * m.scale));
  const belt = Math.round(rows.torso(rows.beltY));
  const hip = Math.round(rows.torso(m.hipY));
  const crotch = t.y + t.h - 2;

  // Collar round the neck.
  p.hline(t.x, t.x + t.w - 1, t.y + 1, lighter(coat, 0.06));
  p.hline(t.x, t.x + t.w - 1, t.y + 2, line);

  // Shirt opening down the front.
  // Open: a straight strip of shirt down to the belt, with lapels folded
  // back either side of its top half. Buttoned: a small V at the throat.
  const lapelEnd = o.coatOpen ? chest + 2 : neckRow + 7;
  const opening = (y: number): number => {
    if (o.coatOpen) return 4;
    return Math.max(0, Math.round(4 - ((y - neckRow) / 7) * 4));
  };
  const shirtBottom = o.coatOpen ? belt - 1 : neckRow + 7;
  for (let y = neckRow; y <= shirtBottom; y++) {
    const w = opening(y);
    for (let x = cx - w; x < cx + w; x++) {
      p.set(x, y, shirt);
    }
    if (w > 0) {
      p.set(cx - w - 1, y, line);
      p.set(cx + w, y, line);
    }
  }
  // Lapels: a band outside the opening that widens down to the chest, a
  // shade lighter, with its outer edge drawn.
  for (let y = neckRow; y <= lapelEnd; y++) {
    const k = (y - neckRow) / Math.max(1, lapelEnd - neckRow);
    const inner = opening(y) + 1;
    const outer = Math.round(inner + 1 + k * (o.coatOpen ? 4 : 2));
    for (let d = inner; d <= outer; d++) {
      p.set(cx - 1 - d, y, darker(coat, 0.93));
      p.set(cx + d, y, darker(coat, 0.93));
    }
  }
  // Collar points of the shirt.
  p.set(cx - 3, neckRow, lighter(shirt, 0.2));
  p.set(cx + 2, neckRow, lighter(shirt, 0.2));
  p.set(cx - 2, neckRow + 1, lighter(shirt, 0.2));
  p.set(cx + 1, neckRow + 1, lighter(shirt, 0.2));

  if (o.tie !== null) {
    const tie = hex(o.tie);
    const tieBottom = o.coatOpen ? belt - 4 : neckRow + 7;
    p.hline(cx - 1, cx, neckRow, darker(tie, 0.85));
    p.hline(cx - 2, cx + 1, neckRow + 1, tie);
    for (let y = neckRow + 2; y <= tieBottom; y++) {
      const w = y > tieBottom - 2 ? 0 : 1;
      for (let x = cx - 1 - w * 0; x <= cx; x++) {
        const stripe = o.tieStripes && (x + y) % 4 === 0;
        p.set(x, y, stripe ? lighter(tie, 0.35) : tie);
      }
      if (w > 0 && y > neckRow + 4) p.set(cx + 1, y, darker(tie, 0.75));
    }
  } else {
    // Open collar: a little skin at the throat.
    p.hline(cx - 2, cx + 1, neckRow, skin);
    p.hline(cx - 1, cx, neckRow + 1, darker(skin, 0.9));
  }

  if (!o.coatOpen) {
    // Button line and buttons.
    for (let y = neckRow + 8; y < crotch; y++) {
      p.set(cx, y, darker(coat, 0.8));
    }
    for (let y = neckRow + 12; y < hip; y += 8) {
      p.set(cx + 2, y, darker(coat, 0.6));
      p.set(cx + 2, y + 1, darker(coat, 0.8));
    }
  }

  // Below the belt: the trousers show between the coat panels.
  const front = o.coatOpen ? 5 : 0;
  for (let y = belt; y < t.y + t.h; y++) {
    const w = y >= hip ? (o.coatOpen ? 6 : 3) : front;
    for (let x = cx - w; x < cx + w; x++) {
      p.set(x, y, y <= belt + 1 && o.coatOpen ? [40, 30, 24] : trousers);
    }
  }
  if (o.coatOpen) {
    p.hline(cx - 1, cx, belt, [150, 140, 110]);
  }

  // Breast pocket on the character's left, with pens; badge on the right.
  const pkX = cx + 6;
  const pkY = chest;
  p.hline(pkX, pkX + 7, pkY, line);
  for (let y = pkY; y <= pkY + 7; y++) {
    p.set(pkX, y, darker(coat, 0.82));
    p.set(pkX + 7, y, darker(coat, 0.82));
  }
  p.hline(pkX, pkX + 7, pkY + 7, darker(coat, 0.82));
  const penCols: RGB[] = [
    [40, 60, 140],
    [30, 30, 32],
    [160, 40, 36],
  ];
  for (let i = 0; i < o.pens; i++) {
    const x = pkX + 2 + i * 2;
    p.vline(x, pkY - 2, pkY + 1, penCols[i]);
    p.set(x, pkY - 2, lighter(penCols[i], 0.3));
  }
  if (o.badge) {
    const bx = mirrorT(pkX + 6);
    const by = pkY + 1;
    for (let y = by; y <= by + 5; y++) {
      for (let x = bx; x <= bx + 4; x++) {
        p.set(x, y, [236, 236, 228]);
      }
    }
    p.hline(bx, bx + 4, by, [60, 110, 150]);
    p.set(bx + 1, by + 2, skin);
    p.set(bx + 1, by + 3, darker(skin, 0.8));
    p.hline(bx + 3, bx + 4, by + 2, [120, 120, 120]);
    p.hline(bx + 3, bx + 4, by + 4, [120, 120, 120]);
    p.set(bx + 2, by - 1, [90, 90, 90]);
  }
  // Side seams and a back seam.
  for (let y = t.y + 6; y < t.y + t.h; y++) {
    p.shade(t.x + 16, y, 0.9);
    p.shade(t.x + 48, y, 0.9);
    if (y > belt) p.shade(t.x, y, 0.9);
  }

  // Skirt: back at the middle of the band, front edges at both ends.
  const sk = ATLAS.skirt;
  p.fill(sk, coat);
  clothShading(p, sk, rng, 0.6);
  p.each(sk, (x, y, c) => {
    const a = aroundFromFront(x, sk); // 0 back, 1 front edge
    return scale(c, 1 - (1 - a) * 0.06);
  });
  p.hline(sk.x, sk.x + sk.w - 1, sk.y + sk.h - 1, darker(coat, 0.75));
  p.hline(sk.x, sk.x + sk.w - 1, sk.y + sk.h - 2, darker(coat, 0.92));
  // Front edges (facings).
  const gap = o.coatOpen ? 0.075 : 0.04;
  const e0 = Math.round(sk.x + gap * sk.w);
  const e1 = Math.round(sk.x + (1 - gap) * sk.w) - 1;
  for (let y = sk.y; y < sk.y + sk.h; y++) {
    p.set(e0, y, line);
    p.set(e1, y, line);
  }
  // Side pockets near the front of each side.
  for (const px of [sk.x + 11, mirror(sk.x + 11, sk) - 7]) {
    p.hline(px, px + 7, sk.y + 3, line);
    p.vline(px, sk.y + 3, sk.y + 9, darker(coat, 0.85));
    p.vline(px + 7, sk.y + 3, sk.y + 9, darker(coat, 0.85));
    p.hline(px, px + 7, sk.y + 9, darker(coat, 0.85));
  }
  // Back vent.
  p.vline(sk.x + sk.w / 2, sk.y + 12, sk.y + sk.h - 1, line);
  p.fill(ATLAS.lining, darker(coat, 0.78));

  // Sleeves: coat down to the cuff, a little wrist below.
  const arm = ATLAS.arm;
  p.fill(arm, coat);
  clothShading(p, arm, rng);
  const cuff = Math.round(rows.arm(m.upperArm + m.forearm)) - 2;
  p.hline(arm.x, arm.x + arm.w - 1, cuff, line);
  p.hline(arm.x, arm.x + arm.w - 1, cuff + 1, lighter(coat, 0.05));
  for (let y = cuff + 2; y < arm.y + arm.h; y++) {
    p.hline(arm.x, arm.x + arm.w - 1, y, darker(skin, 0.95));
  }
  const elbow = Math.round(rows.arm(m.upperArm));
  for (const dy of [-1, 1]) {
    p.hline(arm.x + 21, arm.x + 27, elbow + dy, darker(coat, 0.86));
  }
  const shoulderSeam = Math.round(rows.arm(0.02 * m.scale));
  p.hline(arm.x, arm.x + arm.w - 1, shoulderSeam, darker(coat, 0.88));

  paintTrousers(p, trousers, rows, m, rng, null, [0, 0, 0]);
  paintShoes(p, hex(o.shoes), false);
}

function paintGuard(
  p: Painter,
  spec: CharacterSpec,
  o: GuardOutfit,
  m: BodyMetrics,
  rows: AtlasRows,
  rng: Rng,
): void {
  const uni = hex(o.uniform);
  const trousers = hex(o.trousers);
  const accent = hex(o.accent);
  const skin = hex(spec.skin);
  const t = ATLAS.torso;
  const cx = t.x + t.w / 2;
  const line = darker(uni, 0.62);
  const mirrorT = (x: number): number => mirror(x, t);

  p.fill(t, uni);
  clothShading(p, t, rng);
  const neckRow = t.y + 3;
  const chest = Math.round(rows.torso(m.shoulderY - 0.12 * m.scale));
  const belt = Math.round(rows.torso(rows.beltY));

  // Collar and a dark undershirt at the throat.
  p.hline(t.x, t.x + t.w - 1, t.y + 1, lighter(uni, 0.06));
  p.hline(t.x, t.x + t.w - 1, t.y + 2, line);
  for (let y = neckRow; y <= neckRow + 4; y++) {
    const w = Math.max(0, 3 - (y - neckRow));
    for (let x = cx - w; x < cx + w; x++) {
      p.set(x, y, [36, 36, 38]);
    }
    p.set(cx - w - 1, y, lighter(uni, 0.1));
    p.set(cx + w, y, lighter(uni, 0.1));
  }
  // Placket and buttons.
  for (let y = neckRow + 4; y < belt; y++) {
    p.set(cx - 1, y, darker(uni, 0.85));
    if ((y - neckRow) % 6 === 0) p.set(cx, y, lighter(uni, 0.25));
  }
  // Two chest pockets with flaps.
  for (const px of [cx + 4, mirrorT(cx + 4) - 7]) {
    for (let y = chest; y <= chest + 8; y++) {
      p.set(px, y, line);
      p.set(px + 7, y, line);
    }
    p.hline(px, px + 7, chest + 8, line);
    for (let y = chest; y <= chest + 2; y++) {
      p.hline(px, px + 7, y, darker(uni, 0.88));
    }
    p.hline(px, px + 7, chest + 3, line);
    p.set(px + 3, chest + 2, lighter(uni, 0.3));
    p.set(px + 4, chest + 2, lighter(uni, 0.3));
  }
  // Plain name plate above the right pocket.
  p.hline(mirrorT(cx + 4) - 6, mirrorT(cx + 4) - 2, chest - 2, [176, 176, 168]);
  // Epaulettes on the shoulder tops.
  for (const ex of [t.x + 15, t.x + 47]) {
    for (let y = t.y; y <= t.y + 6; y++) {
      p.hline(ex, ex + 2, y, darker(uni, 0.78));
    }
    p.set(ex + 1, t.y + 1, lighter(uni, 0.3));
  }
  // Duty belt with a buckle, then trousers.
  for (let y = belt; y <= belt + 2; y++) {
    p.hline(t.x, t.x + t.w - 1, y, y === belt ? [44, 42, 40] : [26, 25, 24]);
  }
  p.hline(cx - 2, cx + 1, belt + 1, [150, 150, 145]);
  p.hline(cx - 2, cx + 1, belt, [120, 120, 116]);
  for (let y = belt + 3; y < t.y + t.h; y++) {
    p.hline(t.x, t.x + t.w - 1, y, trousers);
  }
  for (let y = belt + 3; y < t.y + t.h - 3; y++) {
    p.set(cx - 1, y, darker(trousers, 0.8));
  }
  // Back yoke seam and side seams.
  p.hline(t.x, t.x + 12, t.y + 10, darker(uni, 0.9));
  p.hline(t.x + 52, t.x + 63, t.y + 10, darker(uni, 0.9));
  for (let y = t.y + 6; y < belt; y++) {
    p.shade(t.x + 16, y, 0.9);
    p.shade(t.x + 48, y, 0.9);
  }

  // Sleeves with a plain shoulder patch; rolled sleeves show the forearm.
  const arm = ATLAS.arm;
  p.fill(arm, uni);
  clothShading(p, arm, rng);
  const patchTop = Math.round(rows.arm(0.07 * m.scale));
  // A plain rounded patch: dark field, accent border, no text or emblem.
  const px = arm.x + 5;
  for (let y = patchTop; y <= patchTop + 5; y++) {
    for (let x = px; x <= px + 5; x++) {
      const corner =
        (y === patchTop || y === patchTop + 5) && (x === px || x === px + 5);
      if (corner) continue;
      const border =
        y === patchTop || y === patchTop + 5 || x === px || x === px + 5;
      p.set(x, y, border ? darker(accent, 0.8) : darker(uni, 0.62));
    }
  }
  const elbow = Math.round(rows.arm(m.upperArm));
  if (o.sleevesRolled) {
    const roll = elbow - 3;
    p.hline(arm.x, arm.x + arm.w - 1, roll, darker(uni, 0.7));
    p.hline(arm.x, arm.x + arm.w - 1, roll + 1, lighter(uni, 0.1));
    p.hline(arm.x, arm.x + arm.w - 1, roll + 2, darker(uni, 0.8));
    for (let y = roll + 3; y < arm.y + arm.h; y++) {
      p.hline(
        arm.x,
        arm.x + arm.w - 1,
        y,
        scale(skin, 0.95 - (y - roll) * 0.002),
      );
    }
    // A watch on the wrist.
    const wrist = Math.round(rows.arm(m.upperArm + m.forearm)) - 2;
    p.hline(arm.x + 12, arm.x + 31, wrist, [30, 30, 30]);
    p.hline(arm.x + 14, arm.x + 17, wrist, [170, 170, 160]);
  } else {
    const cuff = Math.round(rows.arm(m.upperArm + m.forearm)) - 2;
    p.hline(arm.x, arm.x + arm.w - 1, cuff, line);
    for (let y = cuff + 1; y < arm.y + arm.h; y++) {
      p.hline(arm.x, arm.x + arm.w - 1, y, darker(skin, 0.95));
    }
    for (const dy of [-1, 1]) {
      p.hline(arm.x + 21, arm.x + 27, elbow + dy, darker(uni, 0.86));
    }
  }

  // Cap: plain crown with seams, darker brim.
  p.fill(ATLAS.cap, uni);
  for (let y = ATLAS.cap.y; y < ATLAS.cap.y + ATLAS.cap.h; y++) {
    p.set(ATLAS.cap.x + 4, y, darker(uni, 0.85));
    p.set(ATLAS.cap.x + 12, y, darker(uni, 0.85));
  }
  p.hline(ATLAS.cap.x, ATLAS.cap.x + 15, ATLAS.cap.y + 15, darker(uni, 0.7));
  p.fill(ATLAS.capBrim, darker(uni, 0.72));

  // Belt gear: radio (grille, light) and a black torch.
  const g = ATLAS.gear;
  p.fill(g, [46, 48, 50]);
  for (let y = g.y + 2; y < g.y + g.h - 2; y += 2) {
    p.hline(g.x + 3, g.x + 12, y, [30, 30, 32]);
  }
  p.set(g.x + 20, g.y + 3, [190, 60, 40]);
  p.c.frame(g.x, g.y, g.w, g.h, [70, 72, 74]);
  p.fill(ATLAS.gearDark, [28, 28, 30]);
  p.set(ATLAS.gearDark.x + 2, ATLAS.gearDark.y + 1, [80, 80, 84]);

  const shin = m.kneeY - m.ankleY;
  const bootTop = Math.round(
    rows.leg(m.hipY - m.kneeY + shin - 0.07 * m.scale),
  );
  paintTrousers(p, trousers, rows, m, rng, bootTop, hex(o.boots));
  paintShoes(p, hex(o.boots), true);
}
