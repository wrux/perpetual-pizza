/** Radial wipe from the previous frame (tPrev) to the live one, soft-edged. */
uniform sampler2D tDiffuse;
uniform sampler2D tPrev;
uniform vec2 resolution;
uniform float progress;
varying vec2 vUv;

void main() {
  vec4 next = texture2D(tDiffuse, vUv);
  vec4 prev = texture2D(tPrev, vUv);
  float aspect = resolution.x / resolution.y;
  vec2 c = (vUv - 0.5) * vec2(aspect, 1.0);
  // 0 at the centre, 1 in the corners.
  float d = length(c) / (0.5 * length(vec2(aspect, 1.0)));
  // The new look grows out of the centre, where the zoom comes from.
  float front = progress * 1.3;
  float wipe = smoothstep(front - 0.35, front, d);
  // A faint bright ring on the wipe front.
  float ring = (1.0 - smoothstep(0.0, 0.08, abs(d - front + 0.15))) * (1.0 - progress) * 0.18;
  gl_FragColor = mix(next, prev, wipe) + vec4(ring);
}
