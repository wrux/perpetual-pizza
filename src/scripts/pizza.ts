import * as THREE from 'three';
import { createPipeline, EFFECTS, TransitionPass, type EffectName, type EffectPipeline } from './effects';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/**
 * Perpetual pizza: a pizza whose centre is a smaller pizza, whose centre is a
 * smaller pizza... The camera zooms in forever. Every level is an identical
 * clone, so once one level has grown to the size its parent started at we can
 * silently reset and nobody can tell.
 */

export interface ToppingCounts {
  pepperoni: number;
  mushroom: number;
  basil: number;
  olive: number;
  jalapeno: number;
  ham: number;
}

export interface PizzaConfig {
  /** Seconds for one level to zoom into the next. Lower = faster. */
  cycleSeconds: number;
  /** Rotation of the whole stack, in turns per cycle. */
  spinTurns: number;
  /** Extra turns each nested level makes relative to its parent per cycle. Integers keep the loop seamless. */
  innerSpinTurns: number;
  /** Size of the inner pizza relative to its parent. */
  ratio: number;
  /** How many nested levels to render. */
  levels: number;
  /** Seed for topping placement and texture noise. */
  seed: number;
  toppings: ToppingCounts;
  shadows: boolean;
  /** Zoom in (1) or out (-1). */
  direction: 1 | -1;
  /** Camera elevation above the pizza, in degrees. 90 looks straight down. */
  elevation: number;
  /** Camera field of view, in degrees. */
  fov: number;
  /** Post-processing look. */
  effect: EffectName;
  /** Pixel block size for the pixelated looks. */
  pixelSize: number;
}

export const defaultConfig: PizzaConfig = {
  cycleSeconds: 7 / 3.35,
  spinTurns: -0.4,
  innerSpinTurns: 0,
  ratio: 0.2,
  levels: 6,
  seed: 7,
  toppings: { pepperoni: 27, mushroom: 10, basil: 5, olive: 14, jalapeno: 0, ham: 0 },
  shadows: true,
  direction: 1,
  elevation: 41,
  fov: 42,
  effect: 'none',
  pixelSize: 6,
};

/** Start-up progress: a human caption and a 0..1 fraction. */
export type ProgressCallback = (caption: string, fraction: number) => void;

export interface Previews {
  looks: Record<EffectName, string>;
  toppings: Record<keyof ToppingCounts, string>;
}

export interface PizzaController {
  config: PizzaConfig;
  update(patch: Partial<PizzaConfig>): void;
  /** Render small PNG data URLs of every look and every topping, for the options panel. */
  renderPreviews(size?: number): Promise<Previews>;
  dispose(): void;
}

/* ------------------------------------------------------------------ */
/* Random + noise                                                      */
/* ------------------------------------------------------------------ */

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable 2D value noise with fractal sum. `period` is in noise units. */
function makeNoise(seed: number, period = 256) {
  const table = new Float32Array(period * period);
  const rng = mulberry32(seed);
  for (let i = 0; i < table.length; i++) table[i] = rng();
  const at = (x: number, y: number) =>
    table[(((y % period) + period) % period) * period + (((x % period) + period) % period)];
  const smooth = (t: number) => t * t * (3 - 2 * t);

  const noise = (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const tx = smooth(x - xi);
    const ty = smooth(y - yi);
    const a = at(xi, yi);
    const b = at(xi + 1, yi);
    const c = at(xi, yi + 1);
    const d = at(xi + 1, yi + 1);
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };

  const fbm = (x: number, y: number, octaves = 5, gain = 0.5) => {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let f = 1;
    for (let i = 0; i < octaves; i++) {
      sum += noise(x * f, y * f) * amp;
      norm += amp;
      amp *= gain;
      f *= 2;
    }
    return sum / norm;
  };

  return { noise, fbm };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

/** Per-pixel painter producing a colour map plus height and roughness maps. */
function paint(
  w: number,
  h: number,
  shade: (u: number, v: number) => { color: Rgb; height?: number; rough?: number },
) {
  const mk = () => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  };
  const colorC = mk();
  const heightC = mk();
  const roughC = mk();
  const color = colorC.getContext('2d')!.createImageData(w, h);
  const height = heightC.getContext('2d')!.createImageData(w, h);
  const rough = roughC.getContext('2d')!.createImageData(w, h);
  const heightData = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const s = shade(x / w, y / h);
      color.data[i] = s.color[0];
      color.data[i + 1] = s.color[1];
      color.data[i + 2] = s.color[2];
      color.data[i + 3] = 255;
      heightData[y * w + x] = clamp01(s.height ?? 0.5);
      const hv = Math.round(clamp01(s.height ?? 0.5) * 255);
      height.data[i] = height.data[i + 1] = height.data[i + 2] = hv;
      height.data[i + 3] = 255;
      const rv = Math.round(clamp01(s.rough ?? 0.5) * 255);
      rough.data[i] = rough.data[i + 1] = rough.data[i + 2] = rv;
      rough.data[i + 3] = 255;
    }
  }
  colorC.getContext('2d')!.putImageData(color, 0, 0);
  heightC.getContext('2d')!.putImageData(height, 0, 0);
  roughC.getContext('2d')!.putImageData(rough, 0, 0);

  const tex = (c: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(c);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    return t;
  };
  return {
    map: tex(colorC, true),
    bumpMap: tex(heightC, false),
    roughnessMap: tex(roughC, false),
    heightData,
    width: w,
    height: h,
  };
}

/* ------------------------------------------------------------------ */
/* Textures                                                            */
/* ------------------------------------------------------------------ */

const SAUCE = rgb('#bb3a1f');
const SAUCE_DARK = rgb('#8a2412');
const CHEESE_WHITE = rgb('#f5dd98');
const CHEESE_YELLOW = rgb('#e6ad35');
const CHEESE_THIN = rgb('#eaa84a');
const CHEESE_TOAST = rgb('#c27425');
const CHEESE_CHAR = rgb('#6b3210');
const HERB = rgb('#4b6b25');

