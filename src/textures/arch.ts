/** Architectural surfaces: concrete, lab walls and floors, metal plates, signage. */
import { type Canvas, type GenContext, type RGB, hex, mix, scale } from "./gfx";

const SOLID_DARK = hex(0x2a2c2e);

/** Multiply every pixel by a smooth tileable tone field. */
function tone(
  c: Canvas,
  g: GenContext,
  px: number,
  py: number,
  lo: number,
  hi: number,
  salt = 1,
): void {
  const n = c.size;
  c.each((x, y, col) =>
    scale(col, lo + (hi - lo) * g.noise.fbm(x / n, y / n, px, py, 4, salt)),
  );
}

/** Random-walk crack that wraps around the tile. */
function crack(
  c: Canvas,
  g: GenContext,
  x: number,
  y: number,
  steps: number,
  angle: number,
  col: RGB,
  a: number,
): void {
  let ang = angle;
  for (let i = 0; i < steps; i++) {
    c.blend(x, y, col, a);
    ang += g.rng.range(-0.55, 0.55);
    x += Math.cos(ang);
    y += Math.sin(ang);
  }
}

export const concreteWall = (c: Canvas, g: GenContext): void => {
  const n = c.size;
  const { rng } = g;
  tone(c, g, 4, 4, 0.84, 1.16);
  // form boards: each board slightly different, dark seam, light lip below
  const boardTone = [1, 0.96, 1.04, 0.98];
  c.each((x, y, col) => {
    const b = Math.floor(y / 32);
    const grain = 0.97 + 0.06 * g.noise.fbm(x / n, y / n, 2, 64, 2, 9);
    return scale(col, boardTone[b] * grain);
  });
  for (let b = 0; b < 4; b++) {
    for (let x = 0; x < n; x++) {
      c.shade(x, b * 32, 0.7);
      c.shade(x, b * 32 + 31, 0.74);
      c.shade(x, b * 32 + 1, 1.1);
    }
  }
  // form-tie holes
  for (const [hx, hy] of [
    [32, 16],
    [96, 16],
    [32, 80],
    [96, 80],
  ]) {
    c.disc(hx + 0.5, hy + 0.5, 2.6, hex(0x3b3a37));
    c.disc(hx + 0.5, hy + 0.5, 1.4, hex(0x242321));
    c.set(hx + 2, hy + 2, hex(0xb4b0a6));
    c.set(hx + 1, hy + 3, hex(0xa6a298));
    c.blend(hx - 3, hy - 3, hex(0x6a6862), 0.7);
  }
  // water stains and grime
  c.grime(g.noise, 10, 2, 21, 0.52, 1.2, hex(0x5f5a50));
  c.grime(g.noise, 5, 3, 31, 0.6, 1.0, hex(0x6d6150));
  // chips
  for (let i = 0; i < 6; i++) {
    const x = rng.int(4, n - 6);
    const y = rng.int(4, n - 6);
    const w = rng.int(2, 4);
    const h = rng.int(2, 3);
    for (let j = 0; j < h; j++) {
      for (let k = 0; k < w; k++) c.blend(x + k, y + j, hex(0x55524b), 0.85);
    }
    for (let k = 0; k < w; k++) c.blend(x + k, y + h, hex(0xc4c0b6), 0.8);
  }
  c.speckle(rng, 160, hex(0x4a4741), 0.55);
  c.speckle(rng, 90, hex(0xc2beb2), 0.4);
  c.grain(rng, 0.035);
};

