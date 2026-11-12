/**
 * Standalone renderer demo (demos/render.html). Throwaway stand-in textures
 * and a small test room; the camera orbits on its own.
 * Query parameters: ?h=<internal height> (default 240), ?stress=1 adds
 * several hundred extra boxes and 48 dynamic lights, ?t=<seconds> freezes
 * the animation at that time.
 */
import { clamp, mat4, quat, v3, type Mat4, type Vec3 } from "../math";
import type {
  DrawItem,
  MeshHandle,
  PointLight,
  TextureImage,
  TextureSet,
} from "../core/api";
import { MATERIAL_IDS, type MaterialId } from "../core/materials";
import { MeshBuilder, type MeshData } from "../core/mesh";
import { createRenderer } from "./index";

const overlay = document.getElementById("overlay") as HTMLDivElement;
const canvas = document.getElementById("view") as HTMLCanvasElement;
const params = new URLSearchParams(location.search);
const internalHeight = Number(params.get("h") ?? 240) || 240;
const stress = params.get("stress") === "1";
const frozenTime = params.has("t") ? Number(params.get("t")) : null;

// ---------------------------------------------------------------------------
// Stand-in textures
// ---------------------------------------------------------------------------

type Rgb = [number, number, number];
type Pattern = (x: number, y: number, size: number) => number;

const checker: Pattern = (x, y, s) =>
  ((Math.floor((x * 4) / s) + Math.floor((y * 4) / s)) & 1) * 0.6 + 0.4;
const brick: Pattern = (x, y, s) => {
  const rowH = s / 4;
  const row = Math.floor(y / rowH);
  const off = row & 1 ? s / 4 : 0;
  const bx = (x + off) % (s / 2);
  return y % rowH < 1 || bx < 1 ? 0.35 : 0.85 + ((x * 7 + y * 13) % 5) * 0.03;
};
const stripes: Pattern = (x, y, s) =>
  Math.floor(((x + y) * 4) / s) & 1 ? 1 : 0.25;
const grid: Pattern = (x, y, s) =>
  x % (s / 2) < 1 || y % (s / 2) < 1 ? 0.4 : 0.9;
const planks: Pattern = (x, y, s) =>
  x < 2 || x >= s - 2 || y < 2 || y >= s - 2
    ? 0.45
    : y % (s / 4) < 1
      ? 0.6
      : 0.85 + ((y * 5) % 3) * 0.05;
const arrow: Pattern = (x, y, s) => {
  // An "F" so orientation and mirroring are obvious.
  const u = (x / s) * 8;
  const v = (y / s) * 8;
  const stem = u >= 2 && u < 3 && v >= 1 && v < 7;
  const top = u >= 2 && u < 6 && v >= 1 && v < 2;
  const mid = u >= 2 && u < 5 && v >= 3.5 && v < 4.5;
  return stem || top || mid ? 1 : 0.3;
};
const flat: Pattern = (x, y, s) =>
  x === 0 || y === 0 || x === s - 1 || y === s - 1 ? 0.7 : 1;

const STYLE: Record<MaterialId, [Pattern, Rgb, number]> = {
  concrete_wall: [brick, [150, 150, 140], 64],
  concrete_floor: [checker, [120, 120, 115], 64],
  ceiling_panel: [grid, [200, 200, 190], 32],
  lab_wall: [arrow, [190, 210, 220], 64],
  lab_floor_tile: [checker, [210, 200, 170], 32],
  metal_panel: [grid, [110, 130, 150], 64],
  metal_grate: [checker, [90, 90, 90], 16],
  hazard_stripe: [stripes, [240, 200, 30], 32],
  door_steel: [grid, [130, 140, 150], 64],
  crate_wood: [planks, [190, 130, 70], 32],
  crate_wood_weak: [planks, [170, 150, 90], 32],
  crate_metal: [grid, [80, 120, 90], 32],
  barrel_side: [stripes, [60, 90, 170], 32],
  barrel_top: [checker, [60, 90, 170], 16],
  pipe: [stripes, [150, 110, 90], 16],
  plastic_white: [flat, [230, 230, 230], 16],
  rubber_dark: [checker, [50, 50, 55], 16],
  pressure_plate: [grid, [160, 60, 60], 32],
  sign_warning: [arrow, [240, 180, 30], 64],
  light_panel: [grid, [255, 250, 230], 16],
  button_red: [flat, [230, 40, 30], 16],
  button_green: [flat, [40, 220, 60], 16],
  monitor_screen: [arrow, [60, 230, 140], 32],
};