/** Planar top-of-pizza texture: mozzarella bubbling over tomato sauce. */
function cheeseTexture(seed: number) {
  const n = makeNoise(seed);
  const n2 = makeNoise(seed + 11);
  return paint(1024, 1024, (u, v) => {
    const x = u * 9;
    const y = v * 9;
    // Distance from centre 0..1 (the ring spans the texture square).
    const r = Math.hypot(u - 0.5, v - 0.5) * 2;

    // Domain-warped coverage so the melt edges are organic rather than blobby.
    const warp = n.fbm(x * 1.2 + 3, y * 1.2 + 7, 2, 0.5) - 0.5;
    const coverageNoise = n.fbm(x + warp * 0.9, y + warp * 0.9, 5, 0.5);
    // Thinner near the crust so the sauce shows through.
    const threshold = 0.34 + smoothstep(0.8, 1, r) * 0.1;
    const cheese = smoothstep(threshold - 0.06, threshold + 0.04, coverageNoise);
    const thin = smoothstep(threshold - 0.06, threshold + 0.16, coverageNoise); // 1 = thick cheese

    // Lumps and fine grain inside the cheese.
    const lumps = n2.fbm(x * 2.6, y * 2.6, 4, 0.5);
    const grain = n2.fbm(x * 18 + 11, y * 18 + 4, 3, 0.5);

    // Browning where the cheese is thick and lumps are high.
    const toastNoise = n2.fbm(x * 1.8 + 21, y * 1.8 + 13, 3, 0.5);
    const toast = smoothstep(0.45, 0.68, toastNoise) * smoothstep(0.4, 0.65, lumps) * thin;
    const char = smoothstep(0.62, 0.76, toastNoise) * smoothstep(0.55, 0.72, lumps) * thin;

    // Thin cheese goes translucent and shows the sauce as orange.
    let cheeseColor = mixRgb(CHEESE_WHITE, CHEESE_YELLOW, smoothstep(0.25, 0.75, lumps) * 0.8 + grain * 0.2);
    cheeseColor = mixRgb(cheeseColor, CHEESE_THIN, (1 - thin) * 0.8);
    cheeseColor = mixRgb(cheeseColor, CHEESE_TOAST, toast * 0.75);
    cheeseColor = mixRgb(cheeseColor, CHEESE_CHAR, char * 0.6);

    const sauceColor = mixRgb(SAUCE, SAUCE_DARK, smoothstep(0.35, 0.7, n2.fbm(x * 2 + 5, y * 2 + 5, 3)));

    let color = mixRgb(sauceColor, cheeseColor, cheese);

    // Sparse oregano flecks.
    const fleck = n2.noise(x * 60, y * 60);
    if (fleck > 0.965) color = mixRgb(color, HERB, 0.8);

    const height = cheese * (0.3 + thin * 0.25 + lumps * 0.3 + grain * 0.15) + (1 - cheese) * (0.12 + grain * 0.08);
    const rough = mix(0.72, 0.3, cheese) + toast * 0.12 - thin * 0.06;
    return { color, height, rough };
  });
}

const CRUST_BASE = rgb('#c07f3c');
const CRUST_LIGHT = rgb('#dfb26f');
const CRUST_DARK = rgb('#8f4f1e');
const CRUST_CHAR = rgb('#3e2009');

/** Torus-mapped crust: u around the ring, v around the tube (0.5 = top). */
function crustTexture(seed: number) {
  const n = makeNoise(seed + 23, 256);
  return paint(2048, 256, (u, v) => {
    const x = u * 64; // periodic along u: 64 noise cells divide the 256 table
    const y = v * 6;
    const base = n.fbm(x, y, 4, 0.5);
    const blisters = n.fbm(x * 3, y * 3, 3, 0.5);
    // Leopard spotting, mostly on the top of the crust.
    const topness = 1 - Math.abs(v - 0.5) * 2;
    const spots = smoothstep(0.56, 0.68, blisters) * smoothstep(0.1, 0.6, topness);
    const char = smoothstep(0.68, 0.78, blisters) * smoothstep(0.2, 0.7, topness);

    let color = mixRgb(CRUST_BASE, CRUST_LIGHT, smoothstep(0.35, 0.7, base));
    color = mixRgb(color, CRUST_DARK, spots * 0.85);
    color = mixRgb(color, CRUST_CHAR, char * 0.8);
    // Paler, floury underside.
    color = mixRgb(color, CRUST_LIGHT, smoothstep(0.75, 1, Math.abs(v - 0.5) * 2) * 0.3);

    const height = 0.4 + blisters * 0.5 + base * 0.1;
    const rough = 0.75 - spots * 0.25;
    return { color, height, rough };
  });
}

const PEP_BASE = rgb('#c43b2a');
const PEP_DARK = rgb('#8a1c14');
const PEP_FAT = rgb('#d4705c');
const PEP_CHAR = rgb('#3d0f0b');

/** Lathe-mapped pepperoni: u around, v from centre (0) to rim (0.5) to underside (1). */
function pepperoniTexture(seed: number) {
  const n = makeNoise(seed + 37, 128);
  return paint(512, 256, (u, v) => {
    // Sample noise in slice space so the marbling is isotropic, not radial streaks.
    const rad = Math.min(v, 1 - v) * 2; // 0 centre .. 1 rim, mirrored underneath
    const px = 16 + Math.cos(u * Math.PI * 2) * rad * 6;
    const py = 16 + Math.sin(u * Math.PI * 2) * rad * 6;
    const marble = n.fbm(px, py, 4, 0.55);
    const fat = smoothstep(0.6, 0.7, n.fbm(px * 2.2 + 40, py * 2.2 + 9, 3));
    const rim = smoothstep(0.78, 1, rad);
    let color = mixRgb(PEP_BASE, PEP_DARK, smoothstep(0.35, 0.75, marble) * 0.8);
    color = mixRgb(color, PEP_FAT, fat * 0.6);
    color = mixRgb(color, PEP_CHAR, rim * 0.75 + smoothstep(0.8, 0.92, marble) * 0.4);
    return { color, height: 0.5 + marble * 0.3 - fat * 0.15, rough: 0.28 + fat * 0.1 + rim * 0.25 };
  });
}


/** Planar bounds of an extruded topping, shared by its UV map and its painter. */
interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Shape-space point for a canvas pixel (canvas rows run top-down, so v = 0 is maxY). */
const shapePoint = (b: Bounds, u: number, v: number) => ({
  x: b.minX + u * (b.maxX - b.minX),
  y: b.maxY - v * (b.maxY - b.minY),
});

const MUSH_W = 0.06;
const MUSH_BOUNDS: Bounds = { minX: -0.064, maxX: 0.064, minY: -0.062, maxY: 0.074 };

const MUSH_FLESH = rgb('#ead9b8');
const MUSH_SKIN = rgb('#a87a4c');
const MUSH_RIM = rgb('#6b4728');
const MUSH_GILL = rgb('#5c3c21');
const MUSH_GILL_DARK = rgb('#3a2412');
const MUSH_STEM = rgb('#f0e4cb');

