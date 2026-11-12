import { expect, test } from "bun:test";
import { mat4, quat, v3 } from "../math";
import { MATERIAL_IDS } from "../core/materials";
import sceneWgsl from "./scene.wgsl" with { type: "text" };
import {
  buildMipChain,
  DEBUG_DEPTH_RANGE,
  DEBUG_VIEW_IDS,
  debugClearColor,
  FRAME_FLOATS,
  FRAME_PALETTE_OFFSET,
  isRawDebugView,
  MAX_PALETTE,
  materialDebugColor,
  packFrameUniforms,
  packPostUniforms,
} from "./layout";

// --- Mip alpha --------------------------------------------------------------

test("buildMipChain averages colour only over opaque texels", () => {
  // 2x2: one opaque red texel, three transparent black ones.
  const pixels = new Uint8Array([
    255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  const levels = buildMipChain(2, pixels);
  expect(Array.from(levels[1].pixels)).toEqual([255, 0, 0, 64]);
});

test("buildMipChain keeps fully transparent blocks transparent", () => {
  const levels = buildMipChain(2, new Uint8Array(2 * 2 * 4));
  expect(levels[1].pixels[3]).toBe(0);
});

test("buildMipChain leaves opaque images' alpha at 255", () => {
  const size = 8;
  const pixels = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    pixels.set([i * 3, 255 - i, 40, 255], i * 4);
  }
  for (const level of buildMipChain(size, pixels)) {
    for (let i = 3; i < level.pixels.length; i += 4) {
      expect(level.pixels[i]).toBe(255);
    }
  }
});

test("buildMipChain: a cut-out grating thins out but keeps its colour", () => {
  const size = 8;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Opaque grey bars every other column, holes (black, alpha 0) between.
      const texel = x % 2 === 0 ? [200, 200, 200, 255] : [0, 0, 0, 0];
      pixels.set(texel, (y * size + x) * 4);
    }
  }
  for (const level of buildMipChain(size, pixels).slice(1)) {
    expect(level.pixels[3]).toBeGreaterThanOrEqual(127);
    expect(level.pixels[3]).toBeLessThanOrEqual(128);
    for (let ch = 0; ch < 3; ch++) {
      expect(level.pixels[ch]).toBe(200);
    }
  }
});

// --- Debug views ------------------------------------------------------------

test("debug view ids match the shader constants", () => {
  for (const [name, view] of [
    ["COVERAGE", "coverage"],
    ["MATERIAL", "material"],
    ["DEPTH", "depth"],
    ["NORMALS", "normals"],
    ["LIGHTING", "lighting"],
  ] as const) {
    expect(sceneWgsl).toContain(`VIEW_${name}: u32 = ${DEBUG_VIEW_IDS[view]}u`);
  }
  expect(sceneWgsl).toContain(`DEPTH_RANGE: f32 = ${DEBUG_DEPTH_RANGE}.0`);
  expect(new Set(Object.values(DEBUG_VIEW_IDS)).size).toBe(6);
  expect(DEBUG_VIEW_IDS.none).toBe(0);
});

test("packPostUniforms flags raw debug views", () => {
  expect(packPostUniforms(5, true, "none")[2]).toBe(0);
  expect(packPostUniforms(5, true, "lighting")[2]).toBe(0);
  for (const view of ["coverage", "material", "depth", "normals"] as const) {
    expect(isRawDebugView(view)).toBe(true);
    expect(packPostUniforms(5, true, view)[2]).toBe(1);
  }
});

test("packFrameUniforms writes the debug view and the material palette", () => {
  const out = new Float32Array(FRAME_FLOATS);
  const input = {
    viewProj: mat4.identity(),
    camera: {
      position: v3.create(0, 0, 0),
      orientation: quat.identity(),
      fovY: 1,
      near: 0.1,
      far: 100,
    },
    ambient: v3.create(0, 0, 0),
    fog: { color: v3.create(0, 0, 0), near: 10, far: 20 },
    time: 0,
    lights: [],
  };
  packFrameUniforms(input, out);
  expect(new Uint32Array(out.buffer)[33]).toBe(0);
  packFrameUniforms({ ...input, debugView: "material" as const }, out);
  expect(new Uint32Array(out.buffer)[33]).toBe(DEBUG_VIEW_IDS.material);
  const o = FRAME_PALETTE_OFFSET + 3 * 4;
  const [r, g, b] = materialDebugColor(3);
  expect(Array.from(out.subarray(o, o + 4))).toEqual(
    Array.from(new Float32Array([r / 255, g / 255, b / 255, 1])),
  );
});

test("debug clear colours: magenta for coverage/material, fog otherwise", () => {
  const fog = v3.create(0.1, 0.2, 0.3);
  expect(debugClearColor("coverage", fog)).toEqual({ x: 1, y: 0, z: 1 });
  expect(debugClearColor("material", fog)).toEqual({ x: 1, y: 0, z: 1 });
  expect(debugClearColor("none", fog)).toBe(fog);
  expect(debugClearColor("lighting", fog)).toBe(fog);
});

test("material debug colours are distinct, vivid and never white, black or magenta", () => {
  const colors = MATERIAL_IDS.map((_, i) => materialDebugColor(i));
  expect(colors.length).toBeLessThanOrEqual(MAX_PALETTE);
  const dist = (a: number[], b: number[]): number =>
    Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  for (let i = 0; i < colors.length; i++) {
    const [r, g, b] = colors[i];
    expect(Math.max(r, g, b)).toBeGreaterThanOrEqual(150);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeGreaterThanOrEqual(80);
    expect(dist(colors[i], [255, 0, 255])).toBeGreaterThan(90);
    for (let j = i + 1; j < colors.length; j++) {
      expect(dist(colors[i], colors[j])).toBeGreaterThan(30);
    }
    if (i > 0) {
      expect(dist(colors[i], colors[i - 1])).toBeGreaterThan(100);
    }
  }
});