function makeTextures(): TextureSet {
  const set = new Map<MaterialId, TextureImage>();
  for (const material of MATERIAL_IDS) {
    const [pattern, rgb, size] = STYLE[material];
    const pixels = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const k = pattern(x, y, size);
        const o = (y * size + x) * 4;
        pixels[o] = Math.min(255, rgb[0] * k);
        pixels[o + 1] = Math.min(255, rgb[1] * k);
        pixels[o + 2] = Math.min(255, rgb[2] * k);
        pixels[o + 3] = 255;
      }
    }
    set.set(material, { material, size, pixels });
  }
  return set;
}

// ---------------------------------------------------------------------------
// Test room with baked vertex colours
// ---------------------------------------------------------------------------

const AMBIENT = v3.create(0.07, 0.075, 0.09);
const STEADY: PointLight[] = [
  {
    position: v3.create(0, 2.7, -1.5),
    color: v3.create(1, 0.95, 0.85),
    radius: 8,
    intensity: 1.3,
    baked: true,
  },
  {
    position: v3.create(0, 2.7, -14),
    color: v3.create(0.7, 0.85, 1),
    radius: 7,
    intensity: 1,
    baked: true,
  },
];

/** Same lighting formula as the shader, evaluated once per vertex. */
function bake(p: Vec3, n: Vec3): Vec3 {
  let c = v3.clone(AMBIENT);
  for (const light of STEADY) {
    const to = v3.sub(light.position, p);
    const d = v3.length(to);
    const falloff = clamp(1 - d / light.radius, 0, 1);
    const ndotl = Math.max(0, v3.dot(n, v3.scale(to, 1 / Math.max(d, 1e-4))));
    c = v3.addScaled(
      c,
      light.color,
      light.intensity * falloff * falloff * ndotl,
    );
  }
  return c;
}

/** A flat rectangle split into ~step-sized quads, baked per vertex. */
function addSurface(
  b: MeshBuilder,
  origin: Vec3,
  uAxis: Vec3,
  vAxis: Vec3,
  uLen: number,
  vLen: number,
  tile: number,
  step = 0.5,
): void {
  const normal = v3.cross(uAxis, vAxis);
  const nu = Math.max(1, Math.round(uLen / step));
  const nv = Math.max(1, Math.round(vLen / step));
  const point = (i: number, j: number): Vec3 =>
    v3.addScaled(
      v3.addScaled(origin, uAxis, (i / nu) * uLen),
      vAxis,
      (j / nv) * vLen,
    );
  const uv = (i: number, j: number) => ({
    u: ((i / nu) * uLen) / tile,
    v: -((j / nv) * vLen) / tile,
  });
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const corners = [
        point(i, j),
        point(i + 1, j),
        point(i + 1, j + 1),
        point(i, j + 1),
      ] as const;
      b.addQuad(
        corners,
        normal,
        [uv(i, j), uv(i + 1, j), uv(i + 1, j + 1), uv(i, j + 1)],
        [
          bake(corners[0], normal),
          bake(corners[1], normal),
          bake(corners[2], normal),
          bake(corners[3], normal),
        ],
      );
    }
  }
}

function buildRoom(): MeshData[] {
  const X = 4;
  const H = 3;
  const Z0 = 4;
  const Z1 = -22;
  const L = Z0 - Z1;
  const floor = new MeshBuilder("lab_floor_tile");
  addSurface(
    floor,
    v3.create(-X, 0, Z0),
    v3.create(1, 0, 0),
    v3.create(0, 0, -1),
    2 * X,
    L,
    1,
  );
  const ceiling = new MeshBuilder("ceiling_panel");
  addSurface(
    ceiling,
    v3.create(-X, H, Z1),
    v3.create(1, 0, 0),
    v3.create(0, 0, 1),
    2 * X,
    L,
    1,
  );
  const left = new MeshBuilder("concrete_wall");
  addSurface(
    left,
    v3.create(-X, 0, Z0),
    v3.create(0, 0, -1),
    v3.create(0, 1, 0),
    L,
    H,
    1.5,
  );
  addSurface(
    left,
    v3.create(X, 0, Z0),
    v3.create(-1, 0, 0),
    v3.create(0, 1, 0),
    2 * X,
    H,
    1.5,
  );
  const right = new MeshBuilder("lab_wall");
  addSurface(
    right,
    v3.create(X, 0, Z1),
    v3.create(0, 0, 1),
    v3.create(0, 1, 0),
    L,
    H,
    1,
  );
  const end = new MeshBuilder("metal_panel");
  addSurface(
    end,
    v3.create(-X, 0, Z1),
    v3.create(1, 0, 0),
    v3.create(0, 1, 0),
    2 * X,
    H,
    1,
  );
  // A hazard-striped baked step along the left wall (box with baked colour
  // per face corner via addSurface would be overkill; one colour is fine).
  const step = new MeshBuilder("hazard_stripe");
  step.addBox(v3.create(-X, 0, -9), v3.create(-X + 1, 0.3, -5), {
    tileSize: 0.5,
    skip: ["nx", "ny"],
    color: bake(v3.create(-X + 0.5, 0.3, -7), v3.create(0, 1, 0)),
  });
  return [floor, ceiling, left, right, end, step].map((b) => b.build());
}

