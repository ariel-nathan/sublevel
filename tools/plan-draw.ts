/**
 * Top-down plan of any level, drawn from `LevelData` alone (no browser):
 * brushes at floor level (grey by top height), zones tinted, doors, buttons,
 * plates, props, lights, spawn, exit box and the declared solution as a
 * numbered polyline. Used by `tools/map.ts` (whole level) and by the solver's
 * failure report (a crop around the player with markers).
 *
 * Image x is world +x and image y is world +z (north, -z, is up).
 */
import type { LevelData, SolutionStep } from "../src/core/api";
import { boxOf, propBox, type Box } from "../src/level/geometry";
import {
  createImage,
  drawText,
  textWidth,
  type Image,
  type Rgb,
} from "./image";

export interface PlanMarker {
  /** What it is: a ring (target), a filled disc (player) or a small box (prop). */
  kind: "player" | "target" | "prop";
  x: number;
  z: number;
  label?: string;
  /** Player only: facing in degrees (yaw 0 looks -z), drawn as a tick. */
  yawDeg?: number;
}

export interface PlanOptions {
  /** Pixels per metre. Default: fit the longer side into `maxSize`. */
  scale?: number;
  /** Longest image side in px when `scale` is not given. Default 2400. */
  maxSize?: number;
  /** Only draw this part of the world (x0, z0, x1, z1 in metres). */
  crop?: { x0: number; z0: number; x1: number; z1: number };
  markers?: PlanMarker[];
  /** Draw the declared solution. Default true. */
  solution?: boolean;
  /** Number each solution step. Default true. */
  numbers?: boolean;
  /** Draw ids next to doors, buttons and plates. Default true. */
  ids?: boolean;
  /** Text in the top-left corner. */
  title?: string;
}

const ZONE_TINTS: Rgb[] = [
  [230, 90, 90],
  [90, 200, 110],
  [90, 130, 240],
  [230, 200, 70],
  [200, 100, 220],
  [70, 210, 210],
  [240, 150, 70],
];

class Canvas {
  readonly image: Image;
  constructor(
    readonly w: number,
    readonly h: number,
    readonly x0: number,
    readonly z0: number,
    readonly s: number,
  ) {
    this.image = createImage(w, h, [18, 18, 26]);
  }
  px(x: number): number {
    return Math.round((x - this.x0) * this.s);
  }
  pz(z: number): number {
    return Math.round((z - this.z0) * this.s);
  }
  put(x: number, y: number, c: Rgb, alpha = 1): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    const d = this.image.rgba;
    for (let k = 0; k < 3; k++)
      d[i + k] = d[i + k] * (1 - alpha) + c[k] * alpha;
  }
  fill(b: Box, c: Rgb, alpha = 1): void {
    const xa = Math.max(0, this.px(b.x0));
    const xb = Math.min(this.w, this.px(b.x1));
    const za = Math.max(0, this.pz(b.z0));
    const zb = Math.min(this.h, this.pz(b.z1));
    for (let y = za; y < zb; y++)
      for (let x = xa; x < xb; x++) this.put(x, y, c, alpha);
  }
  outline(b: Box, c: Rgb, t = 1): void {
    for (let k = 0; k < t; k++) {
      for (let x = this.px(b.x0); x <= this.px(b.x1); x++) {
        this.put(x, this.pz(b.z0) + k, c);
        this.put(x, this.pz(b.z1) - k, c);
      }
      for (let y = this.pz(b.z0); y <= this.pz(b.z1); y++) {
        this.put(this.px(b.x0) + k, y, c);
        this.put(this.px(b.x1) - k, y, c);
      }
    }
  }
  line(ax: number, az: number, bx: number, bz: number, c: Rgb, dash = 0): void {
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) * this.s));
    for (let i = 0; i <= n; i++) {
      if (dash > 0 && Math.floor(i / dash) % 2 === 1) continue;
      const t = i / n;
      const x = this.px(ax + (bx - ax) * t);
      const y = this.pz(az + (bz - az) * t);
      this.put(x, y, c);
      this.put(x + 1, y, c);
    }
  }
  disc(x: number, z: number, r: number, c: Rgb, ring = false): void {
    const cx = this.px(x);
    const cy = this.pz(z);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d = Math.hypot(dx, dy);
        if (ring ? d <= r && d >= r - 2 : d <= r) this.put(cx + dx, cy + dy, c);
      }
    }
  }
  text(
    t: string,
    x: number,
    z: number,
    c: Rgb = [255, 255, 255],
    scale = 1,
  ): void {
    const px = this.px(x);
    const py = this.pz(z);
    drawText(this.image, t, px + 1, py + 1, [0, 0, 0], scale);
    drawText(this.image, t, px, py, c, scale);
  }
}

