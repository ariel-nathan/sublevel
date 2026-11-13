/**
 * Dressing for the puzzle rooms, in design coordinates through a `Kit`:
 * shelving, cabinets, desks, tanks, pipes, signs, lamps. Each piece is laid
 * out so that none of its faces shares a plane and facing with another of
 * its own faces (no z-fighting); pieces stand on the floor (y 0) unless
 * given a base.
 */
import type { Aabb, LightDef } from "../../../core/api";
import type { MaterialId } from "../../../core/materials";
import type { Kit, Rgb } from "../kit";

export const WARM: Rgb = [1.0, 0.86, 0.66];
export const COOL: Rgb = [0.84, 0.92, 1.0];
export const SODIUM: Rgb = [1.0, 0.72, 0.42];
export const RED: Rgb = [1.0, 0.3, 0.22];

/**
 * A ceiling lamp: a recessed fixture and a light 0.4 m under the ceiling.
 * A dynamic (flickering) lamp needs `bounds`.
 */
export function lamp(
  k: Kit,
  x: number,
  z: number,
  ceil: number,
  color: Rgb,
  radius: number,
  intensity: number,
  options: {
    flicker?: LightDef["flicker"];
    bounds?: Aabb;
    hx?: number;
    hz?: number;
    material?: MaterialId;
  } = {},
): void {
  k.fixture(
    x,
    z,
    ceil,
    options.hx ?? 0.3,
    options.hz ?? 0.15,
    options.material,
  );
  k.light(
    x,
    ceil - 0.4,
    z,
    color,
    radius,
    intensity,
    options.flicker ?? "none",
    options.bounds,
  );
}

/**
 * An open shelving rack: two end panels and boards (tops at `boards[i] +
 * 0.04`). `along` is the axis the rack runs along; the boards span between
 * the end panels over the full depth.
 */
export function rack(
  k: Kit,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  boards: number[],
  top: number,
  along: "x" | "z",
  material: MaterialId = "metal_panel",
): void {
  const t = 0.05;
  if (along === "x") {
    k.box(x0, 0, z0, x0 + t, top, z1, material);
    k.box(x1 - t, 0, z0, x1, top, z1, material);
    for (const y of boards)
      k.box(x0 + t, y, z0, x1 - t, y + 0.04, z1, material);
  } else {
    k.box(x0, 0, z0, x1, top, z0 + t, material);
    k.box(x0, 0, z1 - t, x1, top, z1, material);
    for (const y of boards)
      k.box(x0, y, z0 + t, x1, y + 0.04, z1 - t, material);
  }
}

/**
 * A cabinet with its front facing `front` (a design axis direction): body,
 * and a panel 2 cm proud on the front (a screen, a grille or a door).
 */
export function cabinet(
  k: Kit,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  height: number,
  front: "+x" | "-x" | "+z" | "-z",
  body: MaterialId = "metal_panel",
  panel: MaterialId = "rubber_dark",
  panelY: [number, number] = [0.3, Math.min(height - 0.2, 1.5)],
): void {
  k.box(x0, 0, z0, x1, height, z1, body);
  const [y0, y1] = panelY;
  const m = 0.08;
  const d = 0.02;
  switch (front) {
    case "+x":
      k.box(x1, y0, z0 + m, x1 + d, y1, z1 - m, panel);
      break;
    case "-x":
      k.box(x0 - d, y0, z0 + m, x0, y1, z1 - m, panel);
      break;
    case "+z":
      k.box(x0 + m, y0, z1, x1 - m, y1, z1 + d, panel);
      break;
    case "-z":
      k.box(x0 + m, y0, z0 - d, x1 - m, y1, z0, panel);
      break;
  }
}

/** A desk or bench: a top 4 cm thick at `height` on four legs. */
export function desk(
  k: Kit,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  height = 0.76,
  top: MaterialId = "plastic_white",
): void {
  k.box(x0, height - 0.04, z0, x1, height, z1, top);
  const l = 0.06;
  const i = 0.04;
  for (const [a, b] of [
    [x0 + i, z0 + i],
    [x1 - i - l, z0 + i],
    [x0 + i, z1 - i - l],
    [x1 - i - l, z1 - i - l],
  ]) {
    k.box(a, 0, b, a + l, height - 0.04, b + l, "metal_panel");
  }
}

/**
 * A solid counter (cupboards under a worktop): body to `height - 0.04`, a
 * worktop overhanging 3 cm on every side, a kick plate set back.
 */
