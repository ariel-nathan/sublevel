/**
 * Pure (WebGPU-free) parts of the renderer: buffer layouts, packing, light
 * selection, internal resolution and texture mip chains. Everything here is
 * covered by layout.test.ts; the layouts must match scene.wgsl / post.wgsl.
 */
import type { Mat4, Vec3 } from "../math";
import type {
  Aabb,
  Camera,
  Color,
  DebugView,
  Fog,
  PointLight,
} from "../core/api";
import { MATERIAL_IDS } from "../core/materials";
import type { MeshData } from "../core/mesh";

// ---------------------------------------------------------------------------
// Debug views
// ---------------------------------------------------------------------------

/**
 * Numeric id of each debug view, as used by scene.wgsl (frame.counts.y) and
 * post.wgsl (params.z). Keep in sync with the constants at the top of both.
 */
export const DEBUG_VIEW_IDS: Readonly<Record<DebugView, number>> = {
  none: 0,
  coverage: 1,
  material: 2,
  depth: 3,
  normals: 4,
  lighting: 5,
};

/** Distance in metres at which the "depth" view reaches black. */
export const DEBUG_DEPTH_RANGE = 40;

/**
 * Views whose scene output is the final colour: the present pass copies it
 * without sRGB encoding, dithering or quantisation.
 */
export function isRawDebugView(view: DebugView): boolean {
  return (
    view === "coverage" ||
    view === "material" ||
    view === "depth" ||
    view === "normals"
  );
}

/** Scene clear colour: magenta for coverage/material, black for depth/normals. */
export function debugClearColor(view: DebugView, fog: Color): Color {
  if (view === "coverage" || view === "material") {
    return { x: 1, y: 0, z: 1 };
  }
  if (view === "depth" || view === "normals") {
    return { x: 0, y: 0, z: 0 };
  }
  return fog;
}

/** Room for this many materials in the frame uniforms' debug palette. */
export const MAX_PALETTE = 32;

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number): number => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

/**
 * Flat colour (bytes 0..255) of the material with the given index in
 * MATERIAL_IDS. Hues step by the golden angle, skipping the magenta band
 * (reserved for "nothing drawn"), and saturation/value alternate so
 * neighbouring ids differ strongly. Never white, black or magenta.
 */
