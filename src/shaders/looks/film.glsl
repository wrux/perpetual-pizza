/** Old projected film: faded sepia, soft focus, gate weave, flicker, scratches, dust and heavy grain. */
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
void main() {
  // Projectors ran at 16 to 18 frames a second; quantise time so the damage judders like that.
  float frame = floor(time * 16.0);

  // Gate weave and a vertical bounce when the sprockets slip.
  vec2 weave = (vec2(hash(vec2(frame, 1.0)), hash(vec2(frame, 2.0))) - 0.5) * 0.006;
  float slip = step(0.96, hash(vec2(frame, 9.0))) * (hash(vec2(frame, 10.0)) - 0.5) * 0.05;
  vec2 uv = vUv + weave + vec2(0.0, slip);
  // Warped frame: the film isn't quite flat in the gate.
  uv += vec2(sin(uv.y * 5.0 + time * 0.7), cos(uv.x * 4.0 + time * 0.5)) * 0.002;

  // Soft focus from an old lens: blend a few offset taps.
  vec3 src = texture2D(tDiffuse, uv).rgb * 0.5;
  for (int i = 0; i < 4; i++) {
    float a = float(i) * 1.5708;
    src += texture2D(tDiffuse, uv + vec2(cos(a), sin(a)) * 0.0035).rgb * 0.125;
  }
  float l = luma(src);

  // Faded contrast with lifted blacks and a sepia cast.
  float tone = smoothstep(-0.05, 1.05, l);
  tone = 0.12 + tone * 0.8;
  vec3 sepia = vec3(1.0, 0.86, 0.66);
  vec3 col = mix(vec3(tone), sepia * tone, 0.75);

  // Flicker: every frame a little different, with occasional heavy dips.
  float flicker = 0.85 + 0.15 * hash(vec2(frame, 3.0)) - step(0.93, hash(vec2(frame, 4.0))) * 0.25;
  col *= flicker;

  // Scratches: long vertical lines that wander, come and go.
  float scratch = 0.0;
  for (int i = 0; i < 3; i++) {
    float seed = float(i) * 7.0;
    float x = hash(vec2(floor(time * 0.5) + seed, 5.0)) + sin(time * (1.5 + seed) + seed) * 0.02;
    float alive = step(0.4, hash(vec2(floor(time * 0.5) + seed, 6.0)));
    float w = 0.0012 + hash(vec2(seed, 7.0)) * 0.001;
    scratch += alive * (1.0 - smoothstep(0.0, w, abs(uv.x - x))) * (0.6 + 0.4 * hash(vec2(frame, seed)));
  }
  col = mix(col, vec3(0.95, 0.9, 0.8), clamp(scratch, 0.0, 1.0) * 0.8);

  // Dust specks and the odd hair caught in the gate.
  float dust = step(0.9985, hash(floor(uv * resolution * 0.2) + frame));
  float hairOn = step(0.9, hash(vec2(frame, 11.0)));
  float hairX = hash(vec2(frame, 12.0));
  float hair = hairOn * (1.0 - smoothstep(0.0, 0.003, abs(uv.x - hairX - sin(uv.y * 30.0 + frame) * 0.01))) * step(0.3, uv.y) * step(uv.y, 0.8);
  col = mix(col, vec3(0.1, 0.08, 0.06), dust * 0.8 + hair * 0.9);

  // Heavy grain, bigger than modern noise.
  float grain = (hash(floor(uv * resolution * 0.45) + fract(time * 23.0) * 100.0) - 0.5) * 0.22;
  col += grain * (0.6 + 0.4 * tone);

  // A light flare rolls through now and then, like a frame catching the lamp.
  float flare = step(0.985, hash(vec2(floor(time * 0.7), 13.0))) * smoothstep(0.6, 0.0, abs(uv.y - fract(time * 2.0)));
  col += vec3(1.0, 0.85, 0.6) * flare * 0.5;

  // Soft, uneven vignette and darker frame edges.
  vec2 d = uv - 0.5;
  float vig = 1.0 - smoothstep(0.25, 0.85, dot(d, d) * 2.2 + noise(uv * 3.0 + time * 0.2) * 0.1);
  col *= mix(0.35, 1.0, vig);

  gl_FragColor = vec4(col, 1.0);
}
