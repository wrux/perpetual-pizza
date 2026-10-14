import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { RenderPixelatedPass } from 'three/examples/jsm/postprocessing/RenderPixelatedPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

export const EFFECTS = ['none', 'pixelate', 'cartoon', 'kaleidoscope', 'neon', 'vhs', 'crt', 'psychedelic', 'lsd'] as const;
export type EffectName = (typeof EFFECTS)[number];

export const effectLabels: Record<EffectName, string> = {
  none: 'Realistic',
  pixelate: 'Pixelated',
  cartoon: 'Cartoon',
  kaleidoscope: 'Kaleidoscope',
  neon: 'Neon sign',
  vhs: 'VHS tape',
  crt: 'CRT monitor',
  psychedelic: 'Psychedelic',
  lsd: 'LSD',
};

/** Effects that want the pizza itself drawn with flat toon shading. */
export const usesToonMaterials = (effect: EffectName) => effect === 'cartoon';

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/** Posterised colour with dark ink outlines from a Sobel edge detect. Runs on display-ready sRGB. */
const CartoonShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    resolution: { value: new THREE.Vector2(1, 1) },
    levels: { value: 5 },
    edge: { value: 0.7 },
  },
  vertexShader: VERTEX,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float levels;
    uniform float edge;
    varying vec2 vUv;

    float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
    float sampleLuma(vec2 offset) { return luma(texture2D(tDiffuse, vUv + offset / resolution).rgb); }

    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;

      float tl = sampleLuma(vec2(-1.0,  1.0));
      float t  = sampleLuma(vec2( 0.0,  1.0));
      float tr = sampleLuma(vec2( 1.0,  1.0));
      float l  = sampleLuma(vec2(-1.0,  0.0));
      float r  = sampleLuma(vec2( 1.0,  0.0));
      float bl = sampleLuma(vec2(-1.0, -1.0));
      float b  = sampleLuma(vec2( 0.0, -1.0));
      float br = sampleLuma(vec2( 1.0, -1.0));
      float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;
      float gy = -tl - 2.0 * t - tr + bl + 2.0 * b + br;
      float g = sqrt(gx * gx + gy * gy);

      // Quantise brightness but keep the hue.
      float lum = luma(c);
      float q = (floor(lum * levels) + 0.5) / levels;
      vec3 toned = c * (q / max(lum, 1e-4));
      toned = clamp(toned * 1.08, 0.0, 1.0);

      vec3 ink = vec3(0.08, 0.03, 0.02);
      float line = smoothstep(edge * 0.6, edge, g);
      gl_FragColor = vec4(mix(toned, ink, line), 1.0);
    }
  `,
};

/** Mirrors the picture into a slowly turning mandala around the centre. Runs on display-ready sRGB. */
const KaleidoscopeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    resolution: { value: new THREE.Vector2(1, 1) },
    time: { value: 0 },
    segments: { value: 8 },
  },
  vertexShader: VERTEX,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float time;
    uniform float segments;
    varying vec2 vUv;

    void main() {
      float aspect = resolution.x / resolution.y;
      vec2 c = (vUv - 0.5) * vec2(aspect, 1.0);
      float r = length(c);
      float a = atan(c.y, c.x) + time * 0.15;

      // Fold the angle into one wedge and mirror every other wedge.
      float wedge = 6.28318 / segments;
      a = mod(a, wedge);
      a = abs(a - wedge * 0.5);

      // Gently breathe the radius so the pattern keeps shifting.
      r *= 0.9 + 0.08 * sin(time * 0.7);
      vec2 uv = vec2(cos(a), sin(a)) * r / vec2(aspect, 1.0) + 0.5;
      // Keep samples on screen: mirror at the edges.
      uv = abs(uv);
      uv = 1.0 - abs(1.0 - uv);

      vec3 col = texture2D(tDiffuse, uv).rgb;
      // A soft seam highlight gives the facets a cut-glass feel.
      float seam = smoothstep(0.03, 0.0, abs(a - wedge * 0.5)) * 0.12 + smoothstep(0.02, 0.0, a) * 0.12;
      gl_FragColor = vec4(col + seam, 1.0);
    }
  `,
};

/** Neon sign: edges traced in glowing colour on a dark background, with bloom and flicker. */
const NeonShader = {
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

    float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

    // Edge strength at a point, from a Sobel on brightness.
    float edgeAt(vec2 uv, vec2 px) {
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

    vec3 tubeColour(vec3 c) {
      // Push the source colour to a saturated neon: reds go magenta-pink, pale cheese goes cyan, greens go lime.
      float lum = luma(c);
      vec3 pink = vec3(1.0, 0.2, 0.75);
      vec3 cyan = vec3(0.2, 0.95, 1.0);
      vec3 lime = vec3(0.6, 1.0, 0.25);
      float redness = clamp((c.r - c.g) * 2.0, 0.0, 1.0);
      float greenness = clamp((c.g - c.r) * 2.0, 0.0, 1.0);
      vec3 col = mix(cyan, pink, redness);
      col = mix(col, lime, greenness);
      return mix(col, vec3(1.0), smoothstep(0.85, 1.0, lum) * 0.3);
    }

    void main() {
      vec2 px = 1.5 / resolution;
      vec3 src = texture2D(tDiffuse, vUv).rgb;
      float edge = smoothstep(0.18, 0.6, edgeAt(vUv, px));

      // Wider, dimmer samples give the glow around each tube.
      float glow = 0.0;
      for (int i = 1; i <= 4; i++) {
        float d = float(i) * 2.5;
        glow += edgeAt(vUv + vec2( d, 0.0) / resolution, px);
        glow += edgeAt(vUv + vec2(-d, 0.0) / resolution, px);
        glow += edgeAt(vUv + vec2(0.0,  d) / resolution, px);
        glow += edgeAt(vUv + vec2(0.0, -d) / resolution, px);
      }
      glow = smoothstep(0.3, 2.5, glow);

      vec3 tube = tubeColour(src);
      // Mains hum: a barely-there flicker, plus the odd stutter.
      float flicker = 0.93 + 0.07 * sin(time * 60.0) * sin(time * 3.1) + 0.05 * step(0.985, fract(sin(floor(time * 12.0)) * 43758.5));

      vec3 col = vec3(0.02, 0.01, 0.05);
      col += tube * glow * 0.45;
      col += mix(tube, vec3(1.0), 0.35) * edge * 1.4;
      // The unlit pizza shows faintly, like a dark wall behind the sign.
      col += src * 0.06;
      gl_FragColor = vec4(col * flicker, 1.0);
    }
  `,
};

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
    case 'cartoon': {
      add(new RenderPass(scene, camera));
      add(new OutputPass());
      resolutionPasses.push(add(new ShaderPass(CartoonShader)));
      break;
    }
    case 'kaleidoscope':
      add(new RenderPass(scene, camera));
      add(new OutputPass());
      {
        const k = add(new ShaderPass(KaleidoscopeShader));
        resolutionPasses.push(k);
        timedPasses.push(k);
      }
      break;
    case 'neon':
      add(new RenderPass(scene, camera));
      add(new OutputPass());
      {
        const neon = add(new ShaderPass(NeonShader));
        resolutionPasses.push(neon);
        timedPasses.push(neon);
      }
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
    default:
      add(new RenderPass(scene, camera));
      add(new OutputPass());
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