// ---------------------------------------------------------------------------
// Props and scene
// ---------------------------------------------------------------------------

function unitBox(material: MaterialId): MeshData {
  const b = new MeshBuilder(material);
  b.addBox(v3.create(-0.5, -0.5, -0.5), v3.create(0.5, 0.5, 0.5));
  return b.build();
}

function barrel(): MeshData {
  const b = new MeshBuilder("barrel_side");
  b.addCylinder(v3.create(0, -0.45, 0), 0.3, 0.9, 12, { sideRepeats: 2 });
  return b.build();
}

function panel(material: MaterialId, w: number, h: number): MeshData {
  // Faces +Z in its local space.
  const b = new MeshBuilder(material);
  b.addQuad(
    [
      v3.create(-w / 2, -h / 2, 0),
      v3.create(w / 2, -h / 2, 0),
      v3.create(w / 2, h / 2, 0),
      v3.create(-w / 2, h / 2, 0),
    ],
    v3.create(0, 0, 1),
    [
      { u: 0, v: 1 },
      { u: 1, v: 1 },
      { u: 1, v: 0 },
      { u: 0, v: 0 },
    ],
  );
  return b.build();
}

const Y = v3.create(0, 1, 0);
const X_AXIS = v3.create(1, 0, 0);

function trs(p: Vec3, yaw = 0, s: Vec3 = v3.create(1, 1, 1)): Mat4 {
  return mat4.fromTRS(p, quat.fromAxisAngle(Y, yaw), s);
}

