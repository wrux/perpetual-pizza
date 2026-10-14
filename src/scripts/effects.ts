import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { RenderPixelatedPass } from 'three/examples/jsm/postprocessing/RenderPixelatedPass.js';
import { HalftonePass } from 'three/examples/jsm/postprocessing/HalftonePass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import type { Pass } from 'three/examples/jsm/postprocessing/Pass.js';

export const EFFECTS = ['none', 'pixelate', 'cartoon', 'halftone', 'gameboy', 'vhs', 'psychedelic'] as const;
export type EffectName = (typeof EFFECTS)[number];

export const effectLabels: Record<EffectName, string> = {
  none: 'Realistic',
  pixelate: 'Pixelated',
  cartoon: 'Cartoon',
  halftone: 'Halftone print',
  gameboy: 'Game Boy',
  vhs: 'VHS tape',
  psychedelic: 'Psychedelic',
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

/** Four-shade green palette with an ordered dither. Runs on display-ready sRGB. */
const GameboyShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    resolution: { value: new THREE.Vector2(1, 1) },
    pixelSize: { value: 6 },
  },
  vertexShader: VERTEX,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float pixelSize;
    varying vec2 vUv;

    const vec3 c0 = vec3(0.059, 0.220, 0.059);
    const vec3 c1 = vec3(0.188, 0.384, 0.188);
    const vec3 c2 = vec3(0.545, 0.675, 0.059);
    const vec3 c3 = vec3(0.608, 0.737, 0.059);

    float bayer(vec2 p) {
      // 4x4 Bayer matrix, values 0..15.
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
      float lum = dot(c, vec3(0.299, 0.587, 0.114));
      // Lift the midtones a bit so the pizza isn't mostly dark green.
      lum = pow(lum, 0.8);
      vec2 cell = floor(vUv * resolution / pixelSize);
      float d = (bayer(cell) - 0.5) / 3.0;
      float v = clamp(lum + d, 0.0, 0.999) * 4.0;
      vec3 col = v < 1.0 ? c0 : v < 2.0 ? c1 : v < 3.0 ? c2 : c3;
      gl_FragColor = vec4(col, 1.0);
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

export interface EffectContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  effect: EffectName;
  pixelSize: number;
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
  const composer = new EffectComposer(renderer);
  const passes: Pass[] = [];
  const add = <T extends Pass>(p: T): T => {
    composer.addPass(p);
    passes.push(p);
    return p;
  };

  const resolutionPasses: ShaderPass[] = [];
  let pixelated: RenderPixelatedPass | null = null;
  let halftone: HalftonePass | null = null;
  const timedPasses: ShaderPass[] = [];
  let gameboy: ShaderPass | null = null;

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
    case 'halftone':
      add(new RenderPass(scene, camera));
      add(new OutputPass());
      halftone = add(
        new HalftonePass({
          shape: 1,
          radius: 7 * renderer.getPixelRatio(),
          scatter: 0,
          blending: 0.85,
          blendingMode: 1,
          greyscale: false,
        }),
      );
      break;
    case 'gameboy':
      pixelated = add(new RenderPixelatedPass(ctx.pixelSize, scene, camera, { normalEdgeStrength: 0, depthEdgeStrength: 0 }));
      add(new OutputPass());
      gameboy = add(new ShaderPass(GameboyShader));
      gameboy.uniforms.pixelSize.value = ctx.pixelSize;
      resolutionPasses.push(gameboy);
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

  return {
    composer,
    setSize(w, h) {
      composer.setSize(w, h);
      const pr = renderer.getPixelRatio();
      resolutionPasses.forEach((p) => p.uniforms.resolution.value.set(w * pr, h * pr));
      halftone?.setSize(w * pr, h * pr);
    },
    tick(elapsed) {
      timedPasses.forEach((p) => (p.uniforms.time.value = elapsed));
    },
    setPixelSize(size) {
      pixelated?.setPixelSize(size);
      if (gameboy) gameboy.uniforms.pixelSize.value = size;
    },
    dispose() {
      passes.forEach((p) => p.dispose?.());
      composer.dispose();
    },
  };
}