export const concreteFloor = (c: Canvas, g: GenContext): void => {
  const n = c.size;
  const { rng } = g;
  tone(c, g, 3, 3, 0.86, 1.14);
  c.grime(g.noise, 6, 6, 12, 0.55, 1.3, hex(0x45474a));
  // expansion joints through the middle (symmetric, away from the wrap edge)
  for (let i = 0; i < n; i++) {
    c.shade(i, 63, 0.62);
    c.shade(i, 64, 0.78);
    c.shade(i, 62, 1.1);
    c.shade(63, i, 0.62);
    c.shade(64, i, 0.78);
    c.shade(62, i, 1.1);
  }
  // cracks
  crack(c, g, 90, 10, 60, 1.9, hex(0x2c2d2f), 0.9);
  crack(c, g, 20, 100, 36, -0.4, hex(0x2c2d2f), 0.8);
  crack(c, g, 108, 80, 22, 2.6, hex(0x2c2d2f), 0.7);
  c.scuffs(rng, 90, hex(0x8c8d8b), 0.28, 7);
  c.scuffs(rng, 50, hex(0x303234), 0.3, 6);
  c.speckle(rng, 220, hex(0x3b3d3f), 0.5);
  c.speckle(rng, 80, hex(0x9a9b98), 0.3);
  c.grain(rng, 0.035);
};

export const ceilingPanel = (c: Canvas, g: GenContext): void => {
  const n = c.size;
  const { rng } = g;
  tone(c, g, 4, 4, 0.94, 1.04);
  // inner bevel next to the grid: tiles are 32 wide, bars 2px wide on seams
  c.each((x, y, col) => {
    const dx = x % 32;
    const dy = y % 32;
    let f = 1;
    if (dx === 1 || dy === 1) f = 1.05;
    if (dx === 30 || dy === 30) f = 0.93;
    return scale(col, f);
  });
  c.speckle(rng, 130, hex(0x8f8e86), 0.8);
  c.speckle(rng, 60, hex(0xf0efe6), 0.6);
  for (let i = 0; i < 12; i++) {
    const x = rng.int(0, n - 1);
    const y = rng.int(0, n - 1);
    c.blend(x, y, hex(0x7b7a72), 0.8);
    c.blend(x + 1, y, hex(0x8f8e86), 0.6);
  }
  c.grime(g.noise, 3, 3, 8, 0.58, 1.0, hex(0xa49f8e));
  // grid bars centred on tile boundaries
  for (const b of [31, 63]) {
    for (let i = 0; i < n; i++) {
      c.set(b, i, hex(0x50555a));
      c.set(b + 1, i, hex(0x50555a));
      c.set(i, b, hex(0x50555a));
      c.set(i, b + 1, hex(0x50555a));
    }
  }
  c.grain(rng, 0.02);
};

export const labWall = (c: Canvas, g: GenContext): void => {
  const n = c.size;
  const { rng } = g;
  const paper = hex(0xdde2de);
  const teal = hex(0x3f7c7b);
  c.each((x, y) => {
    if (y < 36) return paper;
    if (y === 36) return hex(0xf6f8f5);
    if (y === 37) return hex(0xb9c4c2);
    if (y === 38) return hex(0x28585a);
    if (y < 62) return teal;
    if (y === 62) return hex(0x2b5c5d);
    return paper;
  });
  // painted-metal sheen: soft vertical tone
  tone(c, g, 2, 2, 0.95, 1.04);
  // wainscot shading under the trim, light at the bottom of the band
  for (let y = 39; y < 44; y++) c.shadeRect(0, y, n, 1, 0.97 - (44 - y) * 0.01);
  // panel seams: 2px grooves on the tile boundaries and the middle
  for (const sx of [31, 63]) {
    for (let y = 0; y < n; y++) {
      c.shade(sx, y, 0.72);
      c.shade(sx + 1, y, 0.78);
      c.shade(sx + 2, y, 1.06);
    }
  }
  // screws on the seams
  for (const sx of [31, 63]) {
    for (const sy of [8, 28, 48]) {
      c.blend(sx, sy, hex(0x8c9695), 1);
      c.blend(sx + 1, sy, hex(0xb9c2c0), 1);
      c.blend(sx, sy + 1, hex(0x6f7a79), 1);
      c.blend(sx + 1, sy + 1, hex(0x7e8887), 1);
    }
  }
  // grime above the floor line and scuffs
  c.grime(g.noise, 4, 4, 5, 0.58, 0.9, hex(0x9aa09a));
  c.scuffs(rng, 24, hex(0x9fb5b3), 0.35, 6);
  c.scuffs(rng, 20, hex(0x1f4748), 0.3, 5);
  c.speckle(rng, 50, hex(0xaeb4ae), 0.5);
  c.grain(rng, 0.018);
};