/** Face of a mushroom slice: pale cap with a brown skin, dark gills, fibrous stem. */
function mushroomTexture(seed: number) {
  const n = makeNoise(seed + 53, 128);
  return paint(512, 512, (u, v) => {
    const { x, y } = shapePoint(MUSH_BOUNDS, u, v);
    const grain = n.fbm(x * 90 + 3, y * 90 + 7, 3, 0.5);
    const blotch = n.fbm(x * 25 + 11, y * 25 + 2, 3, 0.5);

    // Cap: upper half-ellipse. Gill line curves under it.
    const capR = Math.sqrt((x / MUSH_W) ** 2 + (y / 0.07) ** 2);
    const gillY = 0.004 - 0.016 * (1 - Math.min((x / MUSH_W) ** 2, 1));
    const inGills = y < gillY + 0.009 && y > gillY - 0.006;

    let color: Rgb;
    let height: number;
    let rough: number;
    if (y >= gillY + 0.009 || (y >= 0 && capR <= 1.02)) {
      // Cap flesh, browning toward the skin at the edge.
      const edge = smoothstep(0.78, 1, capR);
      const rim = smoothstep(0.93, 1, capR);
      color = mixRgb(MUSH_FLESH, rgb('#d9c39a'), smoothstep(0.35, 0.7, grain));
      color = mixRgb(color, MUSH_SKIN, edge * 0.85 + smoothstep(0.6, 0.75, blotch) * 0.3);
      color = mixRgb(color, MUSH_RIM, rim * 0.8);
      height = 0.55 + grain * 0.1 - edge * 0.25;
      rough = 0.7 - edge * 0.1;
    } else if (inGills) {
      // Gills radiate from the cap centre.
      const ang = Math.atan2(y - 0.03, x);
      const line = Math.abs(Math.sin(ang * 60));
      color = mixRgb(MUSH_GILL, MUSH_GILL_DARK, smoothstep(0.5, 0.95, line) * 0.8 + grain * 0.2);
      height = 0.3 + (1 - line) * 0.1;
      rough = 0.9;
    } else {
      // Stem: vertical fibres.
      const fibre = n.fbm(x * 160 + 9, y * 12 + 4, 3, 0.5);
      color = mixRgb(MUSH_STEM, rgb('#d4c2a0'), smoothstep(0.35, 0.7, fibre));
      color = mixRgb(color, MUSH_SKIN, smoothstep(0.7, 0.85, blotch) * 0.25);
      height = 0.5 + fibre * 0.12;
      rough = 0.72;
    }
    return { color, height, rough };
  });
}

const BASIL_BOUNDS: Bounds = { minX: -0.066, maxX: 0.066, minY: -0.071, maxY: 0.076 };
const BASIL_DARK = rgb('#285a20');
const BASIL_LIGHT = rgb('#4f8f36');
const BASIL_VEIN = rgb('#a9d47e');
const BASIL_VEIN_SOFT = rgb('#7fb35a');

/** Basil leaf: two-tone green with a midrib and angled side veins. */
function basilTexture(seed: number) {
  const n = makeNoise(seed + 61, 128);
  return paint(512, 512, (u, v) => {
    const { x, y } = shapePoint(BASIL_BOUNDS, u, v);
    const t = clamp01((y + 0.07) / 0.145); // 0 stem end .. 1 tip
    const mottle = n.fbm(x * 40 + 5, y * 40 + 9, 4, 0.5);
    const cells = n.fbm(x * 140 + 1, y * 140 + 3, 2, 0.5);

    let color = mixRgb(BASIL_DARK, BASIL_LIGHT, smoothstep(0.3, 0.75, mottle) * 0.8 + cells * 0.2);

    // Midrib, tapering to the tip.
    const midW = 0.0028 * (1 - t * 0.8) + 0.0006;
    const mid = 1 - smoothstep(midW * 0.5, midW, Math.abs(x));
    // Side veins leave the midrib every 14mm and sweep toward the tip.
    const along = y - Math.abs(x) * 0.65 + 0.05;
    const frac = ((along % 0.014) + 0.014) % 0.014;
    const veinD = Math.min(frac, 0.014 - frac);
    const side = (1 - smoothstep(0.0005, 0.0013, veinD)) * (1 - smoothstep(0.02, 0.06, Math.abs(x))) * (Math.abs(x) > midW ? 1 : 0);

    color = mixRgb(color, BASIL_VEIN_SOFT, side * 0.7);
    color = mixRgb(color, BASIL_VEIN, mid);

    const height = 0.45 + mottle * 0.08 + mid * 0.35 + side * 0.15;
    const rough = 0.42 - mid * 0.1;
    return { color, height, rough };
  });
}

const OLIVE_SKIN = rgb('#1f1718');
const OLIVE_CUT = rgb('#3d2a2c');
const OLIVE_CUT_LIGHT = rgb('#5a3f3f');

/** Lathe-mapped olive ring: v runs around the profile, outer skin in the middle. */
function oliveTexture(seed: number) {
  const n = makeNoise(seed + 71, 64);
  return paint(256, 64, (u, v) => {
    const x = u * 24;
    const y = v * 6;
    const grain = n.fbm(x, y, 3, 0.5);
    // Profile: inner wall (0..0.1), bottom cut (0.1..0.3), skin (0.3..0.7), top cut, inner wall.
    const skin = smoothstep(0.27, 0.33, v) * (1 - smoothstep(0.67, 0.73, v));
    const inner = 1 - smoothstep(0.08, 0.12, Math.min(v, 1 - v));
    let color = mixRgb(OLIVE_CUT, OLIVE_CUT_LIGHT, smoothstep(0.35, 0.7, grain) * 0.8);
    color = mixRgb(color, OLIVE_SKIN, skin);
    color = mixRgb(color, rgb('#2a1d1f'), inner * 0.6);
    return { color, height: 0.5 + grain * 0.2 - skin * 0.1, rough: mix(0.5, 0.22, skin) };
  });
}

const JAL_SKIN = rgb('#3f8a2c');
const JAL_SKIN_DARK = rgb('#2c6a1e');
const JAL_FLESH = rgb('#c9df9c');
const JAL_SEED = rgb('#f1e7b8');

/** Lathe-mapped jalapeño ring: glossy green skin outside, pale flesh with seeds on the cut faces. */
function jalapenoTexture(seed: number) {
  const n = makeNoise(seed + 83, 64);
  return paint(256, 64, (u, v) => {
    const x = u * 24;
    const y = v * 6;
    const grain = n.fbm(x, y, 3, 0.5);
    const skin = smoothstep(0.27, 0.33, v) * (1 - smoothstep(0.67, 0.73, v));
    const inner = 1 - smoothstep(0.08, 0.12, Math.min(v, 1 - v));
    // Seeds cluster on the inner part of the cut faces.
    const seeds = smoothstep(0.75, 0.85, n.fbm(x * 5 + 3, y * 2 + 9, 2, 0.5)) * inner * 0.9;
    let color = mixRgb(JAL_FLESH, rgb('#a9c57e'), smoothstep(0.35, 0.7, grain) * 0.7);
    color = mixRgb(color, JAL_SEED, seeds);
    color = mixRgb(color, mixRgb(JAL_SKIN, JAL_SKIN_DARK, smoothstep(0.3, 0.7, grain)), skin);
    return { color, height: 0.5 + grain * 0.2 + seeds * 0.3 - skin * 0.1, rough: mix(0.55, 0.22, skin) };
  });
}

const HAM_BOUNDS: Bounds = { minX: -0.062, maxX: 0.062, minY: -0.052, maxY: 0.052 };
const HAM_BASE = rgb('#e6999f');
const HAM_DARK = rgb('#cf7a82');
const HAM_FAT = rgb('#f5dcd6');

