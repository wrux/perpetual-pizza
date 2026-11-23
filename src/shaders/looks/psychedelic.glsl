/** Rippling distortion and a rolling rainbow hue shift. Runs on display-ready sRGB. */
uniform sampler2D tDiffuse;
uniform vec2 resolution;
uniform float time;
varying vec2 vUv;

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
  float aspect = resolution.x / resolution.y;
  vec2 centred = (vUv - 0.5) * vec2(aspect, 1.0);
  float dist = length(centred);
  float angle = atan(centred.y, centred.x);

  // Ripples rolling outwards from the centre, plus a slow swirl.
  float ripple = sin(dist * 28.0 - time * 3.0) * 0.012;
  float swirl = sin(angle * 5.0 + time * 1.5) * 0.006;
  vec2 dir = dist > 0.0001 ? centred / dist : vec2(0.0);
  vec2 uv = vUv + (dir * ripple + vec2(-dir.y, dir.x) * swirl) / vec2(aspect, 1.0);

  // Pull each channel from a slightly different ripple phase for fringing.
  float r = texture2D(tDiffuse, uv + dir * 0.004).r;
  float g = texture2D(tDiffuse, uv).g;
  float b = texture2D(tDiffuse, uv - dir * 0.004).b;
  vec3 col = vec3(r, g, b);

  // Rolling rainbow: hue depends on time, brightness and distance from centre.
  vec3 hsv = rgb2hsv(col);
  hsv.x = fract(hsv.x + time * 0.25 + hsv.z * 0.6 - dist * 0.8 + sin(angle * 3.0 + time) * 0.08);
  hsv.y = clamp(hsv.y * 1.6 + 0.35, 0.0, 1.0);
  hsv.z = pow(hsv.z, 0.85);
  col = hsv2rgb(hsv);

  // Contour bands that pulse through the image.
  float bands = 0.85 + 0.15 * sin(hsv.z * 40.0 + dist * 20.0 - time * 4.0);
  gl_FragColor = vec4(col * bands, 1.0);
}