/** The point a step ends at, for the polyline (null for steps that stay put). */

export function renderPlan(level: LevelData, options: PlanOptions = {}): Image {
  const boxes = level.brushes.map(boxOf);
  const floorBoxes = boxes.filter((b) => b.y0 <= 2.2);
  const extent = options.crop ?? {
    x0: Math.min(...floorBoxes.map((b) => b.x0)) - 1,
    z0: Math.min(...floorBoxes.map((b) => b.z0)) - 1,
    x1: Math.max(...floorBoxes.map((b) => b.x1)) + 1,
    z1: Math.max(...floorBoxes.map((b) => b.z1)) + 1,
  };
  const spanX = extent.x1 - extent.x0;
  const spanZ = extent.z1 - extent.z0;
  const scale =
    options.scale ??
    Math.max(
      4,
      Math.min(40, (options.maxSize ?? 2400) / Math.max(spanX, spanZ)),
    );
  const c = new Canvas(
    Math.ceil(spanX * scale),
    Math.ceil(spanZ * scale),
    extent.x0,
    extent.z0,
    scale,
  );
  // Brushes, lowest top first so walls draw over floors.
  const sorted = [...floorBoxes].sort((a, b) => a.y1 - b.y1);
  for (const b of sorted) {
    const g = Math.round(55 + Math.max(0, Math.min(1, b.y1 / 2.2)) * 150);
    c.fill(b, [g, g, g]);
  }
  level.zones.forEach((z, i) => {
    const b = boxOf(z.box);
    c.fill(b, ZONE_TINTS[i % ZONE_TINTS.length], 0.22);
    c.outline(b, ZONE_TINTS[i % ZONE_TINTS.length]);
    if (options.ids !== false)
      c.text(
        `Z${i}`,
        b.x0 + 0.1,
        b.z0 + 0.1,
        ZONE_TINTS[i % ZONE_TINTS.length],
      );
  });
  for (const p of level.plates) {
    const b = boxOf(p.box);
    c.fill(b, [210, 60, 210]);
    if (options.ids !== false) c.text(p.id, b.x0, b.z0 - 0.3, [230, 130, 230]);
  }
  for (const d of level.doors) {
    const b = boxOf(d.closed);
    c.fill(b, [60, 200, 220]);
    if (options.ids !== false) c.text(d.id, b.x0, b.z0 - 0.3, [120, 230, 240]);
  }
  for (const p of level.props) c.fill(propBox(p), [235, 140, 40]);
  for (const b of level.buttons) {
    c.fill(
      {
        x0: b.position.x - 0.15,
        x1: b.position.x + 0.15,
        y0: 0,
        y1: 0,
        z0: b.position.z - 0.15,
        z1: b.position.z + 0.15,
      },
      b.mode === "impact" ? [255, 120, 60] : [250, 230, 40],
    );
    if (options.ids !== false)
      c.text(b.id, b.position.x + 0.2, b.position.z + 0.2, [250, 230, 90]);
  }
  for (const l of level.lights) {
    c.disc(l.position.x, l.position.z, 2, [255, 245, 190]);
  }
  c.outline(boxOf(level.exit), [60, 255, 90], 2);
  if (options.ids !== false) {
    c.text("EXIT", level.exit.min.x, level.exit.min.z - 0.3, [90, 255, 120]);
  }
  // Spawn.
  const sp = level.playerSpawn;
  c.disc(sp.position.x, sp.position.z, 5, [60, 255, 90]);
  c.line(
    sp.position.x,
    sp.position.z,
    sp.position.x - Math.sin(sp.yaw) * 1.2,
    sp.position.z - Math.cos(sp.yaw) * 1.2,
    [60, 255, 90],
  );

  // The declared solution.
  if (options.solution !== false && level.solution.length > 0) {
    let at: { x: number; z: number } = sp.position;
    const props = level.props.map((p) => ({
      x: p.position.x,
      z: p.position.z,
    }));
    const BLUE: Rgb = [90, 150, 255];
    const LIGHT: Rgb = [150, 210, 255];
    level.solution.forEach((s, i) => {
      const n = String(i + 1);
      let mark: { x: number; z: number } | null = null;
      if (s.do === "walk") {
        c.line(at.x, at.z, s.to.x, s.to.z, BLUE);
        at = s.to;
        mark = s.to;
      } else if (s.do === "press") {
        const b = level.buttons.find((x) => x.id === s.button);
        if (b) {
          c.disc(b.position.x, b.position.z, 7, [255, 255, 80], true);
          mark = b.position;
        }
      } else if (s.do === "carry" || s.do === "push") {
        c.line(
          props[s.prop].x,
          props[s.prop].z,
          s.to.x,
          s.to.z,
          [255, 190, 120],
        );
        props[s.prop] = { x: s.to.x, z: s.to.z };
        mark = s.to;
      } else if (s.do === "throw") {
        const from = s.from ?? at;
        c.line(from.x, from.z, s.at.x, s.at.z, LIGHT, 4);
        mark = s.at;
      }
      if (mark && options.numbers !== false) {
        const px = c.px(mark.x);
        const py = c.pz(mark.z);
        const label = `${n}${{ walk: "", press: "P", carry: "C", push: "U", throw: "T", wait: "" }[s.do]}`;
        const w = textWidth(label, 2);
        for (let dy = -2; dy < 12; dy++) {
          for (let dx = -2; dx < w + 2; dx++)
            c.put(px + dx - 2, py + dy - 3, [0, 0, 0], 0.7);
        }
        drawText(c.image, label, px - 2, py - 1, [255, 255, 255], 2);
      }
    });
  }

  // Markers last, on top.
  for (const m of options.markers ?? []) {
    if (m.kind === "player") {
      c.disc(m.x, m.z, 6, [255, 40, 40]);
      if (m.yawDeg !== undefined) {
        const a = (m.yawDeg * Math.PI) / 180;
        c.line(
          m.x,
          m.z,
          m.x - Math.sin(a) * 1.5,
          m.z - Math.cos(a) * 1.5,
          [255, 90, 90],
        );
      }
    } else if (m.kind === "target") {
      c.disc(m.x, m.z, 9, [255, 255, 255], true);
      c.disc(m.x, m.z, 3, [255, 255, 255]);
    } else {
      c.fill(
        {
          x0: m.x - 0.2,
          x1: m.x + 0.2,
          y0: 0,
          y1: 0,
          z0: m.z - 0.2,
          z1: m.z + 0.2,
        },
        [255, 255, 90],
      );
    }
    if (m.label) c.text(m.label, m.x + 0.3, m.z - 0.5, [255, 255, 255]);
  }
  if (options.title) {
    const w = textWidth(options.title, 2) + 8;
    for (let y = 0; y < 18; y++)
      for (let x = 0; x < w; x++) c.put(x, y, [0, 0, 0], 0.8);
    drawText(c.image, options.title, 4, 4, [255, 255, 255], 2);
  }
  return c.image;
}
