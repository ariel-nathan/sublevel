// Present pass: reads the linear scene target texel-for-texel, encodes sRGB,
// then applies ordered dithering and quantises to a reduced colour depth.
// The canvas is the same size as the scene target; the browser upscales it
// with nearest-neighbour (image-rendering: pixelated).

struct Post {
  // x = levels per channel minus one (31 for 5 bits), y = 1 to dither
  params: vec4f,
}

@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var<uniform> post: Post;

@vertex
fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  // One triangle that covers the viewport.
  let x = f32((index << 1u) & 2u);
  let y = f32(index & 2u);
  return vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}

fn linearToSrgb(c: vec3f) -> vec3f {
  let x = clamp(c, vec3f(0.0), vec3f(1.0));
  let low = x * 12.92;
  let high = 1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055;
  return select(high, low, x <= vec3f(0.0031308));
}

// 4x4 Bayer matrix, thresholds in [0, 1).
fn bayer4(p: vec2u) -> f32 {
  var m = array<f32, 16>(
    0.0, 8.0, 2.0, 10.0,
    12.0, 4.0, 14.0, 6.0,
    3.0, 11.0, 1.0, 9.0,
    15.0, 7.0, 13.0, 5.0,
  );
  return (m[(p.y & 3u) * 4u + (p.x & 3u)] + 0.5) / 16.0;
}

@fragment
fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let p = vec2u(position.xy);
  let linear = textureLoad(scene, vec2i(p), 0).rgb;
  let srgb = linearToSrgb(linear);
  let levels = post.params.x;
  let threshold = select(0.5, bayer4(p), post.params.y > 0.5);
  let quantised = floor(srgb * levels + threshold) / levels;
  return vec4f(clamp(quantised, vec3f(0.0), vec3f(1.0)), 1.0);
}
