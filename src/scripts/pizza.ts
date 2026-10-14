import * as THREE from 'three';
import { createPipeline, TransitionPass, usesToonMaterials, type EffectName, type EffectPipeline } from './effects';
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
  toppings: { pepperoni: 27, mushroom: 10, basil: 5, olive: 14 },
  shadows: true,
  direction: 1,
  elevation: 41,
  fov: 42,
  effect: 'none',
  pixelSize: 6,
};

export interface PizzaController {
  config: PizzaConfig;
  update(patch: Partial<PizzaConfig>): void;
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

/** Cupped pepperoni slice. */
function pepperoniGeometry() {
  const pts: THREE.Vector2[] = [];
  const R = 0.066;
  // Top surface, centre to rim (cupping up at the edge).
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    pts.push(new THREE.Vector2(t * R, 0.006 + Math.pow(t, 2.5) * 0.02));
  }
  pts.push(new THREE.Vector2(R + 0.004, 0.006 + 0.016));
  // Underside, rim back to centre.
  for (let i = 12; i >= 0; i--) {
    const t = i / 12;
    pts.push(new THREE.Vector2(t * R, Math.pow(t, 2.5) * 0.02 - 0.002));
  }
  const geo = new THREE.LatheGeometry(pts, 36);
  geo.computeVertexNormals();
  return geo;
}

/** Flat mushroom slice: domed cap with a stem, as an extruded outline. */
function mushroomShape() {
  const s = new THREE.Shape();
  const w = 0.06; // half cap width
  s.moveTo(-w, 0);
  s.bezierCurveTo(-w, 0.045, -w * 0.45, 0.07, 0, 0.07);
  s.bezierCurveTo(w * 0.45, 0.07, w, 0.045, w, 0);
  s.lineTo(w * 0.4, -0.005);
  s.lineTo(w * 0.3, -0.05);
  s.quadraticCurveTo(0, -0.058, -w * 0.3, -0.05);
  s.lineTo(-w * 0.4, -0.005);
  s.closePath();
  return s;
}

/** The dark gill line along the underside of the cap. */
function gillShape() {
  const s = new THREE.Shape();
  const w = 0.058;
  s.moveTo(-w, 0.004);
  s.quadraticCurveTo(0, -0.012, w, 0.004);
  s.lineTo(w, -0.002);
  s.quadraticCurveTo(0, -0.02, -w, -0.002);
  s.closePath();
  return s;
}

/** Brown skin along the curved top of the cap. */
function mushroomSkinShape() {
  const s = new THREE.Shape();
  const w = 0.06;
  const d = 0.009;
  s.moveTo(-w, 0);
  s.bezierCurveTo(-w, 0.045, -w * 0.45, 0.07, 0, 0.07);
  s.bezierCurveTo(w * 0.45, 0.07, w, 0.045, w, 0);
  s.lineTo(w - d, 0);
  s.bezierCurveTo(w - d, 0.038, w * 0.42, 0.07 - d, 0, 0.07 - d);
  s.bezierCurveTo(-w * 0.42, 0.07 - d, -(w - d), 0.038, -(w - d), 0);
  s.closePath();
  return s;
}

function basilVeinShape() {
  const s = new THREE.Shape();
  s.moveTo(-0.002, -0.062);
  s.lineTo(0.002, -0.062);
  s.lineTo(0.0008, 0.06);
  s.lineTo(-0.0008, 0.06);
  s.closePath();
  return s;
}

function basilShape() {
  const s = new THREE.Shape();
  s.moveTo(0, -0.07);
  s.bezierCurveTo(0.06, -0.05, 0.065, 0.03, 0, 0.075);
  s.bezierCurveTo(-0.065, 0.03, -0.06, -0.05, 0, -0.07);
  return s;
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
}

/** Painting textures is the slow part of a rebuild, so keep the last set unless the seed changes. */
let paintedCache: PaintedSet | null = null;
function paintedFor(seed: number): PaintedSet {
  if (paintedCache && paintedCache.seed === seed) return paintedCache;
  if (paintedCache) {
    for (const set of [paintedCache.cheese, paintedCache.crust, paintedCache.pepperoni]) {
      set.map.dispose();
      set.bumpMap.dispose();
      set.roughnessMap.dispose();
    }
  }
  paintedCache = { seed, cheese: cheeseTexture(seed), crust: crustTexture(seed), pepperoni: pepperoniTexture(seed) };
  return paintedCache;
}

type MaterialParams = THREE.MeshStandardMaterialParameters;

