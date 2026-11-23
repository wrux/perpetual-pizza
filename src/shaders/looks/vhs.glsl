/** Scanlines, colour fringing, tracking wobble and tape noise. Runs on display-ready sRGB. */
uniform sampler2D tDiffuse;
uniform vec2 resolution;
uniform float time;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec2 uv = vUv;

  // Horizontal jitter, stronger in a tracking band that rolls up the screen.
  float band = smoothstep(0.0, 0.08, abs(fract(uv.y + time * 0.07) - 0.5) - 0.42);
  float jitter = (hash(vec2(floor(uv.y * resolution.y * 0.5), floor(time * 24.0))) - 0.5) * 0.004;
  uv.x += jitter + band * (hash(vec2(time, uv.y)) - 0.5) * 0.03;
  uv.x += sin(uv.y * 30.0 + time * 2.0) * 0.0008;

  // Colour fringing.
  float fringe = 0.0022 + band * 0.006;
  float r = texture2D(tDiffuse, uv + vec2(fringe, 0.0)).r;
  float g = texture2D(tDiffuse, uv).g;
  float b = texture2D(tDiffuse, uv - vec2(fringe, 0.0)).b;
  vec3 col = vec3(r, g, b);

  // Soft bloom-ish bleed to the right, like a worn tape.
  col += texture2D(tDiffuse, uv + vec2(0.004, 0.0)).rgb * 0.12;
  col = col / 1.12;

  // Scanlines + grain.
  float scan = 0.88 + 0.12 * sin(uv.y * resolution.y * 3.14159);
  float grain = (hash(uv * resolution + fract(time) * 100.0) - 0.5) * 0.09;
  col = col * scan + grain;

  // Slight desaturation and warmth, plus a vignette.
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(lum), col, 0.8) * vec3(1.03, 1.0, 0.96);
  float vig = smoothstep(0.95, 0.35, distance(uv, vec2(0.5)));
  col *= mix(0.75, 1.0, vig);

  gl_FragColor = vec4(col, 1.0);
}
