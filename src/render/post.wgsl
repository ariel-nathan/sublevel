// Present pass: averages each block of the supersampled linear scene target
// down to one output pixel, encodes sRGB, then applies ordered dithering and
// quantises to a reduced colour depth. The browser upscales the canvas by a
// whole factor with nearest-neighbour (image-rendering: pixelated).

struct Post {
  // x = levels per channel minus one (31 for 5 bits), y = 1 to dither,
  // z = 1 to pass the scene colour through untouched (raw debug views),
  // w = supersampling factor (scene texels per output pixel on each axis)
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
  // The scene target is `factor` times larger than the output on each axis.
  let factor = max(1u, u32(post.params.w));
  let origin = p * factor;
  if (post.params.z > 0.5) {
    // Raw debug view: the scene target already holds the final colour. Take
    // one sample so exact values (pure white, pure magenta) are preserved.
    let raw = textureLoad(scene, vec2i(origin), 0).rgb;
    return vec4f(clamp(raw, vec3f(0.0), vec3f(1.0)), 1.0);
  }
  // Average the block in linear light: this is what smooths edges and
  // distant detail.
  var sum = vec3f(0.0);
  for (var y = 0u; y < factor; y++) {
    for (var x = 0u; x < factor; x++) {
      sum += textureLoad(scene, vec2i(origin + vec2u(x, y)), 0).rgb;
    }
  }
  let linear = sum / f32(factor * factor);
  let srgb = linearToSrgb(linear);
  let levels = post.params.x;
  let threshold = select(0.5, bayer4(p), post.params.y > 0.5);
  let quantised = floor(srgb * levels + threshold) / levels;
  return vec4f(clamp(quantised, vec3f(0.0), vec3f(1.0)), 1.0);
}
