/**
 * Dev-only preview: writes PNGs of the level to out/ (run with
 * `bun src/level/preview.ts`). Not imported by the game.
 */
import { writePng } from "../../tools/png";
import { PROP_SPECS } from "../core/props";
import { buildLevel } from "./index";
import { boxOf, propBox, type Box } from "./geometry";

const PPM = 40;
const X0 = -5;
const X1 = 17.5;
const Z0 = -4;
const Z1 = 17.5;
const W = Math.round((X1 - X0) * PPM);
const H = Math.round((Z1 - Z0) * PPM);

type Rgb = readonly [number, number, number];

class Canvas {
  readonly data: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
    bg: Rgb,
  ) {
    this.data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      this.data.set([bg[0], bg[1], bg[2], 255], i * 4);
    }
  }
  px(x: number, y: number, c: Rgb): void {
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.data.set([c[0], c[1], c[2], 255], (y * this.w + x) * 4);
  }
  rect(x0: number, y0: number, x1: number, y1: number, c: Rgb): void {
    for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
      for (let x = Math.floor(x0); x < Math.ceil(x1); x++) this.px(x, y, c);
    }
  }
  outline(x0: number, y0: number, x1: number, y1: number, c: Rgb): void {
    this.rect(x0, y0, x1, y0 + 1, c);
    this.rect(x0, y1 - 1, x1, y1, c);
    this.rect(x0, y0, x0 + 1, y1, c);
    this.rect(x1 - 1, y0, x1, y1, c);
  }
  line(x0: number, y0: number, x1: number, y1: number, c: Rgb): void {
    const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)));
    for (let i = 0; i <= n; i++) {
      const t = n === 0 ? 0 : i / n;
      this.px(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, c);
    }
  }
  disc(cx: number, cy: number, r: number, c: Rgb): void {
    for (let y = -r; y <= r; y++) {
      for (let x = -r; x <= r; x++) {
        if (x * x + y * y <= r * r) this.px(cx + x, cy + y, c);
      }
    }
  }
}

const mx = (x: number) => (x - X0) * PPM;
const mz = (z: number) => (z - Z0) * PPM;

const level = buildLevel();
const { data } = level;
const boxes = data.brushes.map(boxOf);

function mapImage(): Canvas {
  const c = new Canvas(W, H, [8, 8, 12]);
  // Floor-level walkable space (a floor slab under the cut) vs solid at 1 m.
  const floors = boxes.filter((b) => Math.abs(b.y1) < 1e-6);
  for (let py = 0; py < H; py++) {
    for (let pxl = 0; pxl < W; pxl++) {
      const x = X0 + (pxl + 0.5) / PPM;
      const z = Z0 + (py + 0.5) / PPM;
      const solid = boxes.some(
        (b) =>
          b.y0 <= 1 &&
          b.y1 >= 1 &&
          x >= b.x0 &&
          x <= b.x1 &&
          z >= b.z0 &&
          z <= b.z1,
      );
      const floor = floors.some(
        (b) => x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1,
      );
      if (solid) c.px(pxl, py, [70, 74, 92]);
      else if (floor) c.px(pxl, py, [190, 190, 180]);
    }
  }
  // Low or tall solids that miss the 1 m cut, shown as outlines.
  for (const b of boxes) {
    if (b.y1 <= 1 && b.y1 > 0.05) {
      c.outline(mx(b.x0), mz(b.z0), mx(b.x1), mz(b.z1), [120, 120, 150]);
    }
  }
  const rectOf = (b: Box, col: Rgb) =>
    c.rect(mx(b.x0), mz(b.z0), mx(b.x1), mz(b.z1), col);
  for (const p of data.plates) rectOf(boxOf(p.box), [60, 200, 80]);
  for (const d of data.doors) {
    rectOf(boxOf(d.closed), [240, 140, 30]);
    const o = d.openOffset;
    const open = {
      x0: d.closed.min.x + o.x,
      x1: d.closed.max.x + o.x,
      z0: d.closed.min.z + o.z,
      z1: d.closed.max.z + o.z,
      y0: 0,
      y1: 0,
    };
    c.outline(
      mx(open.x0),
      mz(open.z0),
      mx(open.x1),
      mz(open.z1),
      [255, 200, 90],
    );
  }
  for (const p of data.props) {
    const b = propBox(p);
    const col: Rgb =
      p.kind === "crate_metal"
        ? [90, 150, 255]
        : p.kind === "barrel"
          ? [210, 60, 60]
          : [230, 200, 60];
    // Props on the mezzanine or stacked are drawn lighter.
    const raised = p.position.y - PROP_SPECS[p.kind].halfExtents.y > 0.05;
    rectOf(b, raised ? [255, 240, 150] : col);
    c.outline(mx(b.x0), mz(b.z0), mx(b.x1), mz(b.z1), [30, 30, 30]);
  }
  for (const b of data.buttons) {
    c.disc(mx(b.position.x), mz(b.position.z), 4, [255, 40, 40]);
  }
  for (const l of data.lights) {
    const col: Rgb =
      l.flicker === "none"
        ? [255, 255, 255]
        : l.flicker === "fluorescent"
          ? [60, 240, 255]
          : [255, 0, 255];
    c.disc(mx(l.position.x), mz(l.position.z), 3, col);
    c.outline(
      mx(l.position.x) - 5,
      mz(l.position.z) - 5,
      mx(l.position.x) + 5,
      mz(l.position.z) + 5,
      col,
    );
  }
  const s = data.playerSpawn;
  c.disc(mx(s.position.x), mz(s.position.z), 6, [0, 220, 255]);
  c.line(
    mx(s.position.x),
    mz(s.position.z),
    mx(s.position.x) - Math.sin(s.yaw) * 28,
    mz(s.position.z) - Math.cos(s.yaw) * 28,
    [0, 120, 200],
  );
  // 1 m grid ticks every 5 m.
  for (let x = Math.ceil(X0 / 5) * 5; x < X1; x += 5)
    c.rect(mx(x), 0, mx(x) + 1, 8, [255, 255, 255]);
  for (let z = Math.ceil(Z0 / 5) * 5; z < Z1; z += 5)
    c.rect(0, mz(z), 8, mz(z) + 1, [255, 255, 255]);
  return c;
}

