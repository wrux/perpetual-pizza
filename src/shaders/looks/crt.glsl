/** Old curved CRT: barrel distortion, bezel, phosphor mask, scanlines, fringing, flicker and static. */
uniform sampler2D tDiffuse;
uniform vec2 resolution;
uniform float time;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

// Bulge the picture like a curved glass tube.
vec2 curve(vec2 uv) {
  uv = uv * 2.0 - 1.0;
  vec2 off = abs(uv.yx) / vec2(5.0, 4.2);
  uv = uv + uv * off * off;
  return uv * 0.5 + 0.5;
}

void main() {
  vec2 uv = curve(vUv);

  // Vertical roll and horizontal tearing that come and go.
  float rollOn = step(0.92, fract(time * 0.11));
  uv.y = fract(uv.y + rollOn * fract(time * 0.9) * 0.3);
  float tear = step(0.985, hash(vec2(floor(uv.y * 60.0), floor(time * 8.0))));
  uv.x += tear * (hash(vec2(time, uv.y)) - 0.5) * 0.06;
  uv.x += sin(uv.y * 8.0 + time * 1.7) * 0.0015;

  // Colour fringing that grows toward the edges of the tube.
  vec2 centred = uv - 0.5;
  float edge = dot(centred, centred) * 2.0;
  float fringe = 0.0015 + edge * 0.006;
  vec3 col;
  col.r = texture2D(tDiffuse, uv + vec2(fringe, 0.0)).r;
  col.g = texture2D(tDiffuse, uv).g;
  col.b = texture2D(tDiffuse, uv - vec2(fringe, 0.0)).b;

  // Soft halation: bright areas bleed sideways.
  vec3 bleed = texture2D(tDiffuse, uv + vec2(0.006, 0.0)).rgb + texture2D(tDiffuse, uv - vec2(0.006, 0.0)).rgb;
  col += bleed * 0.1;

  // Scanlines and an RGB aperture-grille mask.
  vec2 px = uv * resolution;
  float scan = 0.72 + 0.28 * pow(abs(sin(px.y * 3.14159 * 0.5)), 1.2);
  float cell = mod(floor(px.x / 2.0), 3.0);
  vec3 mask = vec3(cell == 0.0 ? 1.0 : 0.72, cell == 1.0 ? 1.0 : 0.72, cell == 2.0 ? 1.0 : 0.72);
  col *= scan * mask * 1.25;

  // Flicker, a drifting brightness bar, and static.
  float flicker = 0.94 + 0.06 * sin(time * 120.0) * sin(time * 7.3);
  float bar = 1.0 + 0.12 * smoothstep(0.0, 0.1, abs(fract(uv.y * 0.5 - time * 0.07) - 0.5) - 0.4);
  float grain = (hash(px + fract(time) * 100.0) - 0.5) * 0.12;
  col = col * flicker * bar + grain;

  // Phosphor warmth and a bit of green bias like an old tube.
  col = pow(max(col, 0.0), vec3(1.0 / 1.08)) * vec3(1.0, 1.02, 0.94);

  // Rounded screen corners and the dark bezel beyond the glass.
  vec2 q = abs(uv * 2.0 - 1.0);
  float corner = length(max(q - vec2(0.9, 0.9), 0.0)) / 0.1;
  float inside = step(uv.x, 1.0) * step(0.0, uv.x) * step(uv.y, 1.0) * step(0.0, uv.y);
  float glass = inside * (1.0 - smoothstep(0.85, 1.0, corner));
  float vig = 1.0 - smoothstep(0.4, 1.6, edge * 1.6);
  col *= glass * mix(0.45, 1.0, vig);

  // Faint reflection on the glass.
  col += vec3(0.03) * (1.0 - edge) * glass;

  gl_FragColor = vec4(col, 1.0);
}
