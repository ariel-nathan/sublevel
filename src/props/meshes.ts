/**
 * Model-space meshes of every world object. Props are centred on the middle
 * of their physics box; their front is the local -Z side.
 */
import type { DoorDef, PropKind } from "../core/api";
import type { MaterialId } from "../core/materials";
import { BOX_FACES, MeshBuilder, type MeshData } from "../core/mesh";
import { PROP_SPECS } from "../core/props";
import { v3, type Vec3 } from "../math";

const v = v3.create;

/** Adds an axis-aligned box given by its centre and half sizes. */
function box(
  b: MeshBuilder,
  cx: number,
  cy: number,
  cz: number,
  hx: number,
  hy: number,
  hz: number,
  options?: Parameters<MeshBuilder["addBox"]>[2],
): void {
  b.addBox(v(cx - hx, cy - hy, cz - hz), v(cx + hx, cy + hy, cz + hz), options);
}

/**
 * A box whose texture repeat is `tile` metres long along each world axis (so
 * a non-square face can show exactly one repeat in each direction).
 */
export function addStretchedBox(
  b: MeshBuilder,
  min: Vec3,
  max: Vec3,
  tile: Vec3,
  skip: readonly (typeof BOX_FACES)[number]["face"][] = [],
): void {
  const center = v3.scale(v3.add(min, max), 0.5);
  const half = v3.scale(v3.sub(max, min), 0.5);
  const tileAlong = (axis: Vec3): number =>
    Math.abs(axis.x) * tile.x +
    Math.abs(axis.y) * tile.y +
    Math.abs(axis.z) * tile.z;
  for (const basis of BOX_FACES) {
    if (skip.includes(basis.face)) {
      continue;
    }
    const hn = Math.abs(v3.dot(basis.normal, half));
    const hu = Math.abs(v3.dot(basis.u, half));
    const hv = Math.abs(v3.dot(basis.v, half));
    const faceCenter = v3.addScaled(center, basis.normal, hn);
    const corner = (su: number, sv: number): Vec3 =>
      v3.addScaled(
        v3.addScaled(faceCenter, basis.u, su * hu),
        basis.v,
        sv * hv,
      );
    const width = (2 * hu) / tileAlong(basis.u);
    const height = (2 * hv) / tileAlong(basis.v);
    b.addQuad(
      [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)],
      basis.normal,
      [
        { u: 0, v: height },
        { u: width, v: height },
        { u: width, v: 0 },
        { u: 0, v: 0 },
      ],
    );
  }
}

/** A box whose faces each show one repeat of the texture. */
function crate(kind: PropKind, material: MaterialId): MeshData[] {
  const h = PROP_SPECS[kind].halfExtents;
  const b = new MeshBuilder(material);
  box(b, 0, 0, 0, h.x, h.y, h.z, { tileSize: 2 * h.x });
  return [b.build()];
}

export const BARREL_RADIUS = 0.3;
export const BARREL_HEIGHT = 0.9;
export const BARREL_SEGMENTS = 12;

function barrel(): MeshData[] {
  const half = BARREL_HEIGHT / 2;
  const side = new MeshBuilder("barrel_side");
  side.addCylinder(
    v(0, -half, 0),
    BARREL_RADIUS,
    BARREL_HEIGHT,
    BARREL_SEGMENTS,
    { sideRepeats: 1, caps: false },
  );
  const caps = new MeshBuilder("barrel_top");
  for (const top of [true, false]) {
    const y = top ? half : -half;
    const normal = v(0, top ? 1 : -1, 0);
    const centre = caps.addVertex(v(0, y, 0), normal, { u: 0.5, v: 0.5 });
    const rim: number[] = [];
    for (let i = 0; i < BARREL_SEGMENTS; i++) {
      const angle = (i / BARREL_SEGMENTS) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      rim.push(
        caps.addVertex(v(cos * BARREL_RADIUS, y, sin * BARREL_RADIUS), normal, {
          u: 0.5 + cos * 0.5,
          v: 0.5 + sin * 0.5,
        }),
      );
    }
    for (let i = 0; i < BARREL_SEGMENTS; i++) {
      const a = rim[i];
      const c = rim[(i + 1) % BARREL_SEGMENTS];
      // Angles grow from +X towards +Z, which is clockwise seen from above.
      if (top) {
        caps.addTriangle(centre, c, a);
      } else {
        caps.addTriangle(centre, a, c);
      }
    }
  }
  return [side.build(), caps.build()];
}

