/**
 * Where everything lives in a character's 128 x 128 texture atlas, and the
 * row/column conventions shared by the body builder and the painter.
 *
 * Wrapped parts (head, trunk, limbs) run around the body with the back seam
 * at the band's left and right edges, the character's right side at a
 * quarter of the width, the front at the middle and the left side at three
 * quarters (so the front reads unmirrored from outside). Rows run top to
 * bottom.
 */
import type { Rect } from "./geometry";

export const ATLAS_SIZE = 128;

const r = (x: number, y: number, w: number, h: number): Rect => ({
  x,
  y,
  w,
  h,
});

export const ATLAS = {
  /** Crown (row 0) to the mouth line (row 44). */
  head: r(0, 0, 64, 44),
  /** Mouth line (row 44) to under the chin (row 56). */
  jaw: r(0, 44, 64, 12),
  /** Shoulders/yoke (rows 0-6), shoulder line (row 6) to crotch (row 62). */
  torso: r(64, 0, 64, 64),
  /** Coat skirt: waist (row 64) to hem (row 88); the back is at the middle. */
  skirt: r(64, 64, 64, 24),
  /** Shoulder top (row 64) to wrist (row 112); shared by both arms. */
  arm: r(0, 64, 32, 48),
  hand: r(32, 64, 16, 16),
  cap: r(48, 64, 16, 16),
  neck: r(32, 80, 16, 8),
  /** Heel (row 88) to toe (row 104), around the shoe from the top. */
  foot: r(32, 88, 32, 16),
  /** Hip (row 88) to ankle (row 128); shared by both legs. */
  leg: r(64, 88, 32, 40),
  /** Ponytail or long hair at the back of the head. */
  hairPiece: r(0, 112, 32, 16),
  /** Radio and torch faces. */
  gear: r(96, 88, 32, 16),
  // Plain swatches.
  mouth: r(0, 56, 8, 8),
  hair: r(8, 56, 8, 8),
  skin: r(16, 56, 8, 8),
  capBrim: r(24, 56, 8, 8),
  gearDark: r(32, 56, 8, 8),
  lining: r(40, 56, 8, 8),
  sole: r(48, 56, 8, 8),
  trouser: r(56, 56, 8, 8),
} as const;

/** Atlas column of each head seam (8 sides): the face gets the most texels. */
export const HEAD_COLUMNS: readonly number[] = [
  0, 6, 12, 20, 32, 44, 52, 58, 64,
];

/** Heights on the head, as fractions of chin (0) to crown (1). */
export const HEAD_LEVELS = {
  mouth: 0.26,
  nose: 0.4,
  eyes: 0.56,
  brow: 0.62,
  forehead: 0.78,
  hairline: 0.86,
  crown: 0.94,
  chinFront: 0.12,
  chin: 0.02,
} as const;

/** Atlas rows of the head and jaw rings. */
export const HEAD_ROWS = {
  apex: 0,
  crown: 3,
  forehead: 13,
  eyes: 26,
  nose: 36,
  mouth: 44,
  chinFront: 50,
  chin: 55,
} as const;

/** Atlas row on the head band for a height fraction on the head (piecewise linear). */
export function headRow(f: number): number {
  const keys: [number, number][] = [
    [HEAD_LEVELS.chin, HEAD_ROWS.chin],
    [HEAD_LEVELS.chinFront, HEAD_ROWS.chinFront],
    [HEAD_LEVELS.mouth, HEAD_ROWS.mouth],
    [HEAD_LEVELS.nose, HEAD_ROWS.nose],
    [HEAD_LEVELS.eyes, HEAD_ROWS.eyes],
    [HEAD_LEVELS.forehead, HEAD_ROWS.forehead],
    [HEAD_LEVELS.crown, HEAD_ROWS.crown],
    [1, HEAD_ROWS.apex],
  ];
  if (f <= keys[0][0]) {
    return keys[0][1];
  }
  for (let i = 0; i + 1 < keys.length; i++) {
    const [f0, r0] = keys[i];
    const [f1, r1] = keys[i + 1];
    if (f <= f1) {
      return r0 + ((f - f0) / (f1 - f0)) * (r1 - r0);
    }
  }
  return keys[keys.length - 1][1];
}
