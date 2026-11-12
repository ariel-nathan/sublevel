/** Prop surfaces: crates, barrels, pipe, plastic and rubber. */
import { type Canvas, type GenContext, type RGB, hex, mix, scale } from "./gfx";

const OUTLINE_WOOD = hex(0x2c1c12);

function nail(c: Canvas, x: number, y: number): void {
  c.set(x, y, hex(0xb9b2a4));
  c.set(x + 1, y, hex(0x7d776c));
  c.set(x, y + 1, hex(0x7d776c));
  c.set(x + 1, y + 1, hex(0x2c2218));
}

export const crateWood = (c: Canvas, g: GenContext): void => {
  const n = c.size;
  const { rng } = g;
  const planks = [1, 0.93, 1.06];
  c.each((x, y) => {
    const side = x < 7 || x > 56;
    const frame = side || y < 7 || y > 56;
    // grain runs along each board
    const grain = side
      ? g.noise.fbm(x / n, y / n, 48, 2, 3, 5)
      : g.noise.fbm(x / n, y / n, 2, 48, 3, 6);
    let t = 0.82 + 0.4 * grain;
    if (!frame) t *= planks[Math.min(2, Math.floor((y - 7) / 17))];
    return scale(frame ? hex(0xa8743f) : hex(0x946336), t);
  });
  // plank gaps inside the frame
  for (const py of [24, 41]) {
    for (let x = 8; x < 56; x++) {
      c.shade(x, py, 0.55);
      c.shade(x, py + 1, 1.12);
    }
  }
  // diagonal brace with outline
  c.each((x, y, col) => {
    if (x < 8 || x > 55 || y < 8 || y > 55) return;
    const d = x - y;
    if (Math.abs(d) <= 3) {
      const grain = g.noise.fbm(x / n, y / n, 12, 12, 2, 8);
      return scale(hex(0xb68148), 0.88 + 0.25 * grain + (d < -1 ? 0.08 : 0));
    }
    if (d === 4) return scale(col, 0.45);
    if (d === -4) return scale(col, 0.55);
    return col;
  });
  // frame inner edge groove, outer outline
  for (let i = 7; i < 57; i++) {
    c.shade(i, 7, 0.5);
    c.shade(7, i, 0.5);
    c.shade(i, 56, 1.15);
    c.shade(56, i, 1.15);
  }
  c.bevel(1, 1, 62, 62, hex(0xd9a265), hex(0x6a4322), 0.8);
  c.frame(0, 0, 64, 64, OUTLINE_WOOD);
  for (const [nx, ny] of [
    [3, 3],
    [58, 3],
    [3, 58],
    [58, 58],
    [3, 30],
    [58, 30],
    [30, 3],
    [30, 58],
  ]) {
    nail(c, nx, ny);
  }
  nail(c, 12, 12);
  nail(c, 50, 50);
  c.grime(g.noise, 4, 4, 11, 0.55, 1.0, hex(0x5e3d20));
  c.scuffs(rng, 28, hex(0xd6a56b), 0.3, 7);
  c.scuffs(rng, 20, hex(0x3b2412), 0.3, 6);
  c.grain(rng, 0.03);
};

function crackLine(
  c: Canvas,
  g: GenContext,
  x: number,
  y: number,
  steps: number,
  angle: number,
  jag: number,
): void {
  let ang = angle;
  for (let i = 0; i < steps; i++) {
    c.set(x, y, hex(0x2a1a10));
    c.blend(x + 1, y, hex(0xe8cf9c), 0.7);
    c.blend(x, y + 1, hex(0x4a3320), 0.5);
    ang = angle + g.rng.range(-jag, jag);
    x += Math.cos(ang) * 1.2;
    y += Math.sin(ang) * 1.2;
  }
}

