/** Kuwahara filter: the frame dissolves into brushy patches of flat colour. */
#include <common>
const int R = 3;
void main() {
  vec2 px = 1.0 / resolution;
  vec3 means[4];
  vec3 sigmas[4];
  float n = float((R + 1) * (R + 1));
  for (int k = 0; k < 4; k++) {
    means[k] = vec3(0.0);
    sigmas[k] = vec3(0.0);
  }
  for (int j = -R; j <= 0; j++) {
    for (int i = -R; i <= 0; i++) {
      vec3 c = texture2D(tDiffuse, vUv + vec2(float(i), float(j)) * px).rgb; means[0] += c; sigmas[0] += c * c;
      c = texture2D(tDiffuse, vUv + vec2(float(-i), float(j)) * px).rgb; means[1] += c; sigmas[1] += c * c;
      c = texture2D(tDiffuse, vUv + vec2(float(i), float(-j)) * px).rgb; means[2] += c; sigmas[2] += c * c;
      c = texture2D(tDiffuse, vUv + vec2(float(-i), float(-j)) * px).rgb; means[3] += c; sigmas[3] += c * c;
    }
  }
  float best = 1e9;
  vec3 col = vec3(0.0);
  for (int k = 0; k < 4; k++) {
    vec3 m = means[k] / n;
    vec3 s = abs(sigmas[k] / n - m * m);
    float v = s.r + s.g + s.b;
    if (v < best) { best = v; col = m; }
  }
  // Canvas weave and a touch more saturation, like wet paint.
  float weave = (noise(vUv * resolution * 0.5) - 0.5) * 0.06;
  float l = luma(col);
  col = mix(vec3(l), col, 1.25) + weave;
  gl_FragColor = vec4(col, 1.0);
}
