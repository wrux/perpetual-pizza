/** Helpers shared by the single-pass looks. */
uniform sampler2D tDiffuse;
uniform vec2 resolution;
uniform float time;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float sobel(vec2 uv, vec2 px) {
  float tl = luma(texture2D(tDiffuse, uv + px * vec2(-1.0,  1.0)).rgb);
  float t  = luma(texture2D(tDiffuse, uv + px * vec2( 0.0,  1.0)).rgb);
  float tr = luma(texture2D(tDiffuse, uv + px * vec2( 1.0,  1.0)).rgb);
  float l  = luma(texture2D(tDiffuse, uv + px * vec2(-1.0,  0.0)).rgb);
  float r  = luma(texture2D(tDiffuse, uv + px * vec2( 1.0,  0.0)).rgb);
  float bl = luma(texture2D(tDiffuse, uv + px * vec2(-1.0, -1.0)).rgb);
  float b  = luma(texture2D(tDiffuse, uv + px * vec2( 0.0, -1.0)).rgb);
  float br = luma(texture2D(tDiffuse, uv + px * vec2( 1.0, -1.0)).rgb);
  float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;
  float gy = -tl - 2.0 * t - tr + bl + 2.0 * b + br;
  return sqrt(gx * gx + gy * gy);
}
