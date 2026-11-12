struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
}

@vertex
fn vs(@builtin(vertex_index) index: u32) -> VertexOut {
  var positions = array<vec2f, 3>(vec2f(0.0, 0.6), vec2f(-0.6, -0.6), vec2f(0.6, -0.6));
  var colors = array<vec3f, 3>(vec3f(1.0, 0.5, 0.1), vec3f(0.2, 0.8, 0.3), vec3f(0.2, 0.4, 1.0));
  var out: VertexOut;
  out.position = vec4f(positions[index], 0.0, 1.0);
  out.color = colors[index];
  return out;
}

@fragment
fn fs(in: VertexOut) -> @location(0) vec4f {
  return vec4f(in.color, 1.0);
}
