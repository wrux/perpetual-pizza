/** Liquid melt, breathing, colour cycling and afterimage trails. Keeps its own feedback buffer. */
uniform sampler2D tDiffuse;
uniform sampler2D tEcho;
uniform vec2 resolution;
uniform float time;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
  float t = time;
  vec2 c = vUv - 0.5;

  // Everything melts: layered sine warps that drift in different directions.
  vec2 melt = vec2(
    sin(vUv.y * 6.0 + t * 1.3) + 0.5 * sin(vUv.y * 13.0 - t * 0.7) + 0.3 * sin(vUv.x * 9.0 + t * 0.5),
    cos(vUv.x * 7.0 + t * 1.1) + 0.5 * sin(vUv.x * 11.0 + t * 0.9) + 0.3 * cos(vUv.y * 8.0 - t * 0.6)
  ) * 0.014;
  // The picture breathes.
  float breathe = 1.0 + 0.06 * sin(t * 1.7);
  vec2 uv = c * breathe + 0.5 + melt;

  // Colour planes drift apart and circle each other.
  vec2 sep = vec2(cos(t * 0.8), sin(t * 0.8)) * 0.007;
  vec3 col;
  col.r = texture2D(tDiffuse, uv + sep).r;
  col.g = texture2D(tDiffuse, uv).g;
  col.b = texture2D(tDiffuse, uv - sep).b;

  // Oversaturate and roll the hue outward from the centre.
  vec3 hsv = rgb2hsv(col);
  hsv.x = fract(hsv.x + t * 0.1 + length(c) * 0.6 + hsv.z * 0.25);
  hsv.y = clamp(hsv.y * 1.9 + 0.25, 0.0, 1.0);
  col = hsv2rgb(hsv);

  // Afterimages: the previous frame, slightly zoomed and twisted, lingers.
  float a = 0.012 * sin(t * 0.5);
  mat2 rot = mat2(cos(a), -sin(a), sin(a), cos(a));
  vec2 e = rot * c * 0.985 + 0.5;
  vec3 echo = texture2D(tEcho, e).rgb;
  col = mix(col, max(col, echo * 0.94), 0.72);

  // Sparkle.
  float spark = step(0.996, hash(floor(vUv * resolution * 0.25) + floor(t * 8.0)));
  col += spark * 0.8;

  gl_FragColor = vec4(col, 1.0);
}