async function start(): Promise<void> {
  const renderer = await createRenderer({
    canvas,
    textures: makeTextures(),
    internalHeight,
  });
  renderer.resize(window.innerWidth, window.innerHeight);
  window.addEventListener("resize", () =>
    renderer.resize(window.innerWidth, window.innerHeight),
  );

  const statics: DrawItem[] = buildRoom().map((m) => ({
    mesh: renderer.createMesh(m),
    transform: mat4.identity(),
  }));

  const mesh: Record<string, MeshHandle> = {
    wood: renderer.createMesh(unitBox("crate_wood")),
    weak: renderer.createMesh(unitBox("crate_wood_weak")),
    metal: renderer.createMesh(unitBox("crate_metal")),
    plastic: renderer.createMesh(unitBox("plastic_white")),
    barrel: renderer.createMesh(barrel()),
    lamp: renderer.createMesh(panel("light_panel", 1.2, 0.5)),
    screen: renderer.createMesh(panel("monitor_screen", 0.5, 0.35)),
    sign: renderer.createMesh(panel("sign_warning", 0.8, 0.8)),
  };

  const props: DrawItem[] = [
    { mesh: mesh.wood, transform: trs(v3.create(-1.6, 0.5, -1.2), 0.3) },
    {
      mesh: mesh.weak,
      transform: trs(v3.create(-1.5, 1.3, -1.1), 0.9, v3.create(0.6, 0.6, 0.6)),
    },
    {
      mesh: mesh.metal,
      transform: trs(v3.create(1.7, 0.4, -2.6), -0.6, v3.create(1.6, 0.8, 0.8)),
    },
    { mesh: mesh.barrel, transform: trs(v3.create(0.3, 0.45, -3.8)) },
    {
      // Barrel on its side.
      mesh: mesh.barrel,
      transform: mat4.fromTRS(
        v3.create(-2.2, 0.3, -5),
        quat.multiply(
          quat.fromAxisAngle(Y, 0.4),
          quat.fromAxisAngle(v3.create(0, 0, 1), Math.PI / 2),
        ),
      ),
    },
    {
      // Monitor: a plastic box with an emissive screen on its front.
      mesh: mesh.plastic,
      transform: trs(
        v3.create(2.6, 0.95, -0.5),
        -0.9,
        v3.create(0.6, 0.45, 0.4),
      ),
    },
    {
      mesh: mesh.screen,
      transform: mat4.multiply(
        trs(v3.create(2.6, 0.95, -0.5), -0.9),
        trs(v3.create(0, 0, 0.201)),
      ),
    },
    {
      // Tinted crate.
      mesh: mesh.wood,
      transform: trs(v3.create(2.2, 0.5, -6), 0.2),
      tint: v3.create(1, 0.55, 0.55),
    },
    {
      // Emissive ceiling panel under the first steady light, facing down.
      mesh: mesh.lamp,
      transform: mat4.fromTRS(
        v3.create(0, 2.98, -1.5),
        quat.fromAxisAngle(X_AXIS, Math.PI / 2),
      ),
    },
    {
      mesh: mesh.lamp,
      transform: mat4.fromTRS(
        v3.create(0, 2.98, -14),
        quat.fromAxisAngle(X_AXIS, Math.PI / 2),
      ),
    },
    {
      // Sign on the left wall.
      mesh: mesh.sign,
      transform: mat4.fromTRS(
        v3.create(-3.99, 1.6, -3),
        quat.fromAxisAngle(Y, Math.PI / 2),
      ),
    },
  ];
  // A row of crates down the corridor, fading into the fog.
  for (let i = 0; i < 8; i++) {
    props.push({
      mesh: i % 2 ? mesh.metal : mesh.wood,
      transform: trs(v3.create(i % 2 ? 2.5 : -2.5, 0.5, -8 - i * 2), i * 0.4),
    });
  }

  const extraLights: PointLight[] = [];
  if (stress) {
    for (let i = 0; i < 400; i++) {
      const x = -3.5 + (i % 20) * 0.37;
      const z = 3 - Math.floor(i / 20) * 1.2;
      props.push({
        mesh: i % 3 ? mesh.wood : mesh.metal,
        transform: trs(
          v3.create(x, 0.12, z),
          i * 0.7,
          v3.create(0.2, 0.24, 0.2),
        ),
      });
    }
    for (let i = 0; i < 48; i++) {
      extraLights.push({
        position: v3.create(-3 + (i % 6) * 1.2, 0.6, 2 - Math.floor(i / 6) * 3),
        color: v3.create(((i * 37) % 10) / 10, ((i * 53) % 10) / 10, 0.6),
        radius: 1.5,
        intensity: 1,
        baked: false,
      });
    }
  }

  // One spinning, non-uniformly scaled box to check normals under rotation.
  const spinner: DrawItem = { mesh: mesh.metal, transform: mat4.identity() };
  const flicker: PointLight = {
    position: v3.create(-0.6, 1.0, -3.2),
    color: v3.create(1, 0.55, 0.2),
    radius: 4.5,
    intensity: 1,
    baked: false,
  };
  const lights = [...STEADY, flicker, ...extraLights];
  const items: DrawItem[] = [...statics, ...props, spinner];

  let last = performance.now();
  let frameAvg = 16;
  let cpuAvg = 0;
  let shown = 0;
  const center = v3.create(0, 1.2, -3);

  const frame = (now: number): void => {
    const dt = now - last;
    last = now;
    frameAvg += (dt - frameAvg) * 0.05;
    const t = frozenTime ?? now / 1000;

    spinner.transform = mat4.fromTRS(
      v3.create(0, 1.4, -6.5),
      quat.multiply(
        quat.fromAxisAngle(Y, t * 0.7),
        quat.fromAxisAngle(X_AXIS, 0.5),
      ),
      v3.create(1.2, 0.3, 0.6),
    );
    flicker.intensity =
      Math.sin(t * 23) * Math.sin(t * 7.1) > 0.75
        ? 0.15
        : 1.2 + 0.3 * Math.sin(t * 3);

    const angle = t * 0.2;
    const eye = v3.create(
      center.x + Math.sin(angle) * 3.3,
      1.6 + 0.25 * Math.sin(t * 0.37),
      center.z + Math.cos(angle) * 3.3,
    );
    // Look past the centre, a little towards the corridor.
    const target = v3.add(center, v3.create(0, -0.1, -1.5));
    const dir = v3.sub(target, eye);
    const yaw = Math.atan2(-dir.x, -dir.z);
    const pitch = Math.atan2(dir.y, Math.hypot(dir.x, dir.z));

    const cpuStart = performance.now();
    renderer.render({
      camera: {
        position: eye,
        orientation: quat.fromYawPitch(yaw, pitch),
        fovY: (70 * Math.PI) / 180,
        near: 0.05,
        far: 100,
      },
      items,
      lights,
      ambient: AMBIENT,
      fog: { color: v3.create(0.05, 0.055, 0.06), near: 6, far: 22 },
      time: t,
    });
    cpuAvg += (performance.now() - cpuStart - cpuAvg) * 0.05;

    if (now - shown > 250) {
      shown = now;
      overlay.textContent =
        `internal ${renderer.width}x${renderer.height}\n` +
        `frame ${frameAvg.toFixed(1)} ms  cpu ${cpuAvg.toFixed(2)} ms\n` +
        `items ${items.length}  lights ${lights.length}`;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  overlay.textContent = `error: ${message}`;
  overlay.style.color = "#f99";
  console.error("render demo:", message);
});