export const crateWoodWeak = (c: Canvas, g: GenContext): void => {
  const n = c.size;
  const { rng } = g;
  const dark = hex(0x2b1d12);
  // vertical boards with gaps
  const boardTone = [1, 0.9, 1.07, 0.95];
  c.each((x, y) => {
    const frameY = y < 6 || y > 57;
    const grain = frameY
      ? g.noise.fbm(x / n, y / n, 2, 48, 3, 5)
      : g.noise.fbm(x / n, y / n, 48, 2, 3, 6);
    const b = Math.min(3, Math.floor(x / 16));
    return scale(
      mix(hex(0xc4a578), hex(0xa28b66), g.noise.fbm(x / n, y / n, 3, 3, 2, 3)),
      (0.84 + 0.36 * grain) * (frameY ? 1 : boardTone[b]),
    );
  });
  // board gaps (dark slots) and highlights on the board edges
  for (let b = 0; b < 4; b++) {
    const gx = b * 16;
    for (let y = 6; y < 58; y++) {
      c.set(gx, y, dark);
      c.shade(gx + 1, y, 1.18);
      c.shade(gx + 15, y, 0.82);
    }
  }
  // top and bottom rails
  for (let x = 0; x < n; x++) {
    c.shade(x, 5, 0.55);
    c.shade(x, 6, 1.2);
    c.shade(x, 57, 0.55);
    c.shade(x, 58, 1.2);
  }
  // diagonal brace, broken near the middle
  c.each((x, y, col) => {
    if (y < 8 || y > 55) return;
    const d = x - y;
    const mid = y > 28 && y < 36;
    if (Math.abs(d) <= 3 && !mid) {
      return scale(
        hex(0xb59a6a),
        0.9 + 0.2 * g.noise.fbm(x / n, y / n, 12, 12, 2, 8),
      );
    }
    if (d === 4 && !mid) return scale(col, 0.5);
    if (d === -4 && !mid) return scale(col, 0.55);
    return col;
  });
  // the break: missing wood with splinters
  for (let y = 29; y < 35; y++) {
    for (let x = y - 3; x <= y + 3; x++) {
      if ((x + y) % 3 !== 0) c.blend(x, y, dark, 0.8);
    }
  }
  c.set(27, 28, hex(0xe0c996));
  c.set(33, 36, hex(0xe0c996));
  c.set(28, 29, hex(0xe0c996));
  // cracks and splinters
  crackLine(c, g, 24, 10, 20, 1.4, 0.45);
  crackLine(c, g, 40, 20, 28, 1.7, 0.5);
  crackLine(c, g, 56, 40, 18, 2.0, 0.5);
  crackLine(c, g, 8, 42, 14, 1.2, 0.45);
  // splintered corner
  for (let j = 0; j < 7; j++) {
    for (let i = 0; i < 7 - j; i++) {
      if ((i * 3 + j * 5) % 4 !== 0) c.blend(58 + i, 57 + j - 3, dark, 0.8);
    }
  }
  c.set(57, 60, hex(0xe8d3a4));
  c.set(55, 61, hex(0xe8d3a4));
  // nails with rust runs
  for (const [nx, ny] of [
    [4, 2],
    [58, 2],
    [4, 59],
    [18, 2],
    [44, 59],
  ]) {
    nail(c, nx, ny);
    c.line(nx, ny + 2, nx, ny + 7, hex(0x8a4a22), 0.55);
  }
  c.frame(0, 0, 64, 64, dark);
  c.grime(g.noise, 4, 4, 11, 0.5, 1.0, hex(0x7a6444));
  c.scuffs(rng, 24, hex(0xe0cca0), 0.3, 6);
  c.scuffs(rng, 20, hex(0x4a3822), 0.3, 6);
  c.grain(rng, 0.035);
};

export const crateMetal = (c: Canvas, g: GenContext): void => {
  const n = c.size;
  const { rng } = g;
  const dark = hex(0x20241e);
  c.each((x, y) => {
    const v = g.noise.fbm(x / n, y / n, 3, 3, 3, 4);
    return scale(hex(0x6f7a5f), 0.88 + 0.26 * v);
  });
  // recessed centre panel with embossed ribs
  c.mixRect(7, 7, 50, 50, hex(0x000000), 0.1);
  c.bevel(6, 6, 52, 52, hex(0x2d3326), hex(0xa7b394));
  for (const ry of [14, 49]) {
    for (let x = 9; x < 55; x++) {
      c.blend(x, ry, hex(0xb1bd9e), 0.8);
      c.blend(x, ry + 1, hex(0x2d3326), 0.8);
    }
  }
  // reinforced edge band
  c.each((x, y, col) => {
    const edge = Math.min(x, y, 63 - x, 63 - y);
    if (edge < 5) return scale(mix(col, hex(0x8b9780), 0.5), 1.05);
    return col;
  });
  c.bevel(1, 1, 62, 62, hex(0xc7d3b4), hex(0x353c2c));
  // corner brackets
  for (const [cx, cy] of [
    [0, 0],
    [54, 0],
    [0, 54],
    [54, 54],
  ]) {
    c.mixRect(cx, cy, 10, 10, hex(0xb5c1a2), 0.22);
    c.bevel(cx, cy, 10, 10, hex(0xd2ddc0), hex(0x2b3125), 0.9);
    c.set(cx + 4, cy + 4, hex(0xd8e2c8));
    c.set(cx + 5, cy + 4, hex(0x9aa688));
    c.set(cx + 4, cy + 5, hex(0x9aa688));
    c.set(cx + 5, cy + 5, hex(0x2b3125));
  }
  // stencil marks (abstract blocks)
  const stencil = hex(0xcbc08a);
  c.rect(14, 20, 16, 3, stencil);
  c.rect(14, 25, 9, 3, stencil);
  c.rect(26, 25, 4, 3, stencil);
  c.rect(40, 20, 3, 8, stencil);
  c.rect(45, 20, 3, 8, stencil);
  c.mixRect(14, 20, 34, 9, hex(0x202416), 0.0);
  // latch: plate, hasp and ring
  c.rect(22, 36, 20, 10, hex(0x4a5340));
  c.bevel(22, 36, 20, 10, hex(0xb3bfa1), hex(0x1e231a));
  c.rect(28, 33, 8, 14, hex(0x9aa68a));
  c.bevel(28, 33, 8, 14, hex(0xdbe5cb), hex(0x2a3022));
  c.rect(30, 38, 4, 3, hex(0x1c2018));
  c.set(30, 41, hex(0xc8d3b6));
  c.set(33, 41, hex(0xc8d3b6));
  c.frame(0, 0, 64, 64, dark);
  c.grime(g.noise, 4, 4, 14, 0.55, 1.0, hex(0x4e5640));
  // chipped paint
  c.speckle(rng, 40, hex(0xa6aca0), 0.7);
  c.scuffs(rng, 24, hex(0xcad4ba), 0.3, 6);
  c.scuffs(rng, 14, hex(0x232819), 0.3, 6);
  c.grain(rng, 0.025);
};