export const labFloorTile = (c: Canvas, g: GenContext): void => {
  const { rng } = g;
  const toneA = hex(0xb9c0be);
  const toneB = hex(0xa4adac);
  const tileJitter: number[] = [];
  for (let i = 0; i < 16; i++) tileJitter.push(1 + rng.range(-0.025, 0.025));
  c.each((x, y) => {
    const tx = Math.floor(x / 16);
    const ty = Math.floor(y / 16);
    const base = (tx + ty) % 2 === 0 ? toneA : toneB;
    return scale(base, tileJitter[ty * 4 + tx]);
  });
  tone(c, g, 4, 4, 0.96, 1.04);
  // terrazzo flecks
  c.speckle(rng, 90, hex(0x7f8a8a), 0.55);
  c.speckle(rng, 60, hex(0xdfe5e3), 0.55);
  c.scuffs(rng, 40, hex(0x6d7576), 0.3, 6);
  c.scuffs(rng, 24, hex(0xe6ebe9), 0.35, 5);
  c.grime(g.noise, 4, 4, 15, 0.6, 0.8, hex(0x8a9291));
  // edge light and grout (2px, centred on the tile boundaries)
  c.each((x, y, col) => {
    const dx = x % 16;
    const dy = y % 16;
    if (dx === 15 || dy === 15) return hex(0x4b5354);
    if (dx === 0 || dy === 0) return hex(0x636b6c);
    if (dx === 1 || dy === 1) return mix(col, hex(0xf2f6f4), 0.3);
    if (dx === 14 || dy === 14) return scale(col, 0.92);
    return col;
  });
  c.grain(rng, 0.02);
};

export const metalPanel = (c: Canvas, g: GenContext): void => {
  const n = c.size;
  const { rng } = g;
  // brushed grain: stretched horizontally
  c.each((x, y) => {
    const v = g.noise.fbm(x / n, y / n, 2, 64, 3, 4);
    const row = g.noise.value(x * 0.1, y, 6, 64, 5);
    return scale(hex(0x737b80), 0.8 + 0.5 * (v - 0.3) + 0.14 * row);
  });
  const frameZone = (x: number, y: number) =>
    x < 8 || x > 55 || y < 8 || y > 55;
  c.each((x, y, col) => (frameZone(x, y) ? scale(col, 1.1) : col));
  // raised frame bevel and recessed centre
  c.bevel(1, 1, 62, 62, hex(0xc3cacd), hex(0x424a4f));
  c.bevel(8, 8, 48, 48, hex(0x3c4449), hex(0xb2babd), 0.9);
  c.frame(0, 0, 64, 64, SOLID_DARK);
  // rivets
  for (const [rx, ry] of [
    [4, 4],
    [59, 4],
    [4, 59],
    [59, 59],
  ]) {
    c.disc(rx + 0.5, ry + 0.9, 2.3, hex(0x30373b));
    c.disc(rx + 0.5, ry + 0.5, 2.0, hex(0x9aa3a7));
    c.set(rx - 1, ry - 1, hex(0xdde3e5));
    c.set(rx, ry - 1, hex(0xc6cdd0));
    c.set(rx + 1, ry + 1, hex(0x677075));
  }
  c.grime(g.noise, 5, 5, 6, 0.57, 1.0, hex(0x4e5558));
  c.scuffs(rng, 34, hex(0xc4cacc), 0.3, 8);
  c.scuffs(rng, 18, hex(0x2f3538), 0.3, 6);
  c.grain(rng, 0.03);
};

