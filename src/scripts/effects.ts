import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { RenderPixelatedPass } from 'three/examples/jsm/postprocessing/RenderPixelatedPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

export const EFFECTS = [
  'none',
  'pixelate',
  'retro16',
  'oil',
  'film',
  'vhs',
  'crt',
  'psychedelic',
  'lsd',
] as const;
export type EffectName = (typeof EFFECTS)[number];

export const effectLabels: Record<EffectName, string> = {
  none: 'Default',
  pixelate: 'Pixel',
  retro16: '16-bit',
  oil: 'Oil Painting',
  film: 'Old Film',
  vhs: 'VHS',
  crt: 'CRT',
  psychedelic: 'Psychedelic',
  lsd: 'Acid',
};

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/** Scanlines, colour fringing, tracking wobble and tape noise. Runs on display-ready sRGB. */
const VhsShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    resolution: { value: new THREE.Vector2(1, 1) },
    time: { value: 0 },
  },
  vertexShader: VERTEX,
  fragmentShader: /* glsl */ `
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
  `,
};

/** Old curved CRT: barrel distortion, bezel, phosphor mask, scanlines, fringing, flicker and static. */
const CrtShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    resolution: { value: new THREE.Vector2(1, 1) },
    time: { value: 0 },
  },
  vertexShader: VERTEX,
  fragmentShader: /* glsl */ `
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
  `,
};

/** Rippling distortion and a rolling rainbow hue shift. Runs on display-ready sRGB. */
const PsychedelicShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    resolution: { value: new THREE.Vector2(1, 1) },
    time: { value: 0 },
  },
  vertexShader: VERTEX,
  fragmentShader: /* glsl */ `
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
  `,
};

/** Radial wipe from the previous frame (tPrev) to the live one, soft-edged. */
const TransitionShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tPrev: { value: null as THREE.Texture | null },
    resolution: { value: new THREE.Vector2(1, 1) },
    progress: { value: 1 },
  },
  vertexShader: VERTEX,
  fragmentShader: /* glsl */ `
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
  `,
};

/** A pass that cross-wipes from a stored frame to the live output. Kept across pipeline rebuilds. */
export class TransitionPass extends ShaderPass {
  private start = 0;
  private duration = 700;

  constructor() {
    super(TransitionShader);
    this.enabled = false;
  }

  /** Begin wiping from `previous` to whatever is now being rendered. */
  begin(previous: THREE.Texture, now: number, duration = 700) {
    this.uniforms.tPrev.value = previous;
    this.uniforms.progress.value = 0;
    this.start = now;
    this.duration = duration;
    this.enabled = true;
  }

  get running() {
    return this.enabled;
  }

  /** Advance the wipe; disables itself when finished. */
  tick(now: number) {
    if (!this.enabled) return;
    const t = Math.min((now - this.start) / this.duration, 1);
    this.uniforms.progress.value = t * t * (3 - 2 * t);
    if (t >= 1) this.enabled = false;
  }

  setResolution(w: number, h: number) {
    this.uniforms.resolution.value.set(w, h);
  }
}

/** Liquid melt, breathing, colour cycling and afterimage trails. Keeps its own feedback buffer. */
const LsdShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tEcho: { value: null as THREE.Texture | null },
    resolution: { value: new THREE.Vector2(1, 1) },
    time: { value: 0 },
  },
  vertexShader: VERTEX,
  fragmentShader: /* glsl */ `
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
  `,
};

/** A shader pass that feeds its own previous output back in as tEcho. */
class FeedbackPass extends Pass {
  readonly uniforms = THREE.UniformsUtils.clone(LsdShader.uniforms);
  private readonly material = new THREE.ShaderMaterial({
    uniforms: this.uniforms,
    vertexShader: LsdShader.vertexShader,
    fragmentShader: LsdShader.fragmentShader,
  });
  private readonly quad = new FullScreenQuad(this.material);
  private readonly copyMaterial = new THREE.MeshBasicMaterial({ toneMapped: false });
  private readonly copyQuad = new FullScreenQuad(this.copyMaterial);
  private echoA = new THREE.WebGLRenderTarget(1, 1);
  private echoB = new THREE.WebGLRenderTarget(1, 1);

  setSize(width: number, height: number) {
    this.echoA.setSize(width, height);
    this.echoB.setSize(width, height);
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.tEcho.value = this.echoA.texture;
    // Composite into the spare echo buffer, which becomes next frame's history.
    renderer.setRenderTarget(this.echoB);
    this.quad.render(renderer);
    // Then copy it out.
    this.copyMaterial.map = this.echoB.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.copyQuad.render(renderer);
    [this.echoA, this.echoB] = [this.echoB, this.echoA];
  }

  dispose() {
    this.material.dispose();
    this.copyMaterial.dispose();
    this.quad.dispose();
    this.copyQuad.dispose();
    this.echoA.dispose();
    this.echoB.dispose();
  }
}


/* Shared GLSL helpers pasted into the single-pass looks below. */
const GLSL_COMMON = /* glsl */ `
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
`;

const simpleShader = (body: string) => ({
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    resolution: { value: new THREE.Vector2(1, 1) },
    time: { value: 0 },
  },
  vertexShader: VERTEX,
  fragmentShader: GLSL_COMMON + body,
});

/** Kuwahara filter: the frame dissolves into brushy patches of flat colour. */
const OilShader = simpleShader(/* glsl */ `
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
`);

/** Old projected film: faded sepia, soft focus, gate weave, flicker, scratches, dust and heavy grain. */
const OldFilmShader = simpleShader(/* glsl */ `
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
`);