export const barrelSide = (c: Canvas, g: GenContext): void => {
  const n = c.size;
  const { rng } = g;
  const paint = hex(0x3f6c87);
  c.each((x, y) => {
    const v = g.noise.fbm(x / n, y / n, 6, 6, 3, 4);
    return scale(paint, 0.88 + 0.26 * v);
  });
  // coloured band around the middle
  c.each((x, y, col) => {
    if (y >= 27 && y <= 38) return mix(col, hex(0xd4892f), 0.92);
    if (y === 26 || y === 39) return scale(col, 0.7);
    return col;
  });
  // abstract stencil blocks on the band
  for (const [bx, bw] of [
    [6, 5],
    [14, 3],
    [20, 7],
    [34, 4],
    [42, 6],
    [52, 3],
  ]) {
    c.rect(bx, 30, bw, 5, hex(0x2a2a26));
    c.rect(bx, 30, bw, 1, hex(0x4a4a44));
  }
  // raised ribs
  for (const ry of [14, 50]) {
    c.rect(0, ry - 1, n, 1, hex(0x1d3646));
    c.rect(0, ry, n, 1, hex(0x7fb0cc));
    c.rect(0, ry + 1, n, 2, scale(paint, 1.1));
    c.rect(0, ry + 3, n, 1, hex(0x1d3646));
    c.shadeRect(0, ry + 4, n, 1, 0.8);
  }
  // paint chips and scratches
  for (let i = 0; i < 14; i++) {
    const x = rng.int(0, n - 1);
    const y = rng.int(4, n - 5);
    c.blend(x, y, hex(0x8a8f92), 0.9);
    c.blend(x + 1, y, hex(0x8a8f92), 0.7);
    c.blend(x, y + 1, hex(0x30343a), 0.7);
  }
  // rust gathering at the top and bottom edges (symmetric over the wrap)
  c.each((x, y, col) => {
    const d = ((y - 62 + 32 + 64) % 64) - 32;
    const k =
      Math.exp(-Math.abs(d) / 5) *
      (0.35 + 1.1 * g.noise.fbm(x / n, y / n, 12, 12, 3, 9));
    if (k > 0.55)
      return mix(col, hex(0x8a4a26), Math.min(0.9, (k - 0.45) * 1.6));
    if (k > 0.4) return mix(col, hex(0x5a4a3a), 0.5);
    return col;
  });
  c.grime(g.noise, 5, 5, 6, 0.6, 0.9, hex(0x24384a));
  c.scuffs(rng, 20, hex(0xa9cde0), 0.28, 8);
  c.grain(rng, 0.03);
};