export const metalGrate = (c: Canvas, g: GenContext): void => {
  const n = c.size;
  const { rng } = g;
  // the floor below, deep in the gaps
  c.each((x, y) =>
    scale(hex(0x2a2e31), 0.85 + 0.3 * g.noise.fbm(x / n, y / n, 8, 8, 2, 2)),
  );
  // cross rods
  c.each((x, y, col) => {
    const dy = y % 16;
    if (dy === 15) return hex(0x5a6267);
    if (dy === 0) return hex(0x5a6267);
    return col;
  });
  // bearing bars, centred on the tile boundary, 3px wide
  c.each((x, y, col) => {
    const dx = x % 8;
    const wear = 0.94 + 0.12 * g.noise.fbm(x / n, y / n, 8, 8, 2, 3);
    if (dx === 7) return scale(hex(0xa7b0b4), wear);
    if (dx === 0) return scale(hex(0x8c969a), wear);
    if (dx === 1) return scale(hex(0x555d61), wear);
    // shadow cast into the gap beside each bar
    if (dx === 2) return scale(col, 0.7);
    return col;
  });
  c.grime(g.noise, 6, 6, 9, 0.56, 0.7, hex(0x585d5f));
  c.speckle(rng, 30, hex(0x8a5f40), 0.7);
  c.scuffs(rng, 20, hex(0xc8d0d3), 0.3, 4);
  c.grain(rng, 0.03);
};

export const hazardStripe = (c: Canvas, g: GenContext): void => {
  const n = c.size;
  const { rng } = g;
  const yellow = hex(0xd6ab26);
  const black = hex(0x2a2a28);
  c.each((x, y) => {
    const d = (x + y) % 32;
    if (d === 0) return mix(yellow, hex(0xf2d56a), 0.5);
    if (d === 16) return mix(black, hex(0x585650), 0.5);
    return d < 16 ? yellow : black;
  });
  tone(c, g, 4, 4, 0.9, 1.06);
  // paint worn through to steel along the stripe edges
  c.each((x, y, col) => {
    const w = g.noise.fbm(x / n, y / n, 8, 8, 3, 7);
    if (w > 0.72) return mix(col, hex(0x6f7476), Math.min(0.8, (w - 0.72) * 8));
    return col;
  });
  c.grime(g.noise, 4, 4, 13, 0.52, 1.0, hex(0x6b5a30));
  c.scuffs(rng, 40, hex(0x8c8d86), 0.35, 8);
  c.scuffs(rng, 30, hex(0x131312), 0.3, 6);
  c.speckle(rng, 90, hex(0x45433c), 0.5);
  c.grain(rng, 0.03);
};

export const doorSteel = (c: Canvas, g: GenContext): void => {
  const n = c.size;
  const { rng } = g;
  c.each((x, y) => {
    const v = g.noise.fbm(x / n, y / n, 48, 2, 3, 3);
    return scale(hex(0x6a767c), 0.88 + 0.3 * v);
  });
  tone(c, g, 2, 2, 0.94, 1.05);
  // recessed panels
  for (const py of [6, 38]) {
    c.mixRect(9, py, 46, 20, hex(0x000000), 0.1);
    c.bevel(8, py - 1, 48, 22, hex(0x2f383d), hex(0xa4b1b6));
    c.bevel(9, py, 46, 20, hex(0x3d474c), hex(0x93a0a5), 0.6);
  }
  // horizontal band: muted teal paint, raised, with rivets
  c.rect(1, 29, 62, 6, hex(0x4a7f80));
  c.rect(1, 29, 62, 1, hex(0x7db0ae));
  c.rect(1, 34, 62, 1, hex(0x264b4d));
  c.rect(1, 35, 62, 1, hex(0x2d3438));
  c.rect(1, 28, 62, 1, hex(0x2d3438));
  for (const rx of [6, 18, 30, 42, 54]) {
    c.set(rx, 31, hex(0xb7d0cf));
    c.set(rx + 1, 31, hex(0x8ab0ae));
    c.set(rx, 32, hex(0x8ab0ae));
    c.set(rx + 1, 32, hex(0x2c5456));
  }
  // corner rivets on the panels
  for (const [rx, ry] of [
    [11, 8],
    [52, 8],
    [11, 23],
    [52, 23],
    [11, 40],
    [52, 40],
    [11, 55],
    [52, 55],
  ]) {
    c.set(rx, ry, hex(0xc4cdd0));
    c.set(rx + 1, ry, hex(0x8d979b));
    c.set(rx, ry + 1, hex(0x8d979b));
    c.set(rx + 1, ry + 1, hex(0x2c3438));
  }
  c.frame(0, 0, 64, 64, SOLID_DARK);
  // dirt gathers toward the bottom
  c.each((x, y, col) => {
    const d = ((y - 56 + 32 + 64) % 64) - 32;
    const k =
      Math.exp(-Math.abs(d) / 7) *
      (0.5 + g.noise.fbm(x / n, y / n, 6, 6, 2, 4));
    return mix(col, hex(0x4a4338), Math.min(0.6, k * 0.5));
  });
  c.grime(g.noise, 4, 4, 17, 0.6, 0.9, hex(0x4d5456));
  c.scuffs(rng, 30, hex(0xc3cbcd), 0.3, 8);
  c.scuffs(rng, 14, hex(0x252b2e), 0.3, 6);
  c.grain(rng, 0.025);
};

