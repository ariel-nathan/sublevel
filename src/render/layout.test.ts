import { expect, test } from "bun:test";
import { mat4, quat, v3, type Mat4, type Vec3 } from "../math";
import type { PointLight } from "../core/api";
import { MATERIAL_IDS } from "../core/materials";
import { MeshBuilder } from "../core/mesh";
import postWgsl from "./post.wgsl" with { type: "text" };
import sceneWgsl from "./scene.wgsl" with { type: "text" };
import {
  buildMipChain,
  computeInternalSize,
  DEBUG_DEPTH_RANGE,
  debugClearColor,
  DEBUG_VIEW_IDS,
  FRAME_FLOATS,
  FRAME_LIGHTS_OFFSET,
  FRAME_PALETTE_OFFSET,
  interleaveVertices,
  isRawDebugView,
  ITEM_FLOATS,
  linearToSrgb,
  MAX_LIGHTS,
  MAX_PALETTE,
  materialDebugColor,
  packFrameUniforms,
  packItem,
  computePresentSize,
  packPostUniforms,
  selectLights,
  srgbToLinear,
  VERTEX_FLOATS,
  writeNormalMatrix,
} from "./layout";

function light(x: number, z: number, intensity = 1, baked = false): PointLight {
  return {
    position: v3.create(x, 2, z),
    color: v3.create(1, 1, 1),
    radius: 5,
    intensity,
    baked,
  };
}

// --- Internal resolution ----------------------------------------------------

test("internal size keeps the window aspect at the requested height", () => {
  expect(computeInternalSize(1920, 1080, 240)).toEqual({
    width: 427,
    height: 240,
  });
  expect(computeInternalSize(1080, 1920, 360)).toEqual({
    width: 203,
    height: 360,
  });
});

test("internal size survives a zero-sized window and silly heights", () => {
  const size = computeInternalSize(0, 0, 240);
  expect(size.height).toBe(240);
  expect(size.width).toBeGreaterThan(0);
  expect(computeInternalSize(800, 600, 0).height).toBeGreaterThan(0);
  expect(computeInternalSize(800, 600, 1e9).height).toBeLessThanOrEqual(1080);
});

// --- Normal matrix ----------------------------------------------------------

function applyNormalMatrix(model: Mat4, n: Vec3): Vec3 {
  const m = new Float32Array(12);
  writeNormalMatrix(model, m, 0);
  return v3.normalize({
    x: m[0] * n.x + m[4] * n.y + m[8] * n.z,
    y: m[1] * n.x + m[5] * n.y + m[9] * n.z,
    z: m[2] * n.x + m[6] * n.y + m[10] * n.z,
  });
}

test("normal matrix keeps normals perpendicular under non-uniform scale", () => {
  const model = mat4.fromTRS(
    v3.create(3, 1, -2),
    quat.fromAxisAngle(v3.normalize(v3.create(1, 2, 3)), 0.8),
    v3.create(4, 0.5, 1.5),
  );
  // A sloped surface: tangent t lies in it, n is its normal.
  const t = v3.normalize(v3.create(1, 1, 0));
  const n = v3.normalize(v3.create(-1, 1, 0));
  const worldTangent = mat4.transformDirection(model, t);
  const worldNormal = applyNormalMatrix(model, n);
  expect(Math.abs(v3.dot(worldTangent, worldNormal))).toBeLessThan(1e-5);
  // Still points outward (same side as the naively transformed normal).
  expect(
    v3.dot(worldNormal, mat4.transformDirection(model, n)),
  ).toBeGreaterThan(0);
});

test("normal matrix equals the rotation for rigid transforms", () => {
  const q = quat.fromAxisAngle(v3.create(0, 1, 0), 1.1);
  const model = mat4.fromTRS(v3.create(5, 5, 5), q);
  const n = v3.create(0, 0, 1);
  const expected = quat.rotate(q, n);
  expect(v3.equalsApprox(applyNormalMatrix(model, n), expected, 1e-5)).toBe(
    true,
  );
});

test("normal matrix keeps normals outward for mirrored transforms", () => {
  const model = mat4.fromTRS(
    v3.create(0, 0, 0),
    quat.identity(),
    v3.create(-2, 1, 1),
  );
  const n = applyNormalMatrix(model, v3.create(1, 0, 0));
  expect(v3.equalsApprox(n, v3.create(-1, 0, 0), 1e-6)).toBe(true);
});

// --- Item packing -----------------------------------------------------------

test("packItem writes model, normal matrix, tint and flags at the slot", () => {
  const out = new Float32Array(ITEM_FLOATS * 2);
  const model = mat4.fromTRS(
    v3.create(1, 2, 3),
    quat.identity(),
    v3.create(2, 2, 2),
  );
  packItem(out, 1, model, v3.create(0.5, 0.25, 1), true, false, 7);
  const o = ITEM_FLOATS;
  expect(Array.from(out.subarray(o, o + 16))).toEqual(Array.from(model));
  expect(out[o + 16]).toBeGreaterThan(0);
  expect(Array.from(out.subarray(o + 28, o + 36))).toEqual([
    0.5, 0.25, 1, 1, 1, 0, 7, 0,
  ]);
  expect(out.subarray(0, ITEM_FLOATS).every((x) => x === 0)).toBe(true);
  packItem(out, 0, model, undefined, false, true);
  expect(Array.from(out.subarray(28, 36))).toEqual([1, 1, 1, 1, 0, 1, 0, 0]);
});