export const barrelTop = (c: Canvas, g: GenContext): void => {
  const n = c.size;
  const { rng } = g;
  const lid = hex(0x4c5c68);
  c.each((x, y) => {
    const dx = x + 0.5 - 32;
    const dy = y + 0.5 - 32;
    const r = Math.sqrt(dx * dx + dy * dy);
    const lit = dx + dy < 0;
    if (r > 30) return lid;
    if (r > 29) return hex(0x1e2830);
    if (r > 26) return lit ? hex(0xa7bccb) : hex(0x5d7282);
    if (r > 25) return hex(0x1e2830);
    if (r > 22) return lit ? hex(0x6f8393) : hex(0x8aa0b0);
    if (r > 21) return hex(0x263340);
    return scale(
      hex(0x7a8d9b),
      0.9 + 0.2 * g.noise.fbm(x / n, y / n, 4, 4, 2, 3),
    );
  });
  // concentric rolled-in ring
  c.each((x, y, col) => {
    const dx = x + 0.5 - 32;
    const dy = y + 0.5 - 32;
    const r = Math.sqrt(dx * dx + dy * dy);
    if (r > 14 && r < 15.4) return scale(col, dx + dy < 0 ? 1.15 : 0.7);
    return col;
  });
  // bungs
  for (const [bx, by, br] of [
    [22, 25, 5],
    [43, 40, 4],
  ]) {
    c.disc(bx + 0.5, by + 0.9, br + 0.6, hex(0x1d252d));
    c.disc(bx + 0.5, by + 0.5, br, hex(0x9fb2c0));
    c.disc(bx + 0.5, by + 0.5, br - 1.6, hex(0x657886));
    c.rect(bx - 1, by, 3, 1, hex(0xc3d2dc));
    c.rect(bx, by - 1, 1, 3, hex(0xc3d2dc));
    c.set(bx - br + 1, by - 1, hex(0xdbe6ee));
  }
  c.grime(g.noise, 4, 4, 22, 0.58, 1.0, hex(0x38444e));
  c.scuffs(rng, 20, hex(0xc9d8e2), 0.25, 6);
  c.grain(rng, 0.025);
};

export const pipe = (c: Canvas, g: GenContext): void => {
  const n = c.size;
  const { rng } = g;
  const paint = hex(0x5f8f90);
  // quantised cylinder shading across y (periodic, so it tiles)
  c.each((x, y) => {
    const f = 0.78 + 0.3 * Math.cos(((y - 18) / n) * Math.PI * 2);
    const q = Math.round(f * 7) / 7;
    const v = g.noise.fbm(x / n, y / n, 3, 12, 2, 4);
    return scale(paint, q * (0.96 + 0.08 * v));
  });
  // specular streak
  for (let x = 0; x < n; x++) {
    c.blend(x, 16, hex(0xe0f0ee), 0.55);
    c.blend(x, 17, hex(0xe0f0ee), 0.3);
  }
  // flange band
  c.each((x, y, col) => {
    if (x < 26 || x > 37) return;
    const dx = x - 26;
    if (dx === 0) return scale(col, 0.45);
    if (dx === 1) return scale(mix(col, hex(0xd8e6e4), 0.35), 1.15);
    if (dx === 10) return scale(col, 0.8);
    if (dx === 11) return scale(col, 0.4);
    return scale(mix(col, hex(0xa9b4b4), 0.4), 1.0);
  });
  for (const by of [6, 22, 38, 54]) {
    c.disc(32, by + 0.5, 2.2, hex(0x2a3434));
    c.disc(31.6, by + 0.1, 1.7, hex(0x9eaaa9));
    c.set(30, by - 1, hex(0xe6efee));
  }
  c.grime(g.noise, 3, 6, 18, 0.56, 1.0, hex(0x3a4f4e));
  c.speckle(rng, 24, hex(0x8a5a38), 0.7);
  c.scuffs(rng, 16, hex(0xd2e4e2), 0.3, 8);
  c.grain(rng, 0.025);
};

export const plasticWhite = (c: Canvas, g: GenContext): void => {
  const n = c.size;
  const { rng } = g;
  c.each((x, y) => {
    const v = g.noise.fbm(x / n, y / n, 2, 2, 3, 4);
    return scale(hex(0xd5cfb9), 0.93 + 0.12 * v);
  });
  c.speckle(rng, 40, hex(0xa9a28c), 0.6);
  c.speckle(rng, 30, hex(0xf4f0e0), 0.7);
  c.grime(g.noise, 2, 2, 5, 0.6, 0.8, hex(0xb7ae92));
  c.grain(rng, 0.02);
};

export const rubberDark = (c: Canvas, g: GenContext): void => {
  const n = c.size;
  const { rng } = g;
  c.each((x, y) => {
    const v = g.noise.fbm(x / n, y / n, 4, 4, 2, 4);
    let t = 0.85 + 0.3 * v;
    if ((x + y) % 4 === 0) t *= 1.22;
    if ((x - y + 64) % 4 === 0) t *= 0.86;
    return scale(hex(0x2e2f33), t);
  });
  c.speckle(rng, 40, hex(0x5d5f66), 0.5);
  c.grain(rng, 0.12);
};
