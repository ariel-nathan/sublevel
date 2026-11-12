/** Self-lit surfaces: light panel, buttons, monitor screen. */
import { type Canvas, type GenContext, type RGB, hex, mix, scale } from "./gfx";

export const lightPanel = (c: Canvas, g: GenContext): void => {
  const n = c.size;
  const { rng } = g;
  c.each((x, y) => {
    // faint lengthwise ribbing and a soft hot centre
    const rib = x % 3 === 0 ? 0.95 : 1;
    const dx = (x + 0.5 - n / 2) / (n / 2);
    const dy = (y + 0.5 - n / 2) / (n / 2);
    const glow = 1 - 0.1 * Math.min(1, dx * dx + dy * dy);
    return scale(hex(0xe9f4f8), rib * glow);
  });
  // slightly darker frame, 2px, symmetric across the wrap
  c.each((x, y, col) => {
    const edge = Math.min(x, y, n - 1 - x, n - 1 - y);
    if (edge === 0) return hex(0x9aa8ae);
    if (edge === 1) return hex(0xc3d1d6);
    if (edge === 2) return mix(col, hex(0xffffff), 0.12);
    return col;
  });
  c.grain(rng, 0.012);
};

function button(c: Canvas, g: GenContext, lit: RGB, rim: RGB, glow: RGB): void {
  const n = c.size;
  const { rng } = g;
  c.each((x, y) => {
    const dx = x + 0.5 - n / 2;
    const dy = y + 0.5 - n / 2;
    const r = Math.sqrt(dx * dx + dy * dy);
    const topLeft = dx + dy < 0;
    // bezel
    if (r > 15.2)
      return scale(
        hex(0x4b4f55),
        0.9 + 0.2 * g.noise.fbm(x / n, y / n, 4, 4, 2, 2),
      );
    if (r > 13.6) return topLeft ? hex(0x70757c) : hex(0x23262a);
    if (r > 12.4) return topLeft ? hex(0x23262a) : hex(0x70757c);
    // glow ring spilling past the lens
    if (r > 11) return mix(glow, hex(0x23262a), 0.15);
    if (r > 9.6) return rim;
    // lens: lit from within, hottest toward the centre
    const k = 1 - r / 10;
    return mix(lit, scale(lit, 1.12), k);
  });
  // gloss highlight
  c.disc(12.5, 12, 2.6, mix(lit, hex(0xffffff), 0.55), 0.85);
  c.disc(11.5, 11, 1.2, hex(0xffffff), 0.9);
  // corner screws
  for (const [sx, sy] of [
    [3, 3],
    [28, 3],
    [3, 28],
    [28, 28],
  ]) {
    c.set(sx, sy, hex(0x90959c));
    c.set(sx + 1, sy, hex(0x5f646b));
    c.set(sx, sy + 1, hex(0x5f646b));
    c.set(sx + 1, sy + 1, hex(0x2b2e33));
  }
  c.frame(0, 0, n, n, hex(0x1b1d20));
  c.grain(rng, 0.015);
}

export const buttonRed = (c: Canvas, g: GenContext): void =>
  button(c, g, hex(0xf0443b), hex(0xb02226), hex(0x8a2528));

export const buttonGreen = (c: Canvas, g: GenContext): void =>
  button(c, g, hex(0x46e26a), hex(0x1f9b3d), hex(0x1f7036));

export const monitorScreen = (c: Canvas, g: GenContext): void => {
  const n = c.size;
  const { rng } = g;
  const text = hex(0x7dff9a);
  const dim = hex(0x3fb868);
  // lines of abstract text blocks
  const lineYs: number[] = [];
  for (let y = 7; y < n - 8; y += 6) lineYs.push(y);
  for (let li = 0; li < lineYs.length; li++) {
    const y = lineYs[li];
    if (li === 0) {
      // inverse header bar
      c.rect(5, y - 1, n - 10, 5, dim);
      let hx = 7;
      while (hx < 34) {
        const w = rng.int(2, 5);
        c.rect(hx, y, w, 3, hex(0x0d2a18));
        hx += w + 2;
      }
      continue;
    }
    let x = 6 + (li % 3 === 0 ? 4 : 0);
    const limit = n - rng.int(8, 22);
    while (x < limit) {
      const w = rng.int(1, 4);
      c.rect(x, y, w, 3, rng.next() < 0.25 ? dim : text);
      x += w + 1 + (rng.next() < 0.22 ? 3 : 0);
    }
  }
  // cursor block
  c.rect(6, lineYs[lineYs.length - 1], 4, 3, hex(0xd8ffe0));
  // phosphor glow around the text
  const glow = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const p = c.get(x, y);
      glow[y * n + x] = p[1] > 150 ? 1 : 0;
    }
  }
  c.each((x, y, col) => {
    let near = 0;
    for (const [ox, oy] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ]) {
      near += glow[((y + oy + n) % n) * n + ((x + ox + n) % n)];
    }
    return near > 0 && col[1] < 100 ? mix(col, hex(0x1f6a3a), 0.5) : col;
  });
  // background tint, scanlines and curved-glass vignette
  c.each((x, y, col) => {
    const dx = (x + 0.5 - n / 2) / (n / 2);
    const dy = (y + 0.5 - n / 2) / (n / 2);
    const vig = 1 - 0.28 * Math.min(1, dx * dx * dx * dx + dy * dy * dy * dy);
    let f = vig * (y % 2 === 0 ? 1 : 0.84);
    if (col[1] < 60) f *= 1;
    return scale(col[1] < 60 ? mix(col, hex(0x174a2c), 0.9) : col, f);
  });
  c.each((_x, y, col) => (y % 29 === 0 ? scale(col, 1.18) : col));
  c.grain(rng, 0.03);
};