/** Office chair: pad seat, backrest on the +Z side, four legs and feet. */
function chair(): MeshData[] {
  const floor = -0.45;
  const plastic = new MeshBuilder("plastic_white");
  // Seat pad.
  box(plastic, 0, floor + 0.47, 0, 0.23, 0.03, 0.23, { tileSize: 0.5 });
  // Backrest.
  box(plastic, 0, floor + 0.7, 0.2, 0.22, 0.2, 0.025, { tileSize: 0.5 });
  const metal = new MeshBuilder("metal_panel");
  const rubber = new MeshBuilder("rubber_dark");
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      box(metal, sx * 0.19, floor + 0.24, sz * 0.19, 0.02, 0.2, 0.02, {
        tileSize: 0.4,
        skip: ["ny"],
      });
      box(rubber, sx * 0.19, floor + 0.02, sz * 0.19, 0.035, 0.02, 0.035, {
        tileSize: 0.1,
        skip: ["ny"],
      });
    }
  }
  return [plastic.build(), metal.build(), rubber.build()];
}

/** Chunky CRT: shell with a tube bulge behind, a swivel foot and a screen. */
function monitor(): MeshData[] {
  const h = PROP_SPECS.monitor.halfExtents;
  const shell = new MeshBuilder("plastic_white");
  // Front housing.
  box(shell, 0, 0.015, -0.099, h.x, 0.185, 0.099, { tileSize: 0.4 });
  // Tube bulge.
  box(shell, 0, 0.0, 0.1, 0.16, 0.14, 0.1, { tileSize: 0.4 });
  // Foot.
  box(shell, 0, -0.185, -0.03, 0.15, 0.015, 0.15, { tileSize: 0.4 });
  const screen = new MeshBuilder("monitor_screen");
  const hw = 0.17;
  const bottom = -0.1;
  const top = 0.16;
  const z = -h.z + 0.001;
  screen.addQuad(
    [v(hw, bottom, z), v(-hw, bottom, z), v(-hw, top, z), v(hw, top, z)],
    v(0, 0, -1),
    [
      { u: 0, v: 1 },
      { u: 1, v: 1 },
      { u: 1, v: 0 },
      { u: 0, v: 0 },
    ],
  );
  return [shell.build(), screen.build()];
}

/** Mesh parts of a prop kind, in model space. */
export function buildPropMeshes(kind: PropKind): MeshData[] {
  switch (kind) {
    case "crate_wood":
    case "crate_wood_small":
      return crate(kind, "crate_wood");
    case "crate_weak":
      return crate(kind, "crate_wood_weak");
    case "crate_metal":
      return crate(kind, "crate_metal");
    case "barrel":
      return barrel();
    case "chair":
      return chair();
    case "monitor":
      return monitor();
  }
}

/** Material that decides a prop's impact sound. */
export const PROP_SURFACE_MATERIAL: Readonly<Record<PropKind, MaterialId>> = {
  crate_wood: "crate_wood",
  crate_wood_small: "crate_wood",
  crate_weak: "crate_wood_weak",
  crate_metal: "crate_metal",
  barrel: "barrel_side",
  chair: "plastic_white",
  monitor: "plastic_white",
};

/** A door slab centred on the origin; one repeat spans its width and height. */
export function buildDoorMesh(def: DoorDef): MeshData {
  const size = v3.sub(def.closed.max, def.closed.min);
  const width = Math.max(size.x, size.z);
  const b = new MeshBuilder(def.material);
  addStretchedBox(
    b,
    v3.scale(size, -0.5),
    v3.scale(size, 0.5),
    v(width, size.y, width),
  );
  return b.build();
}

export const PLATE_SIDE_TILE = 0.16;

/** Pressure plate slab centred on the origin: plate top, striped sides. */
export function buildPlateMeshes(size: Vec3): MeshData[] {
  const lo = v3.scale(size, -0.5);
  const hi = v3.scale(size, 0.5);
  const top = new MeshBuilder("pressure_plate");
  const span = Math.max(size.x, size.z);
  addStretchedBox(top, lo, hi, v(span, 1, span), [
    "px",
    "nx",
    "pz",
    "nz",
    "ny",
  ]);
  const sides = new MeshBuilder("hazard_stripe");
  addStretchedBox(
    sides,
    lo,
    hi,
    v(PLATE_SIDE_TILE, PLATE_SIDE_TILE, PLATE_SIDE_TILE),
    ["py", "ny"],
  );
  return [top.build(), sides.build()];
}