// --- Lights -----------------------------------------------------------------

test("selectLights keeps everything when under the limit, in order", () => {
  const lights = [light(0, 0), light(10, 0), light(-10, 0)];
  expect(selectLights(lights, v3.create(0, 0, 0), 16)).toEqual(lights);
});

test("selectLights drops lights that cannot contribute", () => {
  const off = light(0, 0, 0);
  const black = { ...light(0, 0), color: v3.create(0, 0, 0) };
  const noRadius = { ...light(0, 0), radius: 0 };
  const on = light(1, 1);
  expect(
    selectLights([off, black, noRadius, on], v3.create(0, 0, 0), 16),
  ).toEqual([on]);
});

test("selectLights keeps the lights nearest the camera when over the limit", () => {
  const lights: PointLight[] = [];
  for (let i = 0; i < 40; i++) {
    lights.push(light(i * 4, 0));
  }
  const chosen = selectLights(lights, v3.create(0, 0, 0), 16);
  expect(chosen.length).toBe(16);
  expect(chosen).toEqual(lights.slice(0, 16));
  // From the far end the far lights win.
  const far = selectLights(lights, v3.create(39 * 4, 0, 0), 16);
  expect(far).toEqual(lights.slice(24));
});

test("selectLights prefers a bright light over a dim one at equal distance", () => {
  const dim = light(20, 0, 0.1);
  const bright = light(-20, 0, 2);
  expect(selectLights([dim, bright], v3.create(0, 0, 0), 1)).toEqual([bright]);
});

// --- Frame uniforms ---------------------------------------------------------

test("packFrameUniforms lays out camera, fog, counts and lights", () => {
  const out = new Float32Array(FRAME_FLOATS);
  const viewProj = mat4.identity();
  const lights = [light(1, 2, 0.5, true), light(3, 4, 2, false)];
  packFrameUniforms(
    {
      viewProj,
      camera: {
        position: v3.create(7, 8, 9),
        orientation: quat.identity(),
        fovY: 1,
        near: 0.1,
        far: 100,
      },
      ambient: v3.create(0.1, 0.2, 0.3),
      fog: { color: v3.create(0.4, 0.5, 0.6), near: 5, far: 20 },
      time: 12.5,
      lights,
    },
    out,
  );
  expect(Array.from(out.subarray(0, 16))).toEqual(Array.from(viewProj));
  expect(Array.from(out.subarray(16, 19))).toEqual([7, 8, 9]);
  expect(out[20]).toBeCloseTo(0.1);
  expect(out[24]).toBeCloseTo(0.4);
  expect(out[27]).toBe(5);
  expect(out[28]).toBe(20);
  expect(out[29]).toBe(12.5);
  expect(new Uint32Array(out.buffer)[32]).toBe(2);
  const l0 = FRAME_LIGHTS_OFFSET;
  expect(Array.from(out.subarray(l0, l0 + 8))).toEqual([
    1, 2, 2, 5, 0.5, 0.5, 0.5, 1,
  ]);
  const l1 = FRAME_LIGHTS_OFFSET + 8;
  expect(Array.from(out.subarray(l1, l1 + 8))).toEqual([
    3, 2, 4, 5, 2, 2, 2, 0,
  ]);
});

test("packFrameUniforms clamps the light count and degenerate fog", () => {
  const out = new Float32Array(FRAME_FLOATS);
  const lights = Array.from({ length: MAX_LIGHTS + 5 }, (_, i) => light(i, 0));
  packFrameUniforms(
    {
      viewProj: mat4.identity(),
      camera: {
        position: v3.create(0, 0, 0),
        orientation: quat.identity(),
        fovY: 1,
        near: 0.1,
        far: 100,
      },
      ambient: v3.create(0, 0, 0),
      fog: { color: v3.create(0, 0, 0), near: 10, far: 10 },
      time: 0,
      lights,
    },
    out,
  );
  expect(new Uint32Array(out.buffer)[32]).toBe(MAX_LIGHTS);
  expect(out[28]).toBeGreaterThan(out[27]);
});

test("frame and item layouts match the WGSL structs", () => {
  // Frame: mat4 + 5 vec4 header, then MAX_LIGHTS lights of 2 vec4.
  expect(FRAME_LIGHTS_OFFSET).toBe(16 + 5 * 4);
  expect(FRAME_FLOATS * 4).toBe(144 + MAX_LIGHTS * 32 + MAX_PALETTE * 16);
  expect(sceneWgsl).toContain(`const MAX_PALETTE: u32 = ${MAX_PALETTE}u;`);
  // Item: mat4 + 5 vec4.
  expect(ITEM_FLOATS).toBe(16 + 5 * 4);
  expect(sceneWgsl).toContain(`const MAX_LIGHTS: u32 = ${MAX_LIGHTS}u;`);
  expect(postWgsl).toContain("params: vec4f");
});