export function materialDebugColor(index: number): [number, number, number] {
  // 23 is prime, so stepping by 10 slots visits every hue slot once and
  // neighbouring ids land about 140 degrees apart.
  const slot = (index * 10) % 23;
  // Squeeze the hue circle into 330 degrees and open a 30 degree gap at magenta.
  let degrees = (slot / 23) * 330;
  if (degrees >= 285) {
    degrees += 30;
  }
  const level = index % 3;
  const saturation = [1, 0.6, 1][level];
  const value = [1, 0.75, 0.6][level];
  const [r, g, b] = hsvToRgb(degrees / 360, saturation, value);
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

// ---------------------------------------------------------------------------
// Retro finish
// ---------------------------------------------------------------------------

/**
 * Ordered 4x4 Bayer dithering before colour quantisation. Set to false for a
 * clean (undithered) image.
 */
export const RETRO_DITHER = true;

/**
 * Bits per colour channel of the final image (5 = 15-bit "high colour").
 * Set to 8 to turn quantisation off.
 */
export const RETRO_COLOR_BITS = 5;

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Lights evaluated per frame. Must match MAX_LIGHTS in scene.wgsl. */
export const MAX_LIGHTS = 32;

/** Smallest and largest internal heights accepted. */
export const MIN_INTERNAL_HEIGHT = 64;
export const MAX_INTERNAL_HEIGHT = 1080;

// ---------------------------------------------------------------------------
// Internal resolution
// ---------------------------------------------------------------------------

export interface InternalSize {
  width: number;
  height: number;
}

/**
 * Internal render size: a fixed height and the width that keeps the window's
 * aspect ratio, so the nearest-neighbour upscale fills the window with square
 * pixels (to within half an internal pixel).
 */
export function computeInternalSize(
  windowWidth: number,
  windowHeight: number,
  internalHeight: number,
): InternalSize {
  const height = Math.round(
    Math.min(
      MAX_INTERNAL_HEIGHT,
      Math.max(MIN_INTERNAL_HEIGHT, internalHeight || 0),
    ),
  );
  const aspect =
    windowWidth > 0 && windowHeight > 0 ? windowWidth / windowHeight : 4 / 3;
  const width = Math.max(1, Math.min(8192, Math.round(height * aspect)));
  return { width, height };
}

/**
 * How many times finer than the output the scene is rendered on each axis.
 * The present pass averages each block down to one output pixel, which
 * smooths edges and distant texture detail while keeping chunky pixels.
 * 1 turns supersampling off.
 */
export const SUPERSAMPLE = 3;

export interface PresentSize extends InternalSize {
  /** Device pixels per output pixel on each axis: a whole number. */
  scale: number;
}

/**
 * Output size for a window, chosen so that every output pixel covers exactly
 * `scale` x `scale` device pixels. A fractional upscale makes some pixels
 * wider than others, which shows as wobbling edges when the view moves.
 * The height lands as close to `targetHeight` as a whole scale allows; the
 * image may overhang the window by less than one output pixel.
 */
export function computePresentSize(
  windowWidth: number,
  windowHeight: number,
  pixelRatio: number,
  targetHeight: number,
): PresentSize {
  const ratio = pixelRatio > 0 ? pixelRatio : 1;
  const deviceWidth = Math.max(1, Math.round(windowWidth * ratio));
  const deviceHeight = Math.max(1, Math.round(windowHeight * ratio));
  const target = Math.min(
    MAX_INTERNAL_HEIGHT,
    Math.max(MIN_INTERNAL_HEIGHT, targetHeight || 0),
  );
  const scale = Math.max(1, Math.round(deviceHeight / target));
  return {
    width: Math.min(8192, Math.ceil(deviceWidth / scale)),
    height: Math.ceil(deviceHeight / scale),
    scale,
  };
}

// ---------------------------------------------------------------------------
// Vertex layout: position(3) normal(3) uv(2) color(3), float32, interleaved.
// ---------------------------------------------------------------------------

export const VERTEX_FLOATS = 11;
export const VERTEX_STRIDE = VERTEX_FLOATS * 4;
export const VERTEX_OFFSETS = {
  position: 0,
  normal: 12,
  uv: 24,
  color: 32,
} as const;

/** Interleaves a mesh into the vertex layout above. Throws on bad data. */
export function interleaveVertices(mesh: MeshData): Float32Array {
  const count = Math.floor(mesh.positions.length / 3);
  if (mesh.positions.length !== count * 3) {
    throw new Error("render: mesh positions length is not a multiple of 3");
  }
  if (mesh.normals.length < count * 3) {
    throw new Error("render: mesh has fewer normals than positions");
  }
  if (mesh.uvs.length < count * 2) {
    throw new Error("render: mesh has fewer uvs than positions");
  }
  if (mesh.colors && mesh.colors.length < count * 3) {
    throw new Error("render: mesh has fewer colors than positions");
  }
  for (let i = 0; i < mesh.indices.length; i++) {
    if (mesh.indices[i] >= count) {
      throw new Error(
        `render: mesh index ${mesh.indices[i]} out of range (${count} vertices)`,
      );
    }
  }
  const out = new Float32Array(count * VERTEX_FLOATS);
  const colors = mesh.colors;
  for (let i = 0; i < count; i++) {
    const o = i * VERTEX_FLOATS;
    out[o] = mesh.positions[i * 3];
    out[o + 1] = mesh.positions[i * 3 + 1];
    out[o + 2] = mesh.positions[i * 3 + 2];
    out[o + 3] = mesh.normals[i * 3];
    out[o + 4] = mesh.normals[i * 3 + 1];
    out[o + 5] = mesh.normals[i * 3 + 2];
    out[o + 6] = mesh.uvs[i * 2];
    out[o + 7] = mesh.uvs[i * 2 + 1];
    if (colors) {
      out[o + 8] = colors[i * 3];
      out[o + 9] = colors[i * 3 + 1];
      out[o + 10] = colors[i * 3 + 2];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Normal matrix
// ---------------------------------------------------------------------------

/**
 * Inverse-transpose of the model matrix's upper 3x3, written as three
 * column vec4s (12 floats, w = 0) at `offset`. Correct for non-uniform scale.
 * The result is scaled by an arbitrary positive factor (the shader
 * renormalises), so it uses the cofactor matrix and never divides by a
 * near-zero determinant; only its sign is applied, so mirrored transforms
 * still get outward normals.
 */
export function writeNormalMatrix(
  model: Mat4,
  out: Float32Array,
  offset: number,
): void {
  const a = model[0];
  const b = model[1];
  const c = model[2];
  const d = model[4];
  const e = model[5];
  const f = model[6];
  const g = model[8];
  const h = model[9];
  const i = model[10];
  // Columns of M are (a,b,c), (d,e,f), (g,h,i). The cofactor matrix
  // cof(M) = det(M) * inverse(M)^T has columns col1 x col2, col2 x col0,
  // col0 x col1.
  const c0x = e * i - f * h;
  const c0y = f * g - d * i;
  const c0z = d * h - e * g;
  const c1x = h * c - i * b;
  const c1y = i * a - g * c;
  const c1z = g * b - h * a;
  const c2x = b * f - c * e;
  const c2y = c * d - a * f;
  const c2z = a * e - b * d;
  const det = a * c0x + b * c0y + c * c0z;
  const s = det < 0 ? -1 : 1;
  out[offset] = c0x * s;
  out[offset + 1] = c0y * s;
  out[offset + 2] = c0z * s;
  out[offset + 3] = 0;
  out[offset + 4] = c1x * s;
  out[offset + 5] = c1y * s;
  out[offset + 6] = c1z * s;
  out[offset + 7] = 0;
  out[offset + 8] = c2x * s;
  out[offset + 9] = c2y * s;
  out[offset + 10] = c2z * s;
  out[offset + 11] = 0;
}

// ---------------------------------------------------------------------------
// Per-item data (storage buffer, one Item per draw, indexed by instance_index)
//   model: mat4x4f, normal: 3 x vec4f, tint: vec4f, flags: vec4f
//   flags = (baked colours, emissive, material index, 0)
// ---------------------------------------------------------------------------

export const ITEM_FLOATS = 36;
export const ITEM_STRIDE = ITEM_FLOATS * 4;

export function packItem(
  out: Float32Array,
  index: number,
  model: Mat4,
  tint: Color | undefined,
  hasColors: boolean,
  emissive: boolean,
  materialIndex = 0,
): void {
  const o = index * ITEM_FLOATS;
  out.set(model.subarray(0, 16), o);
  writeNormalMatrix(model, out, o + 16);
  out[o + 28] = tint ? tint.x : 1;
  out[o + 29] = tint ? tint.y : 1;
  out[o + 30] = tint ? tint.z : 1;
  out[o + 31] = 1;
  out[o + 32] = hasColors ? 1 : 0;
  out[o + 33] = emissive ? 1 : 0;
  out[o + 34] = materialIndex;
  out[o + 35] = 0;
}

// ---------------------------------------------------------------------------
// Light selection
// ---------------------------------------------------------------------------

/** Width in metres of the fade inside each face of a light's bounds box. */
export const LIGHT_BOUNDS_FADE = 0.25;

/** Half-extent used to encode "no bounds"; finite so it is safe in uniforms. */
export const UNBOUNDED_EXTENT = 1e30;

function smoothstep01(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/**
 * CPU reference of the shader's bounds factor: 1 deep inside the box, 0 on
 * and outside its faces, a product of per-axis smoothsteps over the last
 * `fade` metres inside each face. Without bounds it is always 1.
 */
export function lightBoundsFade(
  bounds: Aabb | undefined,
  x: number,
  y: number,
  z: number,
  fade: number = LIGHT_BOUNDS_FADE,
): number {
  if (!bounds) {
    return 1;
  }
  const axis = (v: number, lo: number, hi: number): number =>
    Math.min(smoothstep01((v - lo) / fade), smoothstep01((hi - v) / fade));
  return (
    axis(x, bounds.min.x, bounds.max.x) *
    axis(y, bounds.min.y, bounds.max.y) *
    axis(z, bounds.min.z, bounds.max.z)
  );
}

/** Distance from a point to a box (0 inside it). */
export function distanceToBox(box: Aabb, p: Vec3): number {
  const dx = Math.max(box.min.x - p.x, 0, p.x - box.max.x);
  const dy = Math.max(box.min.y - p.y, 0, p.y - box.max.y);
  const dz = Math.max(box.min.z - p.z, 0, p.z - box.max.z);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * How much a light is likely to matter on screen: its brightness, reduced
 * the further the camera is outside its radius. A light confined to a box
 * that does not contain the camera counts as that much further away, by the
 * camera's distance to the box.
 */
export function lightRelevance(light: PointLight, eye: Vec3): number {
  const brightness =
    light.intensity * Math.max(light.color.x, light.color.y, light.color.z);
  if (!(brightness > 0) || !(light.radius > 0)) {
    return 0;
  }
  const dx = light.position.x - eye.x;
  const dy = light.position.y - eye.y;
  const dz = light.position.z - eye.z;
  const boxGap = light.bounds ? distanceToBox(light.bounds, eye) : 0;
  const gap =
    Math.max(0, Math.sqrt(dx * dx + dy * dy + dz * dz) - light.radius) + boxGap;
  const t = 1 + gap / light.radius;
  return brightness / (t * t);
}

/**
 * Lights to upload this frame: those that can contribute, at most `max`,
 * keeping the most relevant to the camera when there are too many. Input
 * order is preserved among the chosen lights.
 */
export function selectLights(
  lights: readonly PointLight[],
  eye: Vec3,
  max: number = MAX_LIGHTS,
): PointLight[] {
  const scored: { light: PointLight; score: number; index: number }[] = [];
  for (let i = 0; i < lights.length; i++) {
    const score = lightRelevance(lights[i], eye);
    if (score > 0) {
      scored.push({ light: lights[i], score, index: i });
    }
  }
  if (scored.length > max) {
    scored.sort((p, q) => q.score - p.score || p.index - q.index);
    scored.length = max;
    scored.sort((p, q) => p.index - q.index);
  }
  return scored.map((s) => s.light);
}

// ---------------------------------------------------------------------------
// Frame uniforms (must match `Frame` in scene.wgsl)
//   0  viewProj   mat4x4f
//   16 cameraPos  vec4f  (xyz)
//   20 ambient    vec4f  (rgb)
//   24 fogColor   vec4f  (rgb, w = fog near)
//   28 fogParams  vec4f  (x = fog far, y = time)
//   32 counts     vec4u  (x = light count, y = debug view id)
//   36 lights     array<Light, MAX_LIGHTS>, Light = posRadius vec4f,
//                 colorBaked vec4f (rgb = color * intensity, w = baked),
//                 boundsMin vec4f (xyz, w = 1 if the light has bounds),
//                 boundsMax vec4f (xyz; +-UNBOUNDED_EXTENT without bounds)
//   then palette  array<vec4f, MAX_PALETTE> (rgb = material debug colour 0..1)
// ---------------------------------------------------------------------------

export const FRAME_LIGHTS_OFFSET = 36;
export const LIGHT_FLOATS = 16;
export const FRAME_PALETTE_OFFSET =
  FRAME_LIGHTS_OFFSET + MAX_LIGHTS * LIGHT_FLOATS;
export const FRAME_FLOATS = FRAME_PALETTE_OFFSET + MAX_PALETTE * 4;
export const FRAME_BYTES = FRAME_FLOATS * 4;

export interface FrameUniformInput {
  viewProj: Mat4;
  camera: Camera;
  ambient: Color;
  fog: Fog;
  time: number;
  lights: readonly PointLight[];
  /** Defaults to "none". */
  debugView?: DebugView;
}

/** Writes the frame uniforms into `out` (FRAME_FLOATS long). */
export function packFrameUniforms(
  input: FrameUniformInput,
  out: Float32Array,
): void {
  out.fill(0);
  out.set(input.viewProj.subarray(0, 16), 0);
  const eye = input.camera.position;
  out[16] = eye.x;
  out[17] = eye.y;
  out[18] = eye.z;
  out[20] = input.ambient.x;
  out[21] = input.ambient.y;
  out[22] = input.ambient.z;
  out[24] = input.fog.color.x;
  out[25] = input.fog.color.y;
  out[26] = input.fog.color.z;
  out[27] = input.fog.near;
  out[28] = Math.max(input.fog.far, input.fog.near + 1e-3);
  out[29] = input.time;
  const count = Math.min(input.lights.length, MAX_LIGHTS);
  const counts = new Uint32Array(out.buffer, out.byteOffset + 32 * 4, 4);
  counts[0] = count;
  counts[1] = DEBUG_VIEW_IDS[input.debugView ?? "none"];
  for (let i = 0; i < count; i++) {
    const light = input.lights[i];
    const o = FRAME_LIGHTS_OFFSET + i * LIGHT_FLOATS;
    out[o] = light.position.x;
    out[o + 1] = light.position.y;
    out[o + 2] = light.position.z;
    out[o + 3] = light.radius;
    out[o + 4] = light.color.x * light.intensity;
    out[o + 5] = light.color.y * light.intensity;
    out[o + 6] = light.color.z * light.intensity;
    out[o + 7] = light.baked ? 1 : 0;
    const b = light.bounds;
    out[o + 8] = b ? b.min.x : -UNBOUNDED_EXTENT;
    out[o + 9] = b ? b.min.y : -UNBOUNDED_EXTENT;
    out[o + 10] = b ? b.min.z : -UNBOUNDED_EXTENT;
    out[o + 11] = b ? 1 : 0;
    out[o + 12] = b ? b.max.x : UNBOUNDED_EXTENT;
    out[o + 13] = b ? b.max.y : UNBOUNDED_EXTENT;
    out[o + 14] = b ? b.max.z : UNBOUNDED_EXTENT;
  }
  for (let i = 0; i < MATERIAL_IDS.length && i < MAX_PALETTE; i++) {
    const [r, g, b] = materialDebugColor(i);
    const o = FRAME_PALETTE_OFFSET + i * 4;
    out[o] = r / 255;
    out[o + 1] = g / 255;
    out[o + 2] = b / 255;
    out[o + 3] = 1;
  }
}

// ---------------------------------------------------------------------------
// Post uniforms (must match `Post` in post.wgsl):
//   x = levels, y = dither, z = 1 to copy the scene colour through untouched
//   (raw debug views)
// ---------------------------------------------------------------------------

export function packPostUniforms(
  colorBits: number,
  dither: boolean,
  debugView: DebugView = "none",
  supersample: number = SUPERSAMPLE,
): Float32Array {
  const bits = Math.min(8, Math.max(1, Math.round(colorBits)));
  return new Float32Array([
    (1 << bits) - 1,
    dither && bits < 8 ? 1 : 0,
    isRawDebugView(debugView) ? 1 : 0,
    Math.max(1, Math.round(supersample)),
  ]);
}

// ---------------------------------------------------------------------------
// Colour and textures
// ---------------------------------------------------------------------------

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(c: number): number {
  const x = Math.min(1, Math.max(0, c));
  return x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055;
}

const SRGB_TO_LINEAR_LUT = (() => {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    lut[i] = srgbToLinear(i / 255);
  }
  return lut;
})();

export interface MipLevel {
  size: number;
  pixels: Uint8Array;
}

/**
 * Full mip chain for a square power-of-two RGBA8 sRGB image, down to 1x1.
 * Each level is a 2x2 box filter of the previous one. Alpha is averaged
 * linearly; colour is averaged in linear light weighted by alpha (a
 * premultiplied average, then un-premultiplied), so transparent texels never
 * darken or tint the opaque ones. Fully transparent blocks fall back to the
 * plain colour average. At coarse levels a cut-out pattern thins out, which
 * is accepted. Opaque images give the plain linear-light average. Level 0 is
 * the input itself.
 */
export function buildMipChain(size: number, pixels: Uint8Array): MipLevel[] {
  if (pixels.length !== size * size * 4) {
    throw new Error(
      `render: texture of size ${size} has ${pixels.length} bytes, expected ${size * size * 4}`,
    );
  }
  const levels: MipLevel[] = [{ size, pixels }];
  let prev = pixels;
  let prevSize = size;
  const sum = [0, 0, 0];
  const plain = [0, 0, 0];
  while (prevSize > 1) {
    const s = Math.max(1, prevSize >> 1);
    const next = new Uint8Array(s * s * 4);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const o = (y * s + x) * 4;
        sum.fill(0);
        plain.fill(0);
        let alphaSum = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const sx = Math.min(prevSize - 1, x * 2 + dx);
            const sy = Math.min(prevSize - 1, y * 2 + dy);
            const i = (sy * prevSize + sx) * 4;
            const a = prev[i + 3] / 255;
            alphaSum += a;
            for (let ch = 0; ch < 3; ch++) {
              const lin = SRGB_TO_LINEAR_LUT[prev[i + ch]];
              sum[ch] += lin * a;
              plain[ch] += lin;
            }
          }
        }
        for (let ch = 0; ch < 3; ch++) {
          const avg = alphaSum > 0 ? sum[ch] / alphaSum : plain[ch] / 4;
          next[o + ch] = Math.round(linearToSrgb(avg) * 255);
        }
        next[o + 3] = Math.round((alphaSum / 4) * 255);
      }
    }
    levels.push({ size: s, pixels: next });
    prev = next;
    prevSize = s;
  }
  return levels;
}
