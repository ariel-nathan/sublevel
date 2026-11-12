// Scene pass: textured, lit, fogged geometry into a linear HDR target at the
// internal resolution. Layouts must match src/render/layout.ts.

const MAX_LIGHTS: u32 = 32u;

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
  // x = light count
  counts: vec4u,
  lights: array<Light, MAX_LIGHTS>,
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
  let texel = textureSample(albedo, albedoSampler, in.uv).rgb;
  let item = items[in.item];
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

  let surface = texel * light * item.tint.rgb;
  let fogNear = frame.fogColor.w;
  let fogFar = frame.fogParams.x;
  let dist = distance(in.world, frame.cameraPos.xyz);
  let fog = clamp((dist - fogNear) / (fogFar - fogNear), 0.0, 1.0);
  return vec4f(mix(surface, frame.fogColor.rgb, fog), 1.0);
}
