// Scene pass: textured, lit, fogged geometry into a linear HDR target at the
// internal resolution. Layouts must match src/render/layout.ts.

const MAX_LIGHTS: u32 = 32u;
const MAX_PALETTE: u32 = 32u;

// Debug views (ids from DEBUG_VIEW_IDS in layout.ts). The raw ones (coverage,
// material, depth, normals) write their final colour straight to the target
// and the present pass copies it untouched.
const VIEW_COVERAGE: u32 = 1u;
const VIEW_MATERIAL: u32 = 2u;
const VIEW_DEPTH: u32 = 3u;
const VIEW_NORMALS: u32 = 4u;
const VIEW_LIGHTING: u32 = 5u;
const DEPTH_RANGE: f32 = 40.0;

struct Light {
  // xyz = position, w = radius
  posRadius: vec4f,
  // rgb = color * intensity, w = 1 if baked into level vertex colours
  colorBaked: vec4f,
}

struct Frame {
  viewProj: mat4x4f,
  cameraPos: vec4f,
  ambient: vec4f,
  // rgb = fog colour, w = fog near
  fogColor: vec4f,
  // x = fog far, y = time
  fogParams: vec4f,
  // x = light count, y = debug view
  counts: vec4u,
  lights: array<Light, MAX_LIGHTS>,
  // rgb = flat debug colour of each material, indexed by item.flags.z
  palette: array<vec4f, MAX_PALETTE>,
}

struct Item {
  model: mat4x4f,
  // Inverse-transpose of the model's upper 3x3 (up to scale), as columns.
  normal0: vec4f,
  normal1: vec4f,
  normal2: vec4f,
  tint: vec4f,
  // x = mesh has baked colours, y = emissive material
  flags: vec4f,
}

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> items: array<Item>;
@group(0) @binding(2) var albedoSampler: sampler;
@group(1) @binding(0) var albedo: texture_2d<f32>;

struct VertexIn {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) color: vec3f,
  // Each draw passes its item index as firstInstance.
  @builtin(instance_index) item: u32,
}

struct VertexOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) color: vec3f,
  @location(4) @interpolate(flat) item: u32,
}

@vertex
fn vs(in: VertexIn) -> VertexOut {
  let item = items[in.item];
  let world = item.model * vec4f(in.position, 1.0);
  let normalMatrix = mat3x3f(item.normal0.xyz, item.normal1.xyz, item.normal2.xyz);
  var out: VertexOut;
  out.clip = frame.viewProj * world;
  out.world = world.xyz;
  out.normal = normalMatrix * in.normal;
  out.uv = in.uv;
  out.color = in.color;
  out.item = in.item;
  return out;
}

@fragment
fn fs(in: VertexOut) -> @location(0) vec4f {
  // Sampled first, in uniform control flow, so mip selection is well defined.
  let sampled = textureSample(albedo, albedoSampler, in.uv);
  // Alpha test (cut-out textures); applies to every debug view too.
  if (sampled.a < 0.5) {
    discard;
  }
  let view = frame.counts.y;
  let item = items[in.item];
  if (view == VIEW_COVERAGE) {
    return vec4f(1.0, 1.0, 1.0, 1.0);
  }
  if (view == VIEW_MATERIAL) {
    return vec4f(frame.palette[min(u32(item.flags.z), MAX_PALETTE - 1u)].rgb, 1.0);
  }
  if (view == VIEW_DEPTH) {
    let range = distance(in.world, frame.cameraPos.xyz) / DEPTH_RANGE;
    return vec4f(vec3f(1.0 - clamp(range, 0.0, 1.0)), 1.0);
  }
  if (view == VIEW_NORMALS) {
    return vec4f(normalize(in.normal) * 0.5 + 0.5, 1.0);
  }
  let lightingOnly = view == VIEW_LIGHTING;
  let texel = select(sampled.rgb, vec3f(1.0), lightingOnly);
  let tint = select(item.tint.rgb, vec3f(1.0), lightingOnly);
  let baked = item.flags.x > 0.5;
  let emissive = item.flags.y > 0.5;

  var light = vec3f(1.0);
  if (!emissive) {
    let n = normalize(in.normal);
    // Baked meshes already contain ambient and baked lights in their colours.
    light = select(frame.ambient.rgb, in.color, baked);
    let count = min(frame.counts.x, MAX_LIGHTS);
    for (var i = 0u; i < count; i++) {
      let l = frame.lights[i];
      if (baked && l.colorBaked.w > 0.5) {
        continue;
      }
      let toLight = l.posRadius.xyz - in.world;
      let d = length(toLight);
      let falloff = clamp(1.0 - d / l.posRadius.w, 0.0, 1.0);
      let ndotl = max(dot(n, toLight / max(d, 1e-4)), 0.0);
      light += l.colorBaked.rgb * (falloff * falloff * ndotl);
    }
  }

  let surface = texel * light * tint;
  let fogNear = frame.fogColor.w;
  let fogFar = frame.fogParams.x;
  let dist = distance(in.world, frame.cameraPos.xyz);
  let fog = clamp((dist - fogNear) / (fogFar - fogNear), 0.0, 1.0);
  return vec4f(mix(surface, frame.fogColor.rgb, fog), 1.0);
}
