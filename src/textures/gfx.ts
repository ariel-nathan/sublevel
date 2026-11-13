import { createRng, type Rng } from "../core/rng";

/** Colour as 0..255 floats. */
export type RGB = [number, number, number];

export const hex = (v: number): RGB => [
  (v >> 16) & 255,
  (v >> 8) & 255,
  v & 255,
];
export const scale = (c: RGB, f: number): RGB => [c[0] * f, c[1] * f, c[2] * f];
export const mix = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Tileable value noise. All lattices wrap, so results tile at the given periods. */
export class Noise {
  constructor(private readonly seed: number) {}

  private hash(x: number, y: number, salt: number): number {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
    h ^= Math.imul(this.seed ^ Math.imul(salt, 1013904223), 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h = Math.imul(h ^ (h >>> 16), 2654435761);
    return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
  }

  /** Value noise in 0..1; x, y in lattice units, wrapping at px, py. */
  value(x: number, y: number, px: number, py: number, salt = 0): number {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = smooth(x - x0);
    const fy = smooth(y - y0);
    const ax = ((x0 % px) + px) % px;
    const bx = (ax + 1) % px;
    const ay = ((y0 % py) + py) % py;
    const by = (ay + 1) % py;
    const top =
      this.hash(ax, ay, salt) * (1 - fx) + this.hash(bx, ay, salt) * fx;
    const bot =
      this.hash(ax, by, salt) * (1 - fx) + this.hash(bx, by, salt) * fx;
    return top * (1 - fy) + bot * fy;
  }

  /** Fractal noise in roughly 0..1; u, v in 0..1 over the texture. */
  fbm(
    u: number,
    v: number,
    px: number,
    py: number,
    octaves = 3,
    salt = 0,
  ): number {
    let sum = 0;
    let amp = 0.5;
    let total = 0;
    let fx = px;
    let fy = py;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.value(u * fx, v * fy, fx, fy, salt + o * 17);
      total += amp;
      amp *= 0.5;
      fx *= 2;
      fy *= 2;
    }
    return sum / total;
  }
}

/** A square float canvas with wrapping drawing primitives. */
export class Canvas {
  readonly data: Float32Array;
  /** Per-pixel cut-out alpha: 255 solid, 0 a hole. Only holes need setting. */
  readonly alpha: Uint8Array;
  constructor(
    readonly size: number,
    fill: RGB,
  ) {
    this.data = new Float32Array(size * size * 3);
    this.alpha = new Uint8Array(size * size).fill(255);
    for (let i = 0; i < size * size; i++) {
      this.data[i * 3] = fill[0];
      this.data[i * 3 + 1] = fill[1];
      this.data[i * 3 + 2] = fill[2];
    }
  }

  private wrap(v: number): number {
    const n = this.size;
    return ((Math.floor(v) % n) + n) % n;
  }

  get(x: number, y: number): RGB {
    const i = (this.wrap(y) * this.size + this.wrap(x)) * 3;
    return [this.data[i], this.data[i + 1], this.data[i + 2]];
  }

  set(x: number, y: number, c: RGB): void {
    const i = (this.wrap(y) * this.size + this.wrap(x)) * 3;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
  }

  /** Cut a see-through hole (alpha 0) at a pixel. */
  hole(x: number, y: number): void {
    this.alpha[this.wrap(y) * this.size + this.wrap(x)] = 0;
  }

  /** Blend a colour over a pixel. */
  blend(x: number, y: number, c: RGB, a: number): void {
    const i = (this.wrap(y) * this.size + this.wrap(x)) * 3;
    this.data[i] += (c[0] - this.data[i]) * a;
    this.data[i + 1] += (c[1] - this.data[i + 1]) * a;
    this.data[i + 2] += (c[2] - this.data[i + 2]) * a;
  }

  /** Multiply a pixel's brightness. */
  shade(x: number, y: number, f: number): void {
    const i = (this.wrap(y) * this.size + this.wrap(x)) * 3;
    this.data[i] *= f;
    this.data[i + 1] *= f;
    this.data[i + 2] *= f;
  }