test("packPostUniforms maps bits to levels", () => {
  expect(Array.from(packPostUniforms(5, true, "none", 1))).toEqual([
    31, 1, 0, 1,
  ]);
  expect(Array.from(packPostUniforms(8, true, "none", 1))).toEqual([
    255, 0, 0, 1,
  ]);
  expect(Array.from(packPostUniforms(6, false, "none", 2))).toEqual([
    63, 0, 0, 2,
  ]);
});

test("computePresentSize picks a whole upscale factor", () => {
  // 1080 / 300 = 3.6 rounds to 4: every output pixel is 4 device pixels.
  expect(computePresentSize(1920, 1080, 1, 300)).toEqual({
    width: 480,
    height: 270,
    scale: 4,
  });
  // The device pixel ratio counts: 1536 x 864 CSS at 1.25 is 1920 x 1080.
  expect(computePresentSize(1536, 864, 1.25, 300)).toEqual({
    width: 480,
    height: 270,
    scale: 4,
  });
  // The output always covers the window, overhanging by under one pixel.
  for (const [w, h] of [
    [1280, 720],
    [1366, 768],
    [2560, 1440],
    [801, 603],
    [300, 200],
  ]) {
    const size = computePresentSize(w, h, 1, 300);
    expect(Number.isInteger(size.scale)).toBe(true);
    expect(size.scale).toBeGreaterThanOrEqual(1);
    expect(size.width * size.scale).toBeGreaterThanOrEqual(w);
    expect(size.width * size.scale - w).toBeLessThan(size.scale);
    expect(size.height * size.scale).toBeGreaterThanOrEqual(h);
    expect(size.height * size.scale - h).toBeLessThan(size.scale);
  }
});

// --- Vertices ---------------------------------------------------------------

test("interleaveVertices packs position, normal, uv and colour", () => {
  const b = new MeshBuilder("crate_wood");
  b.addVertex(
    v3.create(1, 2, 3),
    v3.create(0, 1, 0),
    { u: 4, v: 5 },
    v3.create(0.1, 0.2, 0.3),
  );
  b.addVertex(
    v3.create(6, 7, 8),
    v3.create(1, 0, 0),
    { u: 9, v: 10 },
    v3.create(1, 1, 1),
  );
  b.addVertex(
    v3.create(0, 0, 0),
    v3.create(0, 0, 1),
    { u: 0, v: 0 },
    v3.create(1, 1, 1),
  );
  b.addTriangle(0, 1, 2);
  const data = interleaveVertices(b.build());
  expect(data.length).toBe(3 * VERTEX_FLOATS);
  expect(Array.from(data.subarray(0, VERTEX_FLOATS))).toEqual(
    Array.from(new Float32Array([1, 2, 3, 0, 1, 0, 4, 5, 0.1, 0.2, 0.3])),
  );
  expect(data[VERTEX_FLOATS + 6]).toBe(9);
});

test("interleaveVertices leaves colour zero without colours and rejects bad indices", () => {
  const b = new MeshBuilder("crate_wood");
  b.addBox(v3.create(0, 0, 0), v3.create(1, 1, 1));
  const mesh = b.build();
  expect(mesh.colors).toBeUndefined();
  const data = interleaveVertices(mesh);
  expect(data[8]).toBe(0);
  expect(() =>
    interleaveVertices({ ...mesh, indices: new Uint32Array([0, 1, 999]) }),
  ).toThrow();
});

// --- Colour and mips --------------------------------------------------------

test("sRGB conversions round-trip", () => {
  for (const c of [0, 0.002, 0.04, 0.2, 0.5, 0.9, 1]) {
    expect(linearToSrgb(srgbToLinear(c))).toBeCloseTo(c, 6);
  }
});

test("buildMipChain goes down to 1x1 and averages in linear light", () => {
  const size = 4;
  const pixels = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const black = (i + Math.floor(i / size)) % 2 === 0;
    pixels.set(black ? [0, 0, 0, 255] : [255, 255, 255, 255], i * 4);
  }
  const levels = buildMipChain(size, pixels);
  expect(levels.map((l) => l.size)).toEqual([4, 2, 1]);
  expect(levels[0].pixels).toBe(pixels);
  // Half black, half white in linear light is sRGB ~188, not 128.
  const v = levels[2].pixels[0];
  expect(v).toBeGreaterThanOrEqual(186);
  expect(v).toBeLessThanOrEqual(190);
  expect(levels[2].pixels[3]).toBe(255);
});

test("buildMipChain rejects a wrong byte count", () => {
  expect(() => buildMipChain(16, new Uint8Array(10))).toThrow();
});