/** Four-band gradient for toon shading. */
function toonGradient() {
  const tex = new THREE.DataTexture(new Uint8Array([70, 130, 200, 255]), 4, 1, THREE.RedFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

function buildPizza(config: PizzaConfig, assets: Assets): THREE.Group {
  const rng = mulberry32(config.seed);
  const group = new THREE.Group();

  const toon = usesToonMaterials(config.effect);
  const gradient = toon ? toonGradient() : null;
  if (gradient) assets.textures.push(gradient);
  /** Standard PBR material, or a flat toon one when the cartoon look is on. */
  const material = (params: MaterialParams): THREE.Material => {
    if (!toon) return new THREE.MeshStandardMaterial(params);
    // Flat shading reads better without the bump detail, and three warns on undefined params.
    const picked: THREE.MeshToonMaterialParameters = { gradientMap: gradient };
    if (params.color !== undefined) picked.color = params.color;
    if (params.map !== undefined) picked.map = params.map;
    if (params.side !== undefined) picked.side = params.side;
    return new THREE.MeshToonMaterial(picked);
  };

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
  const pepGeo = geo(pepperoniGeometry());
  const pepMat = mat(
    material({
      map: pepMaps.map,
      bumpMap: pepMaps.bumpMap,
      bumpScale: 0.6,
      roughnessMap: pepMaps.roughnessMap,
      roughness: 1,
      envMapIntensity: 1.2,
    }),
  );

  const extrude = { depth: 0.01, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.003, bevelSegments: 2 };
  const mushGeo = geo(new THREE.ExtrudeGeometry(mushroomShape(), extrude));
  const gillGeo = geo(new THREE.ExtrudeGeometry(gillShape(), { depth: 0.002, bevelEnabled: false }));
  const skinGeo = geo(new THREE.ExtrudeGeometry(mushroomSkinShape(), { depth: 0.002, bevelEnabled: false }));
  const skinMat = mat(material({ color: '#7a5533', roughness: 0.8 }));
  const mushMat = mat(material({ color: '#b8956a', roughness: 0.7, envMapIntensity: 0.5 }));
  const gillMat = mat(material({ color: '#4a2c14', roughness: 0.9 }));

  const basilGeo = geo(new THREE.ExtrudeGeometry(basilShape(), { depth: 0.003, bevelEnabled: false }));
  const veinGeo = geo(new THREE.ExtrudeGeometry(basilVeinShape(), { depth: 0.001, bevelEnabled: false }));
  const veinMat = mat(material({ color: '#79a84e', roughness: 0.5 }));
  const basilMat = mat(
    material({ color: '#2b6424', roughness: 0.4, envMapIntensity: 0.8, side: THREE.DoubleSide }),
  );

  const oliveGeo = geo(new THREE.TorusGeometry(0.038, 0.016, 10, 24));
  const oliveMat = mat(material({ color: '#2a2222', roughness: 0.35, envMapIntensity: 1 }));

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

  const addTopping = (count: number, footprint: number, make: (x: number, z: number) => THREE.Object3D) => {
    for (let i = 0; i < count; i++) {
      const pos = place(footprint);
      if (!pos) continue;
      const obj = make(pos.x, pos.z);
      obj.traverse((o) => {
        if (o instanceof THREE.Mesh) o.castShadow = o.receiveShadow = true;
      });
      group.add(obj);
    }
  };

  const t = config.toppings;
  addTopping(t.pepperoni, 0.07, (x, z) => {
    const m = new THREE.Mesh(pepGeo, pepMat);
    const s = 0.8 + rng() * 0.45;
    m.scale.set(s, 1, s * (0.9 + rng() * 0.2));
    m.position.set(x, surfaceAt(x, z) + 0.002, z);
    m.rotation.set((rng() - 0.5) * 0.15, rng() * Math.PI * 2, (rng() - 0.5) * 0.15);
    return m;
  });
  addTopping(t.mushroom, 0.075, (x, z) => {
    const g = new THREE.Group();
    const slice = new THREE.Mesh(mushGeo, mushMat);
    const gill = new THREE.Mesh(gillGeo, gillMat);
    const skin = new THREE.Mesh(skinGeo, skinMat);
    gill.position.z = skin.position.z = extrude.depth + extrude.bevelThickness - 0.0005;
    g.add(slice, gill, skin);
    g.rotation.x = -Math.PI / 2 + (rng() - 0.5) * 0.25;
    g.rotation.z = rng() * Math.PI * 2;
    const s = 0.62 + rng() * 0.3;
    g.scale.setScalar(s);
    g.position.set(x, surfaceAt(x, z) + 0.004, z);
    return g;
  });
  addTopping(t.basil, 0.07, (x, z) => {
    const m = new THREE.Group();
    const leaf = new THREE.Mesh(basilGeo, basilMat);
    const vein = new THREE.Mesh(veinGeo, veinMat);
    vein.position.z = 0.003;
    m.add(leaf, vein);
    m.rotation.x = -Math.PI / 2 + (rng() - 0.5) * 0.4;
    m.rotation.z = rng() * Math.PI * 2;
    const s = 0.7 + rng() * 0.3;
    m.scale.setScalar(s);
    m.position.set(x, surfaceAt(x, z) + 0.006, z);
    return m;
  });
  addTopping(t.olive, 0.045, (x, z) => {
    const m = new THREE.Mesh(oliveGeo, oliveMat);
    m.rotation.x = Math.PI / 2 + (rng() - 0.5) * 0.2;
    m.scale.y = 0.6;
    m.position.set(x, surfaceAt(x, z) + 0.01, z);
    return m;
  });

  return group;
}

/* ------------------------------------------------------------------ */
/* Scene                                                               */
/* ------------------------------------------------------------------ */

export function createPizza(canvas: HTMLCanvasElement, initial: Partial<PizzaConfig> = {}): PizzaController {
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
  raf = requestAnimationFrame(frame);

  return {
    config,
    update(patch) {
      const toonChanged = patch.effect !== undefined && usesToonMaterials(patch.effect) !== usesToonMaterials(config.effect);
      const needsRebuild =
        patch.toppings !== undefined ||
        patch.seed !== undefined ||
        patch.ratio !== undefined ||
        patch.levels !== undefined ||
        toonChanged;
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
