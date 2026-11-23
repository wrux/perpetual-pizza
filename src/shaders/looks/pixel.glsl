/**
 * Chunky pixels with drawn-in edges: the pizza is rendered small, with each
 * pixel's depth and facing kept, and outlines are found where those jump.
 * `resolution` is the small picture's size, then one pixel of it in uv.
 */
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform vec4 resolution;
varying vec2 vUv;

float depthAt(int x, int y) { return texture2D(tDepth, vUv + vec2(x, y) * resolution.zw).r; }
vec3 normalAt(int x, int y) { return texture2D(tNormal, vUv + vec2(x, y) * resolution.zw).rgb * 2.0 - 1.0; }

// A step down in depth to a neighbour: the silhouette of something in front.
float depthEdge(float depth) {
  float diff = 0.0;
  diff += clamp(depthAt(1, 0) - depth, 0.0, 1.0);
  diff += clamp(depthAt(-1, 0) - depth, 0.0, 1.0);
  diff += clamp(depthAt(0, 1) - depth, 0.0, 1.0);
  diff += clamp(depthAt(0, -1) - depth, 0.0, 1.0);
  return floor(smoothstep(0.01, 0.02, diff) * 2.0) / 2.0;
}

// A crease: the neighbour faces another way. Only one side of each crease is marked.
float crease(int x, int y, float depth, vec3 normal) {
  float depthDiff = depthAt(x, y) - depth;
  vec3 other = normalAt(x, y);
  float facing = clamp(smoothstep(-0.01, 0.01, dot(normal - other, vec3(1.0))), 0.0, 1.0);
  float nearer = clamp(sign(depthDiff * 0.25 + 0.0025), 0.0, 1.0);
  return (1.0 - dot(normal, other)) * nearer * facing;
}

void main() {
  vec4 texel = texture2D(tDiffuse, vUv);
  float depth = depthAt(0, 0);
  vec3 normal = normalAt(0, 0);
  float outline = depthEdge(depth);
  float creases = step(0.1, crease(0, -1, depth, normal) + crease(0, 1, depth, normal) + crease(-1, 0, depth, normal) + crease(1, 0, depth, normal));
  // Silhouettes darken, creases catch the light. The amounts are for linear
  // light; the picture is already encoded for the screen, hence the power.
  gl_FragColor = texel * pow(outline > 0.0 ? 1.0 - 0.3 * outline : 1.0 + 0.25 * creases, 0.45);
}