function lightImage(): Canvas {
  const c = new Canvas(W, H, [0, 0, 0]);
  for (const mesh of level.meshes) {
    const colors = mesh.colors;
    if (!colors) continue;
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const ids = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]];
      if (!ids.every((i) => mesh.normals[i * 3 + 1] > 0.9)) continue;
      if (!ids.every((i) => Math.abs(mesh.positions[i * 3 + 1]) < 0.05))
        continue;
      const p = ids.map((i) => [
        mx(mesh.positions[i * 3]),
        mz(mesh.positions[i * 3 + 2]),
      ]);
      const col = ids.map((i) => [
        colors[i * 3],
        colors[i * 3 + 1],
        colors[i * 3 + 2],
      ]);
      const minX = Math.floor(Math.min(p[0][0], p[1][0], p[2][0]));
      const maxX = Math.ceil(Math.max(p[0][0], p[1][0], p[2][0]));
      const minY = Math.floor(Math.min(p[0][1], p[1][1], p[2][1]));
      const maxY = Math.ceil(Math.max(p[0][1], p[1][1], p[2][1]));
      const den =
        (p[1][1] - p[2][1]) * (p[0][0] - p[2][0]) +
        (p[2][0] - p[1][0]) * (p[0][1] - p[2][1]);
      if (Math.abs(den) < 1e-9) continue;
      for (let y = minY; y < maxY; y++) {
        for (let x = minX; x < maxX; x++) {
          const fx = x + 0.5;
          const fy = y + 0.5;
          const a =
            ((p[1][1] - p[2][1]) * (fx - p[2][0]) +
              (p[2][0] - p[1][0]) * (fy - p[2][1])) /
            den;
          const b =
            ((p[2][1] - p[0][1]) * (fx - p[2][0]) +
              (p[0][0] - p[2][0]) * (fy - p[2][1])) /
            den;
          const g = 1 - a - b;
          if (a < -1e-6 || b < -1e-6 || g < -1e-6) continue;
          const rgb = [0, 1, 2].map((k) => {
            const v = a * col[0][k] + b * col[1][k] + g * col[2][k];
            return Math.round(
              255 * Math.min(1, Math.pow(Math.max(v, 0), 1 / 2.2)),
            );
          });
          c.px(x, y, [rgb[0], rgb[1], rgb[2]]);
        }
      }
    }
  }
  for (const l of data.lights) {
    c.disc(
      mx(l.position.x),
      mz(l.position.z),
      2,
      l.flicker === "none" ? [255, 0, 0] : [0, 255, 0],
    );
  }
  return c;
}

/** Side elevation cut at constant z, x to the right, y up. */
function sectionImage(zCut: number): Canvas {
  const w = Math.round((X1 - X0) * PPM);
  const h = Math.round(5.2 * PPM);
  const c = new Canvas(w, h, [8, 8, 12]);
  const my = (y: number) => h - (y + 0.5) * PPM;
  for (const b of boxes) {
    if (zCut < b.z0 || zCut > b.z1) continue;
    c.rect(mx(b.x0), my(b.y1), mx(b.x1), my(b.y0), [90, 96, 120]);
  }
  for (const d of data.doors) {
    if (zCut < d.closed.min.z || zCut > d.closed.max.z) continue;
    c.rect(
      mx(d.closed.min.x),
      my(d.closed.max.y),
      mx(d.closed.max.x),
      my(d.closed.min.y),
      [240, 140, 30],
    );
  }
  for (const p of data.props) {
    const b = propBox(p);
    if (zCut < b.z0 || zCut > b.z1) continue;
    c.rect(mx(b.x0), my(b.y1), mx(b.x1), my(b.y0), [230, 200, 60]);
  }
  for (const p of data.plates) {
    const b = boxOf(p.box);
    if (zCut >= b.z0 && zCut <= b.z1)
      c.rect(mx(b.x0), my(b.y1), mx(b.x1), my(b.y0), [60, 200, 80]);
  }
  for (const l of data.lights) {
    if (Math.abs(l.position.z - zCut) < 1.5)
      c.disc(mx(l.position.x), my(l.position.y), 3, [255, 255, 255]);
  }
  return c;
}

const out = [
  ["out/level-map.png", mapImage()],
  ["out/level-light.png", lightImage()],
  ["out/level-section-z0.png", sectionImage(0)],
  ["out/level-section-z12.png", sectionImage(12)],
  ["out/level-section-z15.png", sectionImage(15)],
] as const;
for (const [path, canvas] of out) {
  await writePng(path, canvas.w, canvas.h, canvas.data);
  console.log("wrote", path);
}