/** Ham piece: pink with pale fat marbling and a slightly darker, drier edge. */
function hamTexture(seed: number) {
  const n = makeNoise(seed + 97, 128);
  return paint(512, 512, (u, v) => {
    const { x, y } = shapePoint(HAM_BOUNDS, u, v);
    const grain = n.fbm(x * 60 + 2, y * 60 + 5, 3, 0.5);
    // Fat runs in long streaks.
    const streak = n.fbm(x * 18 + 7, y * 70 + 1, 3, 0.55);
    const fat = smoothstep(0.6, 0.72, streak);
    const r = Math.hypot(x / 0.062, y / 0.052);
    const edge = smoothstep(0.78, 1, r);
    let color = mixRgb(HAM_BASE, HAM_DARK, smoothstep(0.35, 0.7, grain) * 0.7);
    color = mixRgb(color, HAM_FAT, fat * 0.85);
    color = mixRgb(color, HAM_DARK, edge * 0.5);
    return { color, height: 0.5 + grain * 0.15 + fat * 0.1, rough: 0.5 - fat * 0.1 + edge * 0.15 };
  });
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

const DISC_RADIUS = 0.9;
const CRUST_RADIUS = 0.9;
const CRUST_TUBE = 0.1;
const BASE_THICKNESS = 0.06;
/** How far each nested level sits below its parent's surface, in parent units. */
const LEVEL_DROP = -0.004;

/** A torus with its tube radius wobbled by noise so it reads as hand-stretched dough. */
function crustGeometry(seed: number) {
  const n = makeNoise(seed + 41);
  const geo = new THREE.TorusGeometry(CRUST_RADIUS, CRUST_TUBE, 28, 160);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const ring = Math.atan2(v.y, v.x);
    const cx = Math.cos(ring) * CRUST_RADIUS;
    const cy = Math.sin(ring) * CRUST_RADIUS;
    const dx = v.x - cx;
    const dy = v.y - cy;
    const dz = v.z;
    // Radial component of the tube offset (positive = outside of the ring).
    const radial = dx * Math.cos(ring) + dy * Math.sin(ring);
    const tube = Math.atan2(dz, radial);
    const t = ring / (Math.PI * 2) + 0.5; // 0..1 around, periodic
    const puff = 0.72 + n.fbm(t * 64, 2.5, 3) * 0.55 + n.fbm(t * 256, tube * 2 + 7, 2) * 0.18;
    // Fatter on the outside edge, melting into the cheese on the inside.
    const outward = Math.cos(tube) * 0.5 + 0.5;
    const s = puff * (0.9 + outward * 0.25);
    pos.setXYZ(i, cx + dx * s, cy + dy * s, dz * s);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Project an extruded shape's UVs onto its planar bounds so a painted face texture lines up. */
function planarUVs(geo: THREE.BufferGeometry, b: Bounds) {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, (pos.getX(i) - b.minX) / (b.maxX - b.minX), (pos.getY(i) - b.minY) / (b.maxY - b.minY));
  }
  uv.needsUpdate = true;
  return geo;
}

/** Scale a lathe's radius around its axis by a periodic noise so the outline isn't a perfect circle. */
function roughenOutline(geo: THREE.BufferGeometry, seed: number, amount: number) {
  const n = makeNoise(seed);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const a = Math.atan2(z, x);
    const s = 1 + (n.fbm(Math.cos(a) * 2.5 + 5, Math.sin(a) * 2.5 + 5, 2, 0.5) - 0.5) * amount;
    pos.setX(i, x * s);
    pos.setZ(i, z * s);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Cupped pepperoni slice with a slightly irregular edge. */
function pepperoniGeometry(seed: number) {
  const pts: THREE.Vector2[] = [];
  const R = 0.066;
  // Top surface, centre to rim (cupping up at the edge).
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    pts.push(new THREE.Vector2(t * R, 0.007 + Math.pow(t, 2.5) * 0.022));
  }
  pts.push(new THREE.Vector2(R + 0.005, 0.007 + 0.018));
  pts.push(new THREE.Vector2(R + 0.004, 0.007 + 0.01));
  // Underside, rim back to centre.
  for (let i = 14; i >= 0; i--) {
    const t = i / 14;
    pts.push(new THREE.Vector2(t * R, Math.pow(t, 2.5) * 0.022 - 0.002));
  }
  return roughenOutline(new THREE.LatheGeometry(pts, 48), seed + 81, 0.14);
}

/** Flat mushroom slice outline: domed cap with a stem. */
function mushroomShape() {
  const s = new THREE.Shape();
  const w = MUSH_W;
  s.moveTo(-w, 0);
  s.bezierCurveTo(-w, 0.045, -w * 0.45, 0.07, 0, 0.07);
  s.bezierCurveTo(w * 0.45, 0.07, w, 0.045, w, 0);
  s.lineTo(w * 0.42, -0.004);
  s.bezierCurveTo(w * 0.4, -0.03, w * 0.34, -0.05, w * 0.3, -0.056);
  s.quadraticCurveTo(0, -0.064, -w * 0.3, -0.056);
  s.bezierCurveTo(-w * 0.34, -0.05, -w * 0.4, -0.03, -w * 0.42, -0.004);
  s.closePath();
  return s;
}

function mushroomGeometry() {
  const geo = new THREE.ExtrudeGeometry(mushroomShape(), {
    depth: 0.011,
    bevelEnabled: true,
    bevelThickness: 0.003,
    bevelSize: 0.003,
    bevelSegments: 3,
  });
  return planarUVs(geo, MUSH_BOUNDS);
}

/** Basil leaf outline with a gently wavy edge and a pointed tip. */
function basilShape() {
  const s = new THREE.Shape();
  const L = 0.145;
  const pts: THREE.Vector2[] = [];
  const half = (t: number, side: number) => {
    const w = 0.064 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.85)), 0.9);
    const wave = 1 + 0.05 * Math.sin(t * 34 + side * 1.3);
    return new THREE.Vector2(side * w * wave, -0.07 + t * L);
  };
  for (let i = 0; i <= 40; i++) pts.push(half(i / 40, 1));
  for (let i = 39; i >= 1; i--) pts.push(half(i / 40, -1));
  s.moveTo(pts[0].x, pts[0].y);
  for (const p of pts.slice(1)) s.lineTo(p.x, p.y);
  s.closePath();
  return s;
}