export function counter(
  k: Kit,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  height = 1.05,
  body: MaterialId = "metal_panel",
  top: MaterialId = "plastic_white",
): void {
  k.box(x0, 0.1, z0, x1, height - 0.04, z1, body);
  k.box(x0 + 0.06, 0, z0 + 0.06, x1 - 0.06, 0.1, z1 - 0.06, "rubber_dark");
  k.box(x0 - 0.03, height - 0.04, z0 - 0.03, x1 + 0.03, height, z1 + 0.03, top);
}

/**
 * A boxy upright tank (vessel, pump casing) with two rubber collars 3 cm
 * proud and a hazard band, standing clear of walls.
 */
export function tank(
  k: Kit,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  height: number,
  body: MaterialId = "plastic_white",
): void {
  k.box(x0, 0, z0, x1, height, z1, body);
  const c = 0.03;
  for (const y of [0.35, height - 0.55]) {
    k.box(x0 - c, y, z0 - c, x1 + c, y + 0.14, z1 + c, "rubber_dark");
  }
  const mid = height * 0.55;
  k.box(
    x0 - 0.015,
    mid,
    z0 - 0.015,
    x1 + 0.015,
    mid + 0.1,
    z1 + 0.015,
    "hazard_stripe",
  );
}

/** A warning sign on a wall: 3 cm thick, `face` the wall's design plane. */
export function signX(
  k: Kit,
  face: number,
  dir: 1 | -1,
  z0: number,
  z1: number,
  y0: number,
  y1: number,
  material: MaterialId = "sign_warning",
): void {
  const t = 0.03;
  if (dir > 0) k.box(face, y0, z0, face + t, y1, z1, material);
  else k.box(face - t, y0, z0, face, y1, z1, material);
}

export function signZ(
  k: Kit,
  face: number,
  dir: 1 | -1,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  material: MaterialId = "sign_warning",
): void {
  const t = 0.03;
  if (dir > 0) k.box(x0, y0, face, x1, y1, face + t, material);
  else k.box(x0, y0, face - t, x1, y1, face, material);
}

/**
 * A pipe run along a wall under the ceiling, with brackets every 1.5 m:
 * along x at wall face z (pipe stands out towards `dir`).
 */
export function pipeAlongX(
  k: Kit,
  x0: number,
  x1: number,
  face: number,
  dir: 1 | -1,
  y: number,
  d = 0.15,
): void {
  const zz = (a: number, b: number): [number, number] =>
    dir > 0 ? [face + a, face + b] : [face - b, face - a];
  const [p0, p1] = zz(0.05, 0.05 + d);
  k.box(x0, y, p0, x1, y + d, p1, "pipe");
  const [b0, b1] = zz(0, 0.05 + d);
  for (let x = x0 + 0.5; x < x1 - 0.2; x += 1.5) {
    k.box(x - 0.04, y + d, b0, x + 0.04, y + d + 0.05, b1, "metal_panel");
  }
}

export function pipeAlongZ(
  k: Kit,
  z0: number,
  z1: number,
  face: number,
  dir: 1 | -1,
  y: number,
  d = 0.15,
): void {
  const xx = (a: number, b: number): [number, number] =>
    dir > 0 ? [face + a, face + b] : [face - b, face - a];
  const [p0, p1] = xx(0.05, 0.05 + d);
  k.box(p0, y, z0, p1, y + d, z1, "pipe");
  const [b0, b1] = xx(0, 0.05 + d);
  for (let z = z0 + 0.5; z < z1 - 0.2; z += 1.5) {
    k.box(b0, y + d, z - 0.04, b1, y + d + 0.05, z + 0.04, "metal_panel");
  }
}

/** Ceiling beams across the room (along z) at the given x positions. */
export function beams(
  k: Kit,
  xs: number[],
  z0: number,
  z1: number,
  ceil: number,
  depth = 0.25,
): void {
  for (const x of xs) {
    k.box(x - 0.12, ceil - depth, z0, x + 0.12, ceil, z1, "metal_panel");
  }
}

/** A rubber skirting strip along a wall face (a thin trim, see isSkirting). */
export function skirtX(
  k: Kit,
  x0: number,
  x1: number,
  face: number,
  dir: 1 | -1,
): void {
  if (x1 - x0 < 0.05) return;
  if (dir > 0) k.box(x0, 0, face, x1, 0.1, face + 0.03, "rubber_dark");
  else k.box(x0, 0, face - 0.03, x1, 0.1, face, "rubber_dark");
}

export function skirtZ(
  k: Kit,
  z0: number,
  z1: number,
  face: number,
  dir: 1 | -1,
): void {
  if (z1 - z0 < 0.05) return;
  if (dir > 0) k.box(face, 0, z0, face + 0.03, 0.1, z1, "rubber_dark");
  else k.box(face - 0.03, 0, z0, face, 0.1, z1, "rubber_dark");
}