  /** Visit every pixel; return a colour to replace it. */
  each(fn: (x: number, y: number, c: RGB) => RGB | void): void {
    const n = this.size;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = (y * n + x) * 3;
        const r = fn(x, y, [this.data[i], this.data[i + 1], this.data[i + 2]]);
        if (r) {
          this.data[i] = r[0];
          this.data[i + 1] = r[1];
          this.data[i + 2] = r[2];
        }
      }
    }
  }

  rect(x: number, y: number, w: number, h: number, c: RGB): void {
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) this.set(x + i, y + j, c);
  }

  mixRect(x: number, y: number, w: number, h: number, c: RGB, a: number): void {
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) this.blend(x + i, y + j, c, a);
  }

  shadeRect(x: number, y: number, w: number, h: number, f: number): void {
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) this.shade(x + i, y + j, f);
  }

  /** 1px rectangle outline. */
  frame(x: number, y: number, w: number, h: number, c: RGB): void {
    for (let i = 0; i < w; i++) {
      this.set(x + i, y, c);
      this.set(x + i, y + h - 1, c);
    }
    for (let j = 0; j < h; j++) {
      this.set(x, y + j, c);
      this.set(x + w - 1, y + j, c);
    }
  }

  /** Raised bevel inside a rectangle: light top/left, dark bottom/right. */
  bevel(
    x: number,
    y: number,
    w: number,
    h: number,
    hi: RGB,
    lo: RGB,
    a = 1,
  ): void {
    for (let i = 0; i < w; i++) {
      this.blend(x + i, y, hi, a);
      this.blend(x + i, y + h - 1, lo, a);
    }
    for (let j = 1; j < h - 1; j++) {
      this.blend(x, y + j, hi, a);
      this.blend(x + w - 1, y + j, lo, a);
    }
  }

  line(x0: number, y0: number, x1: number, y1: number, c: RGB, a = 1): void {
    let x = Math.round(x0);
    let y = Math.round(y0);
    const ex = Math.round(x1);
    const ey = Math.round(y1);
    const dx = Math.abs(ex - x);
    const dy = -Math.abs(ey - y);
    const sx = x < ex ? 1 : -1;
    const sy = y < ey ? 1 : -1;
    let err = dx + dy;
    for (let guard = 0; guard < 1000; guard++) {
      this.blend(x, y, c, a);
      if (x === ex && y === ey) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }

  /** Filled disc; (cx, cy) in pixel coordinates where pixel centres are +0.5. */
  disc(cx: number, cy: number, r: number, c: RGB, a = 1): void {
    for (let j = Math.floor(cy - r); j <= Math.ceil(cy + r); j++) {
      for (let i = Math.floor(cx - r); i <= Math.ceil(cx + r); i++) {
        const dx = i + 0.5 - cx;
        const dy = j + 0.5 - cy;
        if (dx * dx + dy * dy <= r * r) this.blend(i, j, c, a);
      }
    }
  }

  /** Per-pixel brightness jitter. */
  grain(rng: Rng, amount: number): void {
    this.each((_x, _y, c) => scale(c, 1 + (rng.next() - 0.5) * 2 * amount));
  }

  /** Scattered single-pixel speckles. */
  speckle(rng: Rng, count: number, c: RGB, a: number): void {
    for (let i = 0; i < count; i++) {
      this.blend(rng.int(0, this.size - 1), rng.int(0, this.size - 1), c, a);
    }
  }

  /** Short random scuff strokes. */
  scuffs(rng: Rng, count: number, c: RGB, a: number, len = 5): void {
    for (let i = 0; i < count; i++) {
      const x = rng.int(0, this.size - 1);
      const y = rng.int(0, this.size - 1);
      const l = rng.int(2, len);
      const ang = rng.range(-0.5, 0.5) + (rng.next() < 0.5 ? 0 : Math.PI / 2);
      this.line(x, y, x + Math.cos(ang) * l, y + Math.sin(ang) * l, c, a);
    }
  }

  /** Blend toward a tint where tileable noise is high: stains and grime. */
  grime(
    noise: Noise,
    px: number,
    py: number,
    salt: number,
    thresh: number,
    strength: number,
    tint: RGB,
  ): void {
    const n = this.size;
    this.each((x, y, c) => {
      const v = noise.fbm(x / n, y / n, px, py, 3, salt);
      const t = Math.max(0, v - thresh) / (1 - thresh);
      if (t <= 0) return;
      return mix(c, tint, Math.min(1, t * strength));
    });
  }

  /** Reduce to at most `colors` distinct colours (median cut), return RGBA8. */
  toRgba(colors: number): Uint8Array {
    const n = this.size * this.size;
    const chans = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
    const cl = (v: number) => Math.max(12, Math.min(244, Math.round(v)));
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) chans[c][i] = cl(this.data[i * 3 + c]);
    }
    const extent = (box: number[]): [number, number] => {
      let best = 0;
      let bestC = 0;
      for (let c = 0; c < 3; c++) {
        let lo = 255;
        let hi = 0;
        for (const i of box) {
          const v = chans[c][i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (hi - lo > best) {
          best = hi - lo;
          bestC = c;
        }
      }
      return [best, bestC];
    };
    const boxes: number[][] = [Array.from({ length: n }, (_, i) => i)];
    while (boxes.length < colors) {
      let pick = -1;
      let pickScore = 0;
      let pickChan = 0;
      for (let k = 0; k < boxes.length; k++) {
        const [e, c] = extent(boxes[k]);
        const score = e * Math.sqrt(boxes[k].length);
        if (e > 0 && score > pickScore) {
          pickScore = score;
          pick = k;
          pickChan = c;
        }
      }
      if (pick < 0) break;
      const box = boxes[pick];
      const ch = chans[pickChan];
      box.sort((i, j) => ch[i] - ch[j]);
      const mid = box.length >> 1;
      boxes.splice(pick, 1, box.slice(0, mid), box.slice(mid));
    }
    const out = new Uint8Array(n * 4);
    for (const box of boxes) {
      const m = box.length;
      const avg = [0, 0, 0];
      for (const i of box) for (let c = 0; c < 3; c++) avg[c] += chans[c][i];
      for (const i of box) {
        for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(avg[c] / m);
        out[i * 4 + 3] = this.alpha[i];
      }
    }
    return out;
  }
}

export interface GenContext {
  rng: Rng;
  noise: Noise;
}

export type Generator = (c: Canvas, g: GenContext) => void;

export function makeContext(seed: number, salt: number): GenContext {
  const s = (seed ^ salt) >>> 0;
  return { rng: createRng(s), noise: new Noise(s) };
}