function basilGeometry() {
  const geo = new THREE.ExtrudeGeometry(basilShape(), { depth: 0.0022, bevelEnabled: false, curveSegments: 24 });
  planarUVs(geo, BASIL_BOUNDS);
  // Curl: edges and tip lift away from the cheese.
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const lift = 0.016 * Math.pow(Math.abs(x) / 0.064, 2) + 0.012 * Math.pow(Math.max(y, 0) / 0.075, 2.5);
    pos.setZ(i, pos.getZ(i) + lift);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Sliced black olive: a flat ring with rounded edges, slightly out of round. */
function oliveGeometry(seed: number) {
  const pts = [
    [0.017, -0.006],
    [0.022, -0.0078],
    [0.034, -0.0078],
    [0.039, -0.004],
    [0.04, 0],
    [0.039, 0.004],
    [0.034, 0.0078],
    [0.022, 0.0078],
    [0.017, 0.006],
    [0.015, 0],
    [0.017, -0.006],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  return roughenOutline(new THREE.LatheGeometry(pts, 36), seed + 91, 0.12);
}

/** Bilinear sample of a painted height map. u, v in 0..1 with v running top-down like the canvas. */
function sampleHeight(tex: ReturnType<typeof paint>, u: number, v: number) {
  const { heightData, width, height } = tex;
  const fx = clamp01(u) * (width - 1);
  const fy = clamp01(v) * (height - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  return mix(
    mix(heightData[y0 * width + x0], heightData[y0 * width + x1], tx),
    mix(heightData[y1 * width + x0], heightData[y1 * width + x1], tx),
    ty,
  );
}

const CHEESE_RELIEF = 0.028;
const cheeseHeight = (h: number) => (h - 0.2) * CHEESE_RELIEF;

/** Push a flat ring's vertices up by a planar height map (ring UVs span its bounding square). */
function displaceRing(geo: THREE.BufferGeometry, tex: ReturnType<typeof paint>) {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    // Canvas rows run top-down, texture v runs bottom-up.
    pos.setZ(i, cheeseHeight(sampleHeight(tex, uv.getX(i), 1 - uv.getY(i))));
  }
  geo.computeVertexNormals();
  return geo;
}

/** Jalapeño ring: like the olive but larger, thinner-walled and a little wobblier. */
function jalapenoGeometry(seed: number) {
  const pts = [
    [0.03, -0.007],
    [0.036, -0.0085],
    [0.046, -0.0085],
    [0.051, -0.004],
    [0.052, 0],
    [0.051, 0.004],
    [0.046, 0.0085],
    [0.036, 0.0085],
    [0.03, 0.007],
    [0.028, 0],
    [0.03, -0.007],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  return roughenOutline(new THREE.LatheGeometry(pts, 40), seed + 101, 0.16);
}

/** Torn ham piece: a wobbly rounded rectangle, thin, with lifted corners. */
function hamGeometry(seed: number) {
  const n = makeNoise(seed + 103);
  const shape = new THREE.Shape();
  const pts: THREE.Vector2[] = [];
  const steps = 36;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    // Superellipse for a soft rectangle, then noise for torn edges.
    const c = Math.cos(a);
    const sn = Math.sin(a);
    const k = 1 / Math.pow(Math.pow(Math.abs(c), 3) + Math.pow(Math.abs(sn), 3), 1 / 3);
    const wobble = 0.86 + n.fbm(c * 2 + 5, sn * 2 + 5, 2, 0.5) * 0.28;
    pts.push(new THREE.Vector2(c * k * 0.058 * wobble, sn * k * 0.048 * wobble));
  }
  shape.moveTo(pts[0].x, pts[0].y);
  for (const p of pts.slice(1)) shape.lineTo(p.x, p.y);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.004, bevelEnabled: false });
  planarUVs(geo, HAM_BOUNDS);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const lift = 0.012 * Math.pow(Math.hypot(x / 0.062, y / 0.052), 3) + n.fbm(x * 30 + 1, y * 30 + 2, 2, 0.5) * 0.006;
    pos.setZ(i, pos.getZ(i) + lift);
  }
  geo.computeVertexNormals();
  return geo;
}

interface Assets {
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
  textures: THREE.Texture[];
}

type Painted = ReturnType<typeof paint>;
interface PaintedSet {
  seed: number;
  cheese: Painted;
  crust: Painted;
  pepperoni: Painted;
  mushroom: Painted;
  basil: Painted;
  olive: Painted;
  jalapeno: Painted;
  ham: Painted;
}

/** Painting textures is the slow part of a rebuild, so keep the last set unless the seed changes. */
let paintedCache: PaintedSet | null = null;
/** Let the browser paint a frame between heavy steps. */
const breathe = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

/** Fill the texture cache one texture at a time, reporting progress, so a loader can animate. */
async function prepaint(seed: number, report: ProgressCallback) {
  if (paintedCache && paintedCache.seed === seed) return;
  const steps: Array<[string, keyof Omit<PaintedSet, 'seed'>, (seed: number) => Painted]> = [
    ['Stretching the dough', 'crust', crustTexture],
    ['Spreading sauce and grating cheese', 'cheese', cheeseTexture],
    ['Slicing pepperoni', 'pepperoni', pepperoniTexture],
    ['Chopping mushrooms', 'mushroom', mushroomTexture],
    ['Picking basil', 'basil', basilTexture],
    ['Pitting olives', 'olive', oliveTexture],
    ['Slicing jalapeños', 'jalapeno', jalapenoTexture],
    ['Dicing ham', 'ham', hamTexture],
  ];
  const partial: Partial<PaintedSet> = { seed };
  for (let i = 0; i < steps.length; i++) {
    const [caption, key, make] = steps[i];
    report(caption, i / (steps.length + 1));
    await breathe();
    partial[key] = make(seed);
  }
  paintedCache = partial as PaintedSet;
}

function paintedFor(seed: number): PaintedSet {
  if (paintedCache && paintedCache.seed === seed) return paintedCache;
  if (paintedCache) {
    const { cheese, crust, pepperoni, mushroom, basil, olive, jalapeno, ham } = paintedCache;
    for (const set of [cheese, crust, pepperoni, mushroom, basil, olive, jalapeno, ham]) {
      set.map.dispose();
      set.bumpMap.dispose();
      set.roughnessMap.dispose();
    }
  }
  paintedCache = {
    seed,
    cheese: cheeseTexture(seed),
    crust: crustTexture(seed),
    pepperoni: pepperoniTexture(seed),
    mushroom: mushroomTexture(seed),
    basil: basilTexture(seed),
    olive: oliveTexture(seed),
    jalapeno: jalapenoTexture(seed),
    ham: hamTexture(seed),
  };
  return paintedCache;
}

type MaterialParams = THREE.MeshPhysicalMaterialParameters;