/** 15-bit colour (32 levels a channel) with a Bayer dither, as the 16-bit consoles drew it. */
const SixteenBitShader = simpleShader(/* glsl */ `
  uniform float pixelSize;
  float bayer(vec2 p) {
    int x = int(mod(p.x, 4.0));
    int y = int(mod(p.y, 4.0));
    int i = x + y * 4;
    float m[16];
    m[0] = 0.0;  m[1] = 8.0;  m[2] = 2.0;  m[3] = 10.0;
    m[4] = 12.0; m[5] = 4.0;  m[6] = 14.0; m[7] = 6.0;
    m[8] = 3.0;  m[9] = 11.0; m[10] = 1.0; m[11] = 9.0;
    m[12] = 15.0; m[13] = 7.0; m[14] = 13.0; m[15] = 5.0;
    for (int k = 0; k < 16; k++) { if (k == i) return m[k] / 16.0; }
    return 0.0;
  }
  void main() {
    vec3 c = texture2D(tDiffuse, vUv).rgb;
    // Punchier colour, like a cartridge palette chosen by hand.
    float l = luma(c);
    c = clamp(mix(vec3(l), c, 1.35) * 1.05, 0.0, 1.0);
    // Dither in screen pixels of the pixelated grid, then snap to 32 levels per channel.
    vec2 cell = floor(vUv * resolution / pixelSize);
    float d = (bayer(cell) - 0.5) / 31.0;
    c = floor((c + d) * 31.0 + 0.5) / 31.0;
    gl_FragColor = vec4(c, 1.0);
  }
`);
SixteenBitShader.uniforms = { ...SixteenBitShader.uniforms, pixelSize: { value: 4 } } as typeof SixteenBitShader.uniforms & { pixelSize: { value: number } };

/** Looks that are one shader over the plain render. */
const singlePassLooks: Partial<Record<EffectName, ReturnType<typeof simpleShader>>> = {
  oil: OilShader,
  film: OldFilmShader,
};

export interface EffectContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  effect: EffectName;
  pixelSize: number;
  /** Passes appended after the look, owned by the caller (not disposed with the pipeline). */
  tail?: Pass[];
  /** Render into this target instead of the canvas (used for thumbnails). */
  target?: THREE.WebGLRenderTarget;
}

export interface EffectPipeline {
  composer: EffectComposer;
  setSize(width: number, height: number): void;
  /** Call once per frame before rendering. */
  tick(elapsed: number): void;
  setPixelSize(size: number): void;
  dispose(): void;
}

export function createPipeline(ctx: EffectContext): EffectPipeline {
  const { renderer, scene, camera, effect } = ctx;
  const composer = new EffectComposer(renderer, ctx.target);
  if (ctx.target) composer.renderToScreen = false;
  const passes: Pass[] = [];
  const add = <T extends Pass>(p: T): T => {
    composer.addPass(p);
    passes.push(p);
    return p;
  };

  const resolutionPasses: Array<{ uniforms: { resolution: { value: THREE.Vector2 } } }> = [];
  let pixelated: RenderPixelatedPass | null = null;
  const timedPasses: Array<{ uniforms: { time: { value: number } } }> = [];

  switch (effect) {
    case 'pixelate':
      pixelated = add(new RenderPixelatedPass(ctx.pixelSize, scene, camera, { normalEdgeStrength: 0.25, depthEdgeStrength: 0.3 }));
      add(new OutputPass());
      break;
    case 'vhs':
      add(new RenderPass(scene, camera));
      add(new OutputPass());
      {
        const vhs = add(new ShaderPass(VhsShader));
        resolutionPasses.push(vhs);
        timedPasses.push(vhs);
      }
      break;
    case 'crt':
      add(new RenderPass(scene, camera));
      add(new OutputPass());
      {
        const crt = add(new ShaderPass(CrtShader));
        resolutionPasses.push(crt);
        timedPasses.push(crt);
      }
      break;
    case 'retro16': {
      // Roughly a 200-line console picture whatever the screen size.
      const height = renderer.getSize(new THREE.Vector2()).y;
      const size = Math.max(2, Math.round(height / 200));
      pixelated = add(new RenderPixelatedPass(size, scene, camera, { normalEdgeStrength: 0, depthEdgeStrength: 0 }));
      add(new OutputPass());
      const p = add(new ShaderPass(SixteenBitShader));
      (p.uniforms.pixelSize as { value: number }).value = size * renderer.getPixelRatio();
      resolutionPasses.push(p);
      break;
    }
    case 'lsd':
      add(new RenderPass(scene, camera));
      add(new OutputPass());
      {
        const lsd = add(new FeedbackPass());
        resolutionPasses.push(lsd);
        timedPasses.push(lsd);
      }
      break;
    case 'psychedelic':
      add(new RenderPass(scene, camera));
      add(new OutputPass());
      {
        const trip = add(new ShaderPass(PsychedelicShader));
        resolutionPasses.push(trip);
        timedPasses.push(trip);
      }
      break;
    default: {
      add(new RenderPass(scene, camera));
      add(new OutputPass());
      const shader = singlePassLooks[effect];
      if (shader) {
        const p = add(new ShaderPass(shader));
        resolutionPasses.push(p);
        timedPasses.push(p);
      }
    }
  }

  ctx.tail?.forEach((p) => composer.addPass(p));

  return {
    composer,
    setSize(w, h) {
      composer.setSize(w, h);
      const pr = renderer.getPixelRatio();
      resolutionPasses.forEach((p) => p.uniforms.resolution.value.set(w * pr, h * pr));
    },
    tick(elapsed) {
      timedPasses.forEach((p) => (p.uniforms.time.value = elapsed));
    },
    setPixelSize(size) {
      pixelated?.setPixelSize(size);
    },
    dispose() {
      passes.forEach((p) => p.dispose?.());
      composer.dispose();
    },
  };
}