/**
 * Button unit layout along its facing axis, in model space (origin at the
 * centre of the button face, +Z out of the wall):
 * - the knob runs from -BUTTON_LIT_HEIGHT to 0 (its cap is the button face);
 * - the bezel runs from -BUTTON_DEPTH - BUTTON_EMBED to -BUTTON_LIT_HEIGHT;
 * - the wall surface is at -BUTTON_DEPTH, so the bezel is sunk BUTTON_EMBED
 *   into the wall (no face of it lies in the wall plane) and stands
 *   BUTTON_DEPTH - BUTTON_LIT_HEIGHT proud of it.
 * The level places `ButtonDef.position` BUTTON_DEPTH in front of the wall.
 */
export const BUTTON_DEPTH = 0.06;
export const BUTTON_EMBED = 0.01;
export const BUTTON_BEZEL_HALF = 0.11;
export const BUTTON_LIT_RADIUS = 0.065;
export const BUTTON_LIT_HEIGHT = 0.02;
const BUTTON_SEGMENTS = 14;

/**
 * Wall button in model space: origin at the centre of the button face, +Z
 * pointing out of the wall. Returns the bezel, and the lit knob once in each
 * colour (the unit shows whichever matches its door).
 */
export function buildButtonMeshes(): {
  bezel: MeshData;
  red: MeshData;
  green: MeshData;
} {
  const half = BUTTON_BEZEL_HALF;
  const back = -BUTTON_DEPTH - BUTTON_EMBED;
  const front = -BUTTON_LIT_HEIGHT;
  const bezel = new MeshBuilder("metal_panel");
  box(bezel, 0, 0, (front + back) / 2, half, half, (front - back) / 2, {
    tileSize: 0.25,
    skip: ["nz"],
  });
  const knob = (material: MaterialId): MeshData => {
    const b = new MeshBuilder(material);
    const z0 = front;
    const z1 = 0;
    const out = v(0, 0, 1);
    const centre = b.addVertex(v(0, 0, z1), out, { u: 0.5, v: 0.5 });
    const capRim: number[] = [];
    const sideBottom: number[] = [];
    const sideTop: number[] = [];
    for (let i = 0; i <= BUTTON_SEGMENTS; i++) {
      const angle = (i / BUTTON_SEGMENTS) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const x = cos * BUTTON_LIT_RADIUS;
      const y = sin * BUTTON_LIT_RADIUS;
      capRim.push(
        b.addVertex(v(x, y, z1), out, {
          u: 0.5 + cos * 0.5,
          v: 0.5 - sin * 0.5,
        }),
      );
      const outward = v(cos, sin, 0);
      const u = i / BUTTON_SEGMENTS;
      sideBottom.push(b.addVertex(v(x, y, z0), outward, { u, v: 1 }));
      sideTop.push(b.addVertex(v(x, y, z1), outward, { u, v: 0 }));
    }
    for (let i = 0; i < BUTTON_SEGMENTS; i++) {
      b.addTriangle(centre, capRim[i], capRim[i + 1]);
      b.addTriangle(sideBottom[i], sideBottom[i + 1], sideTop[i + 1]);
      b.addTriangle(sideBottom[i], sideTop[i + 1], sideTop[i]);
    }
    return b.build();
  };
  return {
    bezel: bezel.build(),
    red: knob("button_red"),
    green: knob("button_green"),
  };
}

/** A few preset plank shapes for debris; mass derived from volume. */
export interface PlankPreset {
  half: Vec3;
  mass: number;
}

function plank(hx: number, hy: number, hz: number): PlankPreset {
  const volume = 8 * hx * hy * hz;
  return {
    half: v(hx, hy, hz),
    mass: Math.min(2, Math.max(0.8, volume * 700)),
  };
}

export const PLANK_PRESETS: readonly PlankPreset[] = [
  plank(0.28, 0.045, 0.025),
  plank(0.2, 0.045, 0.025),
  plank(0.14, 0.04, 0.04),
];

export function buildPlankMesh(preset: PlankPreset): MeshData {
  const b = new MeshBuilder("crate_wood_weak");
  box(b, 0, 0, 0, preset.half.x, preset.half.y, preset.half.z, {
    tileSize: 0.5,
  });
  return b.build();
}