function buildPizza(config: PizzaConfig, assets: Assets): THREE.Group {
  const rng = mulberry32(config.seed);
  const group = new THREE.Group();

  /** PBR material, physical when a clearcoat is wanted. */
  const material = (params: MaterialParams, physical = false): THREE.Material =>
    physical ? new THREE.MeshPhysicalMaterial(params) : new THREE.MeshStandardMaterial(params);

  const geo = <T extends THREE.BufferGeometry>(g: T): T => (assets.geometries.push(g), g);
  const mat = <T extends THREE.Material>(m: T): T => (assets.materials.push(m), m);
  const painted = paintedFor(config.seed);

  // Inner pizza hole: next level is `ratio` the size, including its crust.
  const holeRadius = (CRUST_RADIUS + CRUST_TUBE) * config.ratio * 0.97;

  /* Cheese + sauce top, from the hole out under the crust. */
  const cheese = painted.cheese;
  const cheeseMat = mat(
    material({
      map: cheese.map,
      bumpMap: cheese.bumpMap,
      bumpScale: 1.2,
      roughnessMap: cheese.roughnessMap,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 1.2,
    }),
  );
  const topGeo = geo(new THREE.RingGeometry(holeRadius, DISC_RADIUS, 256, 48));
  displaceRing(topGeo, cheese);
  const top = new THREE.Mesh(topGeo, cheeseMat);
  // Surface height at a point on the pizza, so toppings sit on the cheese.
  // The ring is rotated -90° about x, so world z = -geometry y.
  const heightAt = (x: number, z: number) =>
    cheeseHeight(sampleHeight(cheese, (x / DISC_RADIUS + 1) / 2, 1 - (-z / DISC_RADIUS + 1) / 2));
  const surfaceAt = (x: number, z: number, footprint = 0.05) => {
    let h = heightAt(x, z);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      h = Math.max(h, heightAt(x + Math.cos(a) * footprint, z + Math.sin(a) * footprint));
    }
    return h;
  };
  top.rotation.x = -Math.PI / 2;
  top.receiveShadow = true;
  group.add(top);

  /* Base body under the cheese. */
  const baseMat = mat(material({ color: '#9d6a38', roughness: 0.95 }));
  const base = new THREE.Mesh(
    geo(new THREE.CylinderGeometry(DISC_RADIUS, DISC_RADIUS - 0.01, BASE_THICKNESS, 128, 1, true)),
    baseMat,
  );
  base.position.y = -BASE_THICKNESS / 2;
  group.add(base);
  const bottomMat = mat(material({ color: '#9d6a38', roughness: 0.95, side: THREE.DoubleSide }));
  const bottom = new THREE.Mesh(geo(new THREE.CircleGeometry(DISC_RADIUS, 128)), bottomMat);
  bottom.rotation.x = Math.PI / 2;
  bottom.position.y = -BASE_THICKNESS;
  group.add(bottom);

  /* Hole wall so the inner pizza sits in a little recess. */
  const wall = new THREE.Mesh(
    geo(new THREE.CylinderGeometry(holeRadius, holeRadius, BASE_THICKNESS, 64, 1, true)),
    mat(material({ color: '#6e3a16', roughness: 1, side: THREE.BackSide })),
  );
  wall.position.y = -BASE_THICKNESS / 2;
  group.add(wall);

  /* Crust. */
  const crustMaps = painted.crust;
  const crust = new THREE.Mesh(
    geo(crustGeometry(config.seed)),
    mat(
      material({
        map: crustMaps.map,
        bumpMap: crustMaps.bumpMap,
        bumpScale: 1.5,
        roughnessMap: crustMaps.roughnessMap,
        roughness: 1,
        envMapIntensity: 0.5,
      }),
    ),
  );
  crust.rotation.x = Math.PI / 2;
  crust.position.y = -0.012;
  crust.castShadow = crust.receiveShadow = true;
  group.add(crust);

  /* Topping assets. */
  const pepMaps = painted.pepperoni;
  const pepGeo = geo(pepperoniGeometry(config.seed));
  const pepMat = mat(
    material(
      {
        map: pepMaps.map,
        bumpMap: pepMaps.bumpMap,
        bumpScale: 0.8,
        roughnessMap: pepMaps.roughnessMap,
        roughness: 1,
        envMapIntensity: 1.2,
        clearcoat: 0.35,
        clearcoatRoughness: 0.4,
      },
      true,
    ),
  );

  const mushMaps = painted.mushroom;
  const mushGeo = geo(mushroomGeometry());
  const mushFace = mat(
    material({
      map: mushMaps.map,
      bumpMap: mushMaps.bumpMap,
      bumpScale: 0.5,
      roughnessMap: mushMaps.roughnessMap,
      roughness: 1,
      envMapIntensity: 0.5,
    }),
  );
  const mushSide = mat(material({ color: '#dcc7a2', roughness: 0.8, envMapIntensity: 0.4 }));

  const basilMaps = painted.basil;
  const basilGeo = geo(basilGeometry());
  const basilMat = mat(
    material({
      map: basilMaps.map,
      bumpMap: basilMaps.bumpMap,
      bumpScale: 0.4,
      roughnessMap: basilMaps.roughnessMap,
      roughness: 1,
      envMapIntensity: 1,
      side: THREE.DoubleSide,
    }),
  );

  const oliveMaps = painted.olive;
  const oliveGeo = geo(oliveGeometry(config.seed));
  const oliveMat = mat(
    material(
      {
        map: oliveMaps.map,
        bumpMap: oliveMaps.bumpMap,
        bumpScale: 0.3,
        roughnessMap: oliveMaps.roughnessMap,
        roughness: 1,
        envMapIntensity: 1.2,
        clearcoat: 0.6,
        clearcoatRoughness: 0.25,
      },
      true,
    ),
  );

  const jalMaps = painted.jalapeno;
  const jalGeo = geo(jalapenoGeometry(config.seed));
  const jalMat = mat(
    material(
      {
        map: jalMaps.map,
        bumpMap: jalMaps.bumpMap,
        bumpScale: 0.3,
        roughnessMap: jalMaps.roughnessMap,
        roughness: 1,
        envMapIntensity: 1.1,
        clearcoat: 0.5,
        clearcoatRoughness: 0.3,
      },
      true,
    ),
  );

  const hamMaps = painted.ham;
  const hamGeo = geo(hamGeometry(config.seed));
  const hamMat = mat(
    material({
      map: hamMaps.map,
      bumpMap: hamMaps.bumpMap,
      bumpScale: 0.3,
      roughnessMap: hamMaps.roughnessMap,
      roughness: 1,
      envMapIntensity: 0.9,
      side: THREE.DoubleSide,
    }),
  );

  const placed: Array<{ x: number; z: number; r: number }> = [];
  const minR = holeRadius + 0.1;
  const maxR = CRUST_RADIUS - CRUST_TUBE - 0.05;

  function place(radius: number, tries = 40): { x: number; z: number } | null {
    for (let i = 0; i < tries; i++) {
      const a = rng() * Math.PI * 2;
      const d = Math.sqrt(rng()) * (maxR - minR) + minR;
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      const ok = placed.every((p) => Math.hypot(p.x - x, p.z - z) > (p.r + radius) * 0.85);
      if (ok) {
        placed.push({ x, z, r: radius });
        return { x, z };
      }
    }
    return null;
  }

  const addTopping = (
    kind: keyof ToppingCounts,
    count: number,
    footprint: number,
    make: (x: number, z: number) => THREE.Object3D,
  ) => {
    for (let i = 0; i < count; i++) {
      const pos = place(footprint);
      if (!pos) continue;
      const obj = make(pos.x, pos.z);
      obj.userData.topping = kind;
      obj.traverse((o) => {
        if (o instanceof THREE.Mesh) o.castShadow = o.receiveShadow = true;
      });
      group.add(obj);
    }
  };

  const t = config.toppings;
  addTopping('pepperoni', t.pepperoni, 0.07, (x, z) => {
    const m = new THREE.Mesh(pepGeo, pepMat);
    const s = 0.8 + rng() * 0.45;
    // Varied cupping: some slices lie flat, some curl up into little cups.
    m.scale.set(s, 0.7 + rng() * 0.7, s * (0.92 + rng() * 0.16));
    m.position.set(x, surfaceAt(x, z) + 0.002, z);
    m.rotation.set((rng() - 0.5) * 0.15, rng() * Math.PI * 2, (rng() - 0.5) * 0.15);
    return m;
  });
  addTopping('mushroom', t.mushroom, 0.075, (x, z) => {
    const m = new THREE.Mesh(mushGeo, [mushFace, mushSide]);
    m.rotation.x = -Math.PI / 2 + (rng() - 0.5) * 0.3;
    m.rotation.z = rng() * Math.PI * 2;
    const s = 0.62 + rng() * 0.3;
    m.scale.setScalar(s);
    m.position.set(x, surfaceAt(x, z) + 0.004, z);
    return m;
  });
  addTopping('basil', t.basil, 0.07, (x, z) => {
    const m = new THREE.Mesh(basilGeo, basilMat);
    m.rotation.x = -Math.PI / 2 + (rng() - 0.5) * 0.3;
    m.rotation.z = rng() * Math.PI * 2;
    const s = 0.7 + rng() * 0.3;
    m.scale.setScalar(s);
    m.position.set(x, surfaceAt(x, z) + 0.004, z);
    return m;
  });
  addTopping('olive', t.olive, 0.045, (x, z) => {
    const m = new THREE.Mesh(oliveGeo, oliveMat);
    m.rotation.set((rng() - 0.5) * 0.25, rng() * Math.PI * 2, (rng() - 0.5) * 0.25);
    const s = 0.85 + rng() * 0.3;
    m.scale.set(s, 1, s);
    m.position.set(x, surfaceAt(x, z) + 0.009, z);
    return m;
  });

  addTopping('jalapeno', t.jalapeno, 0.055, (x, z) => {
    const m = new THREE.Mesh(jalGeo, jalMat);
    m.rotation.set((rng() - 0.5) * 0.3, rng() * Math.PI * 2, (rng() - 0.5) * 0.3);
    const s = 0.8 + rng() * 0.35;
    m.scale.set(s, 1, s);
    m.position.set(x, surfaceAt(x, z) + 0.01, z);
    return m;
  });
  addTopping('ham', t.ham, 0.065, (x, z) => {
    const m = new THREE.Mesh(hamGeo, hamMat);
    m.rotation.x = -Math.PI / 2 + (rng() - 0.5) * 0.2;
    m.rotation.z = rng() * Math.PI * 2;
    const s = 0.75 + rng() * 0.4;
    m.scale.setScalar(s);
    m.position.set(x, surfaceAt(x, z) + 0.004, z);
    return m;
  });

  return group;
}