export const pressurePlate = (c: Canvas, g: GenContext): void => {
  const { rng } = g;
  c.each((x, y) => {
    const inner = x >= 4 && x < 28 && y >= 4 && y < 28;
    if (!inner) return hex(0xcaa024);
    const u = (x - 4) % 8;
    const v = (y - 4) % 8;
    const d = Math.abs(u - 3.5) + Math.abs(v - 3.5);
    if (d <= 3.5) {
      // raised diamond: lit on its upper-left faces
      return u + v < 7 ? hex(0xaab2b5) : hex(0x7f888c);
    }
    return hex(0x3f464a);
  });
  // yellow border bevel and outline
  c.bevel(1, 1, 30, 30, hex(0xe9cb5a), hex(0x93720f));
  c.bevel(3, 3, 26, 26, hex(0x2e3437), hex(0xb9c1c4), 0.8);
  c.frame(0, 0, 32, 32, hex(0x3a2f10));
  c.grime(g.noise, 3, 3, 3, 0.52, 1.0, hex(0x5a4a1c));
  c.scuffs(rng, 16, hex(0xcfd5d7), 0.3, 4);
  c.scuffs(rng, 10, hex(0x1f2325), 0.3, 4);
  c.grain(rng, 0.03);
};

export const signWarning = (c: Canvas, g: GenContext): void => {
  const n = c.size;
  const { rng } = g;
  const yellow = hex(0xe0b929);
  const black = hex(0x26262a);
  const insideTri = (
    x: number,
    y: number,
    top: number,
    bot: number,
    hb: number,
  ) =>
    y >= top &&
    y <= bot &&
    Math.abs(x - 31.5) <= ((y - top) * hb) / (bot - top);
  c.each((x, y) => {
    // 4px black border, rounded corners faked by yellow-free corner
    const edge = Math.min(x, y, n - 1 - x, n - 1 - y);
    if (edge < 4) return black;
    if (edge === 4) return mix(yellow, hex(0xb08f1c), 0.5);
    const outer = insideTri(x + 0.5, y + 0.5, 9, 55, 27);
    const inner = insideTri(x + 0.5, y + 0.5, 17, 51, 19.5);
    if (outer && !inner) return black;
    if (inner) {
      // exclamation mark
      const bar = x >= 30 && x <= 33 && y >= 28 && y <= 41;
      const dot = x >= 30 && x <= 33 && y >= 44 && y <= 47;
      if (bar || dot) return black;
    }
    return yellow;
  });
  tone(c, g, 3, 3, 0.94, 1.04);
  // screws at the top corners of the yellow field
  for (const [sx, sy] of [
    [8, 8],
    [54, 8],
    [8, 54],
    [54, 54],
  ]) {
    c.set(sx, sy, hex(0x6a5c18));
    c.set(sx + 1, sy + 1, hex(0xf0d56a));
  }
  c.grime(g.noise, 4, 4, 23, 0.55, 1.0, hex(0x7d6a20));
  // flaked paint and scratches
  c.scuffs(rng, 24, hex(0x85867f), 0.55, 4);
  c.scuffs(rng, 20, hex(0xf3dc7a), 0.3, 6);
  c.speckle(rng, 70, hex(0x3d3519), 0.5);
  c.grain(rng, 0.03);
};