/* ------------------------------------------------------------------ */
/* Scene                                                               */
/* ------------------------------------------------------------------ */

export async function createPizza(
  canvas: HTMLCanvasElement,
  initial: Partial<PizzaConfig> = {},
  onProgress: ProgressCallback = () => {},
): Promise<PizzaController> {
  const config: PizzaConfig = { ...defaultConfig, ...initial, toppings: { ...defaultConfig.toppings, ...initial.toppings } };

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.shadowMap.enabled = config.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#f48c06');

  // Soft studio reflections so grease and cheese pick up highlights.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envMap;
  scene.environmentIntensity = 0.35;
  pmrem.dispose();

  const camera = new THREE.PerspectiveCamera(config.fov, 1, 0.05, 200);

  /* Look transitions: snapshot the current frame, swap the look, wipe to the live result. */
  const transition = new TransitionPass();
  const snapshot = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
  const copyQuad = new FullScreenQuad(new THREE.MeshBasicMaterial({ toneMapped: false }));

  const makePipeline = () =>
    createPipeline({ renderer, scene, camera, effect: config.effect, pixelSize: config.pixelSize, tail: [transition] });
  let pipeline: EffectPipeline = makePipeline();
  const rebuildPipeline = () => {
    pipeline.dispose();
    pipeline = makePipeline();
    pipeline.setSize(window.innerWidth, window.innerHeight);
  };

  /** Render the current look once into the snapshot target. */
  function captureFrame() {
    const wasEnabled = transition.enabled;
    transition.enabled = false;
    pipeline.composer.renderToScreen = false;
    pipeline.composer.render();
    pipeline.composer.renderToScreen = true;
    transition.enabled = wasEnabled;

    (copyQuad.material as THREE.MeshBasicMaterial).map = pipeline.composer.readBuffer.texture;
    renderer.setRenderTarget(snapshot);
    copyQuad.render(renderer);
    renderer.setRenderTarget(null);
  }

  /** Run `change` with a wipe from the frame before it to the frames after. */
  function withTransition(change: () => void, duration = 700) {
    captureFrame();
    change();
    transition.begin(snapshot.texture, performance.now(), duration);
  }

  /* Lights */
  const hemi = new THREE.HemisphereLight('#fff3dd', '#b85f14', 0.3);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#fff0d8', 3);
  sun.position.set(3, 4, 1.5);
  sun.castShadow = config.shadows;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -2.5;
  sun.shadow.camera.right = sun.shadow.camera.top = 2.5;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 15;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.01;
  sun.shadow.radius = 4;
  scene.add(sun);
  const fill = new THREE.DirectionalLight('#ffd6a6', 0.35);
  fill.position.set(-3, 2, -2);
  scene.add(fill);

  /* Pizza stack */
  const root = new THREE.Group();
  scene.add(root);

  let assets: Assets = { geometries: [], materials: [], textures: [] };
  let levelGroups: THREE.Group[] = [];

  function disposeAssets() {
    assets.geometries.forEach((g) => g.dispose());
    assets.materials.forEach((m) => m.dispose());
    assets.textures.forEach((t) => t.dispose());
    assets = { geometries: [], materials: [], textures: [] };
  }

  function rebuild() {
    root.clear();
    disposeAssets();
    levelGroups = [];

    const pizza = buildPizza(config, assets);
    let parent: THREE.Object3D = root;
    for (let i = 0; i < config.levels; i++) {
      const level = new THREE.Group();
      level.add(i === 0 ? pizza : pizza.clone());
      if (i > 0) {
        level.scale.setScalar(config.ratio);
        level.position.y = LEVEL_DROP; // sit just inside the recess
      }
      parent.add(level);
      levelGroups.push(level);
      parent = level;
    }
  }

  await prepaint(config.seed, onProgress);
  rebuild();

  /* Camera framing */
  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    pipeline.setSize(w, h);
    const pr = renderer.getPixelRatio();
    snapshot.setSize(w * pr, h * pr);
    transition.setResolution(w * pr, h * pr);
    camera.aspect = w / h;
    camera.fov = config.fov;
    // Keep the pizza filling the viewport: back off on portrait screens and narrow lenses.
    const dist = (camera.aspect < 1 ? 2.9 / Math.max(camera.aspect, 0.5) : 2.9) * (42 / config.fov);
    const elev = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(config.elevation, 10, 89.9));
    camera.position.set(0, Math.sin(elev) * dist, Math.cos(elev) * dist);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener('resize', resize);

  /* Animation */
  let phase = 0; // 0..1 progress through one zoom cycle
  let spin = 0; // accumulated rotation of the root, radians
  let last = performance.now();
  let elapsed = 0;
  let raf = 0;

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;

    elapsed += dt;
    const cycle = Math.max(config.cycleSeconds, 0.2);
    const step = (dt / cycle) * config.direction;
    phase += step;
    spin += step * config.spinTurns * Math.PI * 2;
    if (phase >= 1) {
      phase -= 1;
      // Loop reset: level n+1 now looks exactly like level n did at phase 0.
      spin += config.innerSpinTurns * Math.PI * 2;
    } else if (phase < 0) {
      phase += 1;
      spin -= config.innerSpinTurns * Math.PI * 2;
    }
    spin = ((spin % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

    // Level 1 fills the frame at phase 0 and level 2 at phase 1.
    const k = config.ratio;
    const scale = Math.pow(k, -(1 + phase));
    root.scale.setScalar(scale);
    // Each level sits LEVEL_DROP below its parent, so level n is at
    // LEVEL_DROP * (1 - k^n) / (1 - k) in root space. Lift the root so the
    // level currently in focus (n = 1 + phase) always sits at the origin,
    // otherwise the stack drifts down over a cycle and snaps back on reset.
    root.position.y = (-scale * LEVEL_DROP * (1 - Math.pow(k, 1 + phase))) / (1 - k);
    root.rotation.y = spin;
    const inner = phase * config.innerSpinTurns * Math.PI * 2;
    for (let i = 1; i < levelGroups.length; i++) levelGroups[i].rotation.y = inner;

    pipeline.tick(elapsed);
    transition.tick(now);
    pipeline.composer.render();
  }
  // Warm the shaders before the first frame so the reveal doesn't stutter.
  onProgress('Into the oven', 6 / 7);
  await breathe();
  await renderer.compileAsync(scene, camera);
  pipeline.composer.render();
  onProgress('Ready', 1);

  raf = requestAnimationFrame(frame);

  /** Copy a render target into a PNG data URL (flipping GL's bottom-up rows). */
  function targetToDataUrl(rt: THREE.WebGLRenderTarget) {
    const { width, height } = rt;
    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, width, height, pixels);
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const ctx = out.getContext('2d')!;
    const image = ctx.createImageData(width, height);
    const row = width * 4;
    for (let y = 0; y < height; y++) image.data.set(pixels.subarray(y * row, (y + 1) * row), (height - 1 - y) * row);
    ctx.putImageData(image, 0, 0);
    return out.toDataURL('image/png');
  }

  async function renderPreviews(size = 96): Promise<Previews> {
    const looks = {} as Record<EffectName, string>;
    const toppings = {} as Record<keyof ToppingCounts, string>;
    const previousAspect = camera.aspect;
    camera.aspect = 1;
    camera.updateProjectionMatrix();

    // Every look, rendered from the live scene into a small square target.
    for (const effect of EFFECTS) {
      const target = new THREE.WebGLRenderTarget(size, size, { type: THREE.UnsignedByteType });
      const p = createPipeline({ renderer, scene, camera, effect, pixelSize: Math.max(2, Math.round(config.pixelSize / 2)), target });
      p.setSize(size, size);
      p.tick(1.3);
      p.composer.render();
      looks[effect] = targetToDataUrl(p.composer.readBuffer);
      p.dispose();
      await breathe();
    }
    camera.aspect = previousAspect;
    camera.updateProjectionMatrix();

    // Each topping on its own against a transparent background.
    const stage = new THREE.Scene();
    stage.environment = scene.environment;
    stage.environmentIntensity = scene.environmentIntensity;
    stage.add(hemi.clone(), fill.clone());
    const key = new THREE.DirectionalLight(sun.color, sun.intensity);
    key.position.copy(sun.position);
    stage.add(key);
    const cam = new THREE.PerspectiveCamera(28, 1, 0.01, 10);
    const holder = new THREE.Group();
    stage.add(holder);

    const target = new THREE.WebGLRenderTarget(size, size, { type: THREE.UnsignedByteType });
    const composer = new EffectComposer(renderer, target);
    composer.renderToScreen = false;
    const pass = new RenderPass(stage, cam);
    pass.clearColor = new THREE.Color(0x000000);
    pass.clearAlpha = 0;
    composer.addPass(pass);
    composer.addPass(new OutputPass());
    composer.setSize(size, size);

    const pizza = levelGroups[0]?.children[0];
    for (const kind of ['pepperoni', 'mushroom', 'basil', 'olive', 'jalapeno', 'ham'] as const) {
      let source: THREE.Object3D | undefined;
      pizza?.traverse((o) => {
        if (!source && o.userData.topping === kind) source = o;
      });
      if (!source) continue;
      const clone = source.clone();
      clone.position.set(0, 0, 0);
      clone.traverse((o) => {
        if (o instanceof THREE.Mesh) o.castShadow = o.receiveShadow = false;
      });
      holder.clear();
      holder.add(clone);
      const sphere = new THREE.Box3().setFromObject(clone).getBoundingSphere(new THREE.Sphere());
      const dist = (sphere.radius * 1.15) / Math.sin(THREE.MathUtils.degToRad(cam.fov / 2));
      cam.position.copy(sphere.center).add(new THREE.Vector3(0.35, 1, 0.55).normalize().multiplyScalar(dist));
      cam.lookAt(sphere.center);
      composer.render();
      toppings[kind] = targetToDataUrl(composer.readBuffer);
      await breathe();
    }
    composer.dispose();
    stage.clear();

    return { looks, toppings };
  }

  return {
    config,
    renderPreviews,
    update(patch) {
      const needsRebuild =
        patch.toppings !== undefined || patch.seed !== undefined || patch.ratio !== undefined || patch.levels !== undefined;
      const lookChanged = patch.effect !== undefined && patch.effect !== config.effect;
      const seedChanged = patch.seed !== undefined && patch.seed !== config.seed;
      Object.assign(config, patch, patch.toppings ? { toppings: { ...config.toppings, ...patch.toppings } } : {});

      const apply = () => {
        if (patch.effect !== undefined) rebuildPipeline();
        else if (patch.pixelSize !== undefined) pipeline.setPixelSize(patch.pixelSize);
        if (patch.elevation !== undefined || patch.fov !== undefined) resize();
        if (patch.shadows !== undefined) {
          renderer.shadowMap.enabled = patch.shadows;
          sun.castShadow = patch.shadows;
          assets.materials.forEach((m) => (m.needsUpdate = true));
        }
        if (needsRebuild) rebuild();
      };

      // Wipe between looks and between shuffled pizzas; everything else changes live.
      if (lookChanged || seedChanged) withTransition(apply, lookChanged ? 700 : 500);
      else apply();
    },
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      disposeAssets();
      pipeline.dispose();
      transition.dispose();
      snapshot.dispose();
      copyQuad.dispose();
      envMap.dispose();
      renderer.dispose();
    },
  };
}
