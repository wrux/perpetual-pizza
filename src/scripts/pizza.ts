import { createPipeline, createTransition, EFFECTS, type EffectName, type EffectPipeline } from './effects';
import {
  compose,
  createTarget,
  createTexture,
  deleteTarget,
  disc,
  geometryFrom,
  identity,
  loadImage,
  lookAt,
  merge,
  multiply,
  normalize,
  perspective,
  ring,
  rotation,
  scaling,
  torus,
  translation,
  tube,
  type Geometry,
  type GL,
  type Mat4,
  type Target,
  type TextureOptions,
  type Vec3,
} from './gl';
import { createRenderer, srgb, type Item, type Material, type Mesh, type View } from './renderer';
import photoManifest from './topping-photos.json';

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
  toppings: { pepperoni: 12, mushroom: 12, basil: 12, olive: 12, jalapeno: 12, ham: 12 },
  shadows: true,
  direction: 1,
  elevation: 41,
  fov: 42,
  effect: 'none',
  pixelSize: 12,
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

/**
 * 2D value noise, fractal sum and cellular (Worley) noise over one random table.
 * `period` is the table size and must be a power of two. Passing `px` / `py`
 * (whole numbers of noise cells) makes a call repeat exactly over that span,
 * for textures that wrap around a ring or tube.
 */
function makeNoise(seed: number, period = 256) {
  const mask = period - 1;
  const table = new Float32Array(period * period);
  const rng = mulberry32(seed);
  for (let i = 0; i < table.length; i++) table[i] = rng();
  const at = (x: number, y: number) => table[(y & mask) * period + (x & mask)];
  const wrap = (i: number, p: number) => (p ? i - p * Math.floor(i / p) : i);
  const smooth = (t: number) => t * t * (3 - 2 * t);

  const noise = (x: number, y: number, px = 0, py = 0) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const tx = smooth(x - xi);
    const ty = smooth(y - yi);
    const x0 = wrap(xi, px);
    const x1 = wrap(xi + 1, px);
    const y0 = wrap(yi, py);
    const y1 = wrap(yi + 1, py);
    const a = at(x0, y0);
    const b = at(x1, y0);
    const c = at(x0, y1);
    const d = at(x1, y1);
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };

  const fbm = (x: number, y: number, octaves = 5, gain = 0.5, px = 0, py = 0) => {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let f = 1;
    for (let i = 0; i < octaves; i++) {
      sum += noise(x * f, y * f, px * f, py * f) * amp;
      norm += amp;
      amp *= gain;
      f *= 2;
    }
    return sum / norm;
  };

  /**
   * Cellular noise: distance to the nearest (`f1`) and second nearest (`f2`)
   * scattered point, plus a random `id` for the nearest one. The result object
   * is reused between calls, so read it before calling again.
   */
  const cell = { f1: 0, f2: 0, id: 0 };
  const cells = (x: number, y: number, px = 0, py = 0) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    let f1 = 9;
    let f2 = 9;
    let id = 0;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const cx = xi + i;
        const cy = yi + j;
        const wx = wrap(cx, px);
        const wy = wrap(cy, py);
        const dx = cx + at(wx, wy) - x;
        const dy = cy + at(wx + 37, wy + 91) - y;
        const d = dx * dx + dy * dy;
        if (d < f1) {
          f2 = f1;
          f1 = d;
          id = at(wx + 113, wy + 57);
        } else if (d < f2) f2 = d;
      }
    }
    cell.f1 = Math.sqrt(f1);
    cell.f2 = Math.sqrt(f2);
    cell.id = id;
    return cell;
  };

  return { noise, fbm, cells };
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

interface PaintOptions {
  /** Slope of the normal map per unit of height difference between neighbouring texels. */
  normal?: number;
  /** Whether the texture repeats along u / v, so the normal map has no seam there. */
  wrapU?: boolean;
  wrapV?: boolean;
}

/**
 * Tangent-space normal map of a height field. Unlike a bump map this is
 * filtered like any other texture, so it stays smooth when magnified.
 */
function normalCanvas(heights: Float32Array, w: number, h: number, strength: number, wrapU: boolean, wrapV: boolean) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const normal = ctx.createImageData(w, h);
  const edge = (i: number, n: number, wraps: boolean) => (wraps ? (i + n) % n : Math.min(Math.max(i, 0), n - 1));
  for (let y = 0; y < h; y++) {
    const up = edge(y - 1, h, wrapV) * w;
    const down = edge(y + 1, h, wrapV) * w;
    for (let x = 0; x < w; x++) {
      const dx = (heights[y * w + edge(x + 1, w, wrapU)] - heights[y * w + edge(x - 1, w, wrapU)]) * strength;
      // Canvas rows run top-down, texture v runs bottom-up.
      const dy = (heights[down + x] - heights[up + x]) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * w + x) * 4;
      normal.data[i] = (-dx * inv * 0.5 + 0.5) * 255;
      normal.data[i + 1] = (dy * inv * 0.5 + 0.5) * 255;
      normal.data[i + 2] = (inv * 0.5 + 0.5) * 255;
      normal.data[i + 3] = 255;
    }
  }
  ctx.putImageData(normal, 0, 0);
  return c;
}

/** Per-pixel painter producing a colour canvas plus normal and roughness canvases. */
function paint(
  w: number,
  h: number,
  shade: (u: number, v: number) => { color: Rgb; height?: number; rough?: number },
  { normal: strength = 2, wrapU = false, wrapV = false }: PaintOptions = {},
) {
  const mk = () => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  };
  const colorC = mk();
  const roughC = mk();
  const color = colorC.getContext('2d')!.createImageData(w, h);
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
      const rv = Math.round(clamp01(s.rough ?? 0.5) * 255);
      rough.data[i] = rough.data[i + 1] = rough.data[i + 2] = rv;
      rough.data[i + 3] = 255;
    }
  }

  colorC.getContext('2d')!.putImageData(color, 0, 0);
  const normalC = normalCanvas(heightData, w, h, strength, wrapU, wrapV);
  roughC.getContext('2d')!.putImageData(rough, 0, 0);

  return {
    /** The painted colour canvas. */
    canvas: colorC,
    normal: normalC,
    rough: roughC,
    heightData,
    width: w,
    height: h,
  };
}

/* ------------------------------------------------------------------ */
/* Textures                                                            */
/* ------------------------------------------------------------------ */

const SAUCE = rgb('#9e2010');
const SAUCE_DARK = rgb('#6f150a');
const SAUCE_LIGHT = rgb('#c9471f');
const CHEESE_CREAM = rgb('#f0d590');
const CHEESE_GOLD = rgb('#e6ab45');
const CHEESE_OIL = rgb('#e8a03f');
const CHEESE_THIN = rgb('#df7f36');
const CHEESE_TOAST = rgb('#cc8530');
const CHEESE_BROWN = rgb('#9a541c');
const CHEESE_CHAR = rgb('#472410');
const HERB = rgb('#38491b');

const CHEESE_SIZE = 1024;

/**
 * With a photographed cheese surface laid over it, the painted cheese only
 * needs to say where the cheese is and how thick: the photo brings its own
 * browning and flecks, and two sets would fight.
 */
const PHOTO_CHEESE = Boolean((photoManifest as { cheeseDetail?: string | null }).cheeseDetail);

/**
 * Planar top-of-pizza texture: melted mozzarella over tomato sauce. The cheese
 * stops short of the crust, thins to orange where the sauce shows through, and
 * blisters into bubbles whose tops brown.
 */
function cheeseTexture(seed: number) {
  const n = makeNoise(seed);
  const n2 = makeNoise(seed + 11);
  return paint(
    CHEESE_SIZE,
    CHEESE_SIZE,
    (u, v) => {
      const x = u * 9;
      const y = v * 9;
      // Distance from centre 0..1 (the ring spans the texture square).
      const r = Math.hypot(u - 0.5, v - 0.5) * 2;
      // The corners of the square are never seen.
      if (r > 0.98) return { color: SAUCE_DARK, height: 0.16, rough: 0.4 };

      // Warp everything a little so melt edges and bubbles are organic rather than blobby.
      const warpX = n.fbm(x * 1.3 + 3, y * 1.3 + 7, 2) - 0.5;
      const warpY = n.fbm(x * 1.3 + 31, y * 1.3 + 17, 2) - 0.5;
      const wx = x + warpX * 1.4;
      const wy = y + warpY * 1.4;

      // How thick the cheese is here: 0 is bare sauce. A ragged band next to the crust stays bare.
      const cover = n.fbm(wx * 0.8, wy * 0.8, 4);
      const rim = smoothstep(0.8, 0.88, r + warpX * 0.12);
      const thick = clamp01((cover - 0.31) / 0.25) * (1 - rim);
      const cheese = smoothstep(0, 0.22, thick);

      // Big blisters. Only some cells bubble, and only the liveliest of those brown.
      const big = n2.cells(x * 2.4 + warpX * 0.5, y * 2.4 + warpY * 0.5);
      const bigId = big.id;
      const reach = big.f1 / (0.28 + bigId * 0.34);
      const dome = clamp01(1 - reach * reach) * smoothstep(0.3, 0.42, bigId) * thick;
      const brown = PHOTO_CHEESE ? 0 : smoothstep(0.2, 0.85, dome) * smoothstep(0.52, 0.88, bigId);
      const scorch = PHOTO_CHEESE ? 0 : smoothstep(0.65, 1, dome) * smoothstep(0.8, 0.97, bigId);
      // Small blisters in between.
      const little = n2.cells(x * 6 + 40 + warpX, y * 6 + 9 + warpY);
      const pimple = clamp01(1 - (little.f1 / 0.42) ** 2) * (little.id > 0.5 ? 1 : 0) * thick;

      const melt = n.fbm(wx * 2.2 + 50, wy * 2.2 + 60, 3);
      const grain = n2.fbm(x * 22 + 11, y * 22 + 4, 2);
      const toasty = smoothstep(0.5, 0.75, n2.fbm(wx * 0.9 + 21, wy * 0.9 + 13, 3));
      // Orange oil pools in the valleys between bubbles.
      const oil = (1 - dome) * smoothstep(0.45, 0.72, melt) * thick;

      let cheeseColor = mixRgb(CHEESE_CREAM, CHEESE_GOLD, clamp01(smoothstep(0.3, 0.7, melt) * 0.7 + toasty * 0.3));
      cheeseColor = mixRgb(cheeseColor, CHEESE_OIL, oil * 0.5);
      cheeseColor = mixRgb(cheeseColor, CHEESE_THIN, (1 - smoothstep(0.1, 0.75, thick)) * 0.85);
      cheeseColor = mixRgb(cheeseColor, CHEESE_TOAST, PHOTO_CHEESE ? 0 : clamp01(brown * 0.8 + pimple * 0.35 + toasty * 0.2));
      cheeseColor = mixRgb(cheeseColor, CHEESE_BROWN, brown * brown * 0.75);
      cheeseColor = mixRgb(cheeseColor, CHEESE_CHAR, scorch * 0.7);

      // Sauce, wherever the cheese lets it show.
      let color = cheeseColor;
      let pulp = 0.5;
      if (cheese < 1) {
        pulp = n2.fbm(x * 5 + 5, y * 5 + 5, 3);
        let sauceColor = mixRgb(SAUCE, SAUCE_DARK, smoothstep(0.35, 0.7, pulp));
        sauceColor = mixRgb(sauceColor, SAUCE_LIGHT, smoothstep(0.62, 0.8, n.fbm(x * 9 + 2, y * 9 + 8, 2)) * 0.6);
        color = mixRgb(sauceColor, cheeseColor, cheese);
      }

      // Sparse oregano flecks.
      const fleck = n.cells(x * 16 + 7, y * 16 + 3);
      if (!PHOTO_CHEESE && fleck.id > 0.95 && fleck.f1 < 0.1 + fleck.id * 0.06) color = mixRgb(color, HERB, 0.75);

      // Fine grain, and a soft shadow where the top tucks under the crust.
      const shadeBy = (0.94 + grain * 0.12) * (1 - smoothstep(0.86, 0.98, r) * 0.35);
      color = [color[0] * shadeBy, color[1] * shadeBy, color[2] * shadeBy];

      const height =
        cheese * (0.36 + thick * 0.1 + melt * 0.1 + dome * 0.3 + pimple * 0.07) +
        (1 - cheese) * (0.16 + pulp * 0.06) +
        grain * 0.02;
      const rough = mix(0.36, 0.56, cheese) - oil * 0.2 + brown * 0.2 + pimple * 0.05;
      return { color, height, rough };
    },
    { normal: 5 },
  );
}

const CRUST_GOLD = rgb('#cf9247');
const CRUST_TOAST = rgb('#9c5a24');
const CRUST_FLOUR = rgb('#e6c890');
const CRUST_BROWN = rgb('#7b4219');
const CRUST_CHAR = rgb('#2b1608');

/** Noise cells around the ring and around the tube: whole numbers so the crust texture wraps both ways. */
const CRUST_PU = 72;
const CRUST_PV = 8;

/**
 * Torus-mapped crust. u runs around the ring, v around the tube: 0 is the
 * outside edge, 0.25 the top, 0.5 the inside edge against the cheese, 0.75 the
 * underside. The height map also drives the crust geometry, so the charred
 * blisters sit on real bumps.
 */
function crustTexture(seed: number) {
  const n = makeNoise(seed + 23);
  return paint(
    2048,
    256,
    (u, v) => {
      const x = u * CRUST_PU;
      const y = v * CRUST_PV;
      const top = Math.cos((v - 0.25) * Math.PI * 2); // 1 on top, -1 underneath
      const top01 = top * 0.5 + 0.5;

      const warp = n.fbm(x * 0.5 + 0.3, y * 0.5 + 0.7, 2, 0.5, CRUST_PU / 2, CRUST_PV / 2) - 0.5;
      const base = n.fbm(x * 0.25, y * 0.25, 3, 0.5, CRUST_PU / 4, CRUST_PV / 4);
      const grain = n.fbm(x * 4, y * 4, 3, 0.5, CRUST_PU * 4, CRUST_PV * 4);

      // Big air bubbles, then a scatter of small blisters.
      const big = n.cells(x * 0.5 + warp * 0.7, y * 0.5 + warp * 0.7, CRUST_PU / 2, CRUST_PV / 2);
      const bigId = big.id;
      const reach = big.f1 / (0.45 + bigId * 0.35);
      const dome = clamp01(1 - reach * reach) * smoothstep(0.25, 0.4, bigId);
      const small = n.cells(x * 2 + 11.5 + warp, y * 2 + 3.5 + warp, CRUST_PU * 2, CRUST_PV * 2);
      const smallId = small.id;
      const blister = clamp01(1 - (small.f1 / 0.42) ** 2) * (smallId > 0.55 ? 1 : 0);

      // Golden, toasting toward the top; floury on the flanks.
      let color = mixRgb(CRUST_GOLD, CRUST_TOAST, clamp01(top01 * 0.9 + smoothstep(0.35, 0.7, base) * 0.5 - 0.25));
      const flour = smoothstep(0.5, 0.75, n.fbm(x * 0.75 + 9, y * 0.75 + 2, 3, 0.5, CRUST_PU * 0.75, CRUST_PV * 0.75));
      color = mixRgb(color, CRUST_FLOUR, flour * (0.12 + (1 - top01) * 0.45));
      // Bubbles brown first, and the proudest char.
      color = mixRgb(color, CRUST_BROWN, dome * smoothstep(0, 0.6, top) * 0.7);
      const char = clamp01(
        smoothstep(0.72, 1, dome + (grain - 0.5) * 0.3) * smoothstep(0.6, 0.9, bigId) * smoothstep(0.1, 0.7, top) +
          blister * smoothstep(0.8, 0.98, smallId) * smoothstep(0.2, 0.8, top) * smoothstep(0.45, 0.65, base) * 0.8,
      );
      color = mixRgb(color, CRUST_CHAR, char * 0.85);
      const shadeBy = 0.9 + grain * 0.2;
      color = [color[0] * shadeBy, color[1] * shadeBy, color[2] * shadeBy];

      const height = 0.3 + base * 0.15 + dome * 0.38 + blister * 0.12 + grain * 0.05;
      const rough = 0.82 - char * 0.2 + flour * 0.1;
      return { color, height, rough };
    },
    { normal: 4.5, wrapU: true, wrapV: true },
  );
}

/** Planar bounds of an extruded topping, shared by its UV map and its painter. */
interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
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

/**
 * Average the normals of vertices that share a position, so closed surfaces
 * built from an open grid (torus, lathe) shade without a seam.
 */
function weldNormals(geo: Geometry) {
  geo.computeNormals();
  const p = geo.position;
  const n = geo.normal;
  const sums = new Map<string, [number, number, number]>();
  const keys: string[] = [];
  for (let i = 0; i < p.length; i += 3) {
    const key = `${Math.round(p[i] * 1e5)},${Math.round(p[i + 1] * 1e5)},${Math.round(p[i + 2] * 1e5)}`;
    keys.push(key);
    const sum = sums.get(key);
    if (sum) {
      sum[0] += n[i];
      sum[1] += n[i + 1];
      sum[2] += n[i + 2];
    } else sums.set(key, [n[i], n[i + 1], n[i + 2]]);
  }
  for (let i = 0; i < p.length; i += 3) {
    const [x, y, z] = sums.get(keys[i / 3])!;
    const len = Math.hypot(x, y, z) || 1;
    n[i] = x / len;
    n[i + 1] = y / len;
    n[i + 2] = z / len;
  }
  return geo;
}

/**
 * A torus swollen unevenly like hand-stretched dough, with the painted crust
 * height map pushed into it so the bubbles are real bumps, and a flattened
 * underside so it sits on the board rather than rolling on it.
 */
function crustGeometry(seed: number, tex: Painted) {
  const n = makeNoise(seed + 41);
  const geo = torus(CRUST_RADIUS, CRUST_TUBE, 40, 256);
  const p = geo.position;
  for (let i = 0; i < geo.count; i++) {
    const t = geo.uv[i * 2]; // 0..1 around the ring
    const ring = t * Math.PI * 2;
    const cx = Math.cos(ring) * CRUST_RADIUS;
    const cy = Math.sin(ring) * CRUST_RADIUS;
    const dx = p[i * 3] - cx;
    const dy = p[i * 3 + 1] - cy;
    const dz = p[i * 3 + 2];
    // Radial component of the tube offset (positive = outside of the ring).
    const radial = dx * Math.cos(ring) + dy * Math.sin(ring);
    const tube = Math.atan2(dz, radial);
    const puff = 0.8 + n.fbm(t * 12, 2.5, 3, 0.5, 12) * 0.5;
    // Fatter on the outside edge, melting into the cheese on the inside.
    const outward = Math.cos(tube) * 0.5 + 0.5;
    const bumps = sampleHeight(tex, t, 1 - geo.uv[i * 2 + 1]) - 0.4;
    const s = puff * (0.94 + outward * 0.12) + bumps * 0.4;
    // The mesh is laid flat with geometry +z facing down.
    p[i * 3] = cx + dx * s;
    p[i * 3 + 1] = cy + dy * s;
    p[i * 3 + 2] = dz * s * (dz > 0 ? 0.5 : 1.35);
  }
  return weldNormals(geo);
}

/** Move every vertex of a geometry, then rebuild its normals. */
function deform(geo: Geometry, move: (p: { x: number; y: number; z: number }) => void) {
  const pos = geo.position;
  const p = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < pos.length; i += 3) {
    p.x = pos[i];
    p.y = pos[i + 1];
    p.z = pos[i + 2];
    move(p);
    pos[i] = p.x;
    pos[i + 1] = p.y;
    pos[i + 2] = p.z;
  }
  return geo.computeNormals();
}

/** A point of an outline in the xy plane. */
interface Point {
  x: number;
  y: number;
}

interface SlabOptions {
  /** Outline in the xy plane, winding anticlockwise and visible from `centre`. */
  outline: Point[];
  centre?: Point;
  /** Planar bounds the painted texture covers. */
  bounds: Bounds;
  /** Height of the top face. `edge` runs from 0 at the centre to 1 on the outline. */
  top: (x: number, y: number, edge: number) => number;
  /** Where the rings of inside vertices sit, as fractions of the way out. Must end at 1. */
  rings?: number[];
}

/**
 * A solid slice filling an outline: a top face with vertices inside it so it
 * can be bent, a wall down to z = 0 and a flat underside. The top and wall
 * share their edge, so a top that dips toward the outline reads as a rounded
 * rim. UVs are planar, so the wall picks up the colour of the outline.
 */
function slab({ outline, centre = { x: 0, y: 0 }, bounds: b, top, rings = [0.3, 0.6, 0.82, 0.94, 1] }: SlabOptions) {
  const n = outline.length;
  const positions: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  const push = (x: number, y: number, z: number) => {
    positions.push(x, y, z);
    uvs.push((x - b.minX) / (b.maxX - b.minX), (y - b.minY) / (b.maxY - b.minY));
    return positions.length / 3 - 1;
  };

  // Top face: a fan around the centre, then rings out to the outline.
  push(centre.x, centre.y, top(centre.x, centre.y, 0));
  for (const f of rings) {
    for (const p of outline) {
      const x = centre.x + (p.x - centre.x) * f;
      const y = centre.y + (p.y - centre.y) * f;
      push(x, y, top(x, y, f));
    }
  }
  for (let i = 0; i < n; i++) index.push(0, 1 + i, 1 + ((i + 1) % n));
  for (let j = 1; j < rings.length; j++) {
    for (let i = 0; i < n; i++) {
      const a = 1 + (j - 1) * n + i;
      const a2 = 1 + (j - 1) * n + ((i + 1) % n);
      index.push(a, a + n, a2 + n, a, a2 + n, a2);
    }
  }

  // Wall from the top's outer ring down to the underside, then the underside itself.
  const rim = 1 + (rings.length - 1) * n;
  const foot = positions.length / 3;
  for (const p of outline) push(p.x, p.y, 0);
  for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n;
    index.push(rim + i, foot + i, foot + i2, rim + i, foot + i2, rim + i2);
  }
  const under = push(centre.x, centre.y, 0);
  for (let i = 0; i < n; i++) index.push(under, foot + ((i + 1) % n), foot + i);

  return geometryFrom(positions, uvs, index);
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
function displaceRing(geo: Geometry, tex: ReturnType<typeof paint>) {
  for (let i = 0; i < geo.count; i++) {
    // Canvas rows run top-down, texture v runs bottom-up.
    geo.position[i * 3 + 2] = cheeseHeight(sampleHeight(tex, geo.uv[i * 2], 1 - geo.uv[i * 2 + 1]));
  }
  return geo.computeNormals();
}

/* ------------------------------------------------------------------ */
/* Photographed toppings                                               */
/* ------------------------------------------------------------------ */

type Kind = keyof ToppingCounts;

/** One topping cut out of a photo: its outline as radii from the tile centre, as fractions of the tile. */
interface PhotoCutout {
  /** Clockwise from 3 o'clock in the image. */
  outer: number[];
  /** The hole of a ring-shaped slice, if it has one. */
  inner: number[] | null;
}

/** All the cut-outs of one topping, packed side by side into one texture. */
interface PhotoSheet {
  texture: WebGLTexture;
  normalMap: WebGLTexture;
  cutouts: PhotoCutout[];
}
type PhotoSet = Partial<Record<Kind, PhotoSheet>>;

/** How far a cut-out's widest point sits from its tile centre. Must match tools/cutout.mjs. */
const PHOTO_FILL = 0.46;

interface PhotoLook {
  /** World distance from the model's centre to the cut-out's widest point. */
  radius: number;
  thick: number;
  rough: number;
  clearcoat: number;
  /** Multiplies the photo's colour. The photos were lit when taken, so most are darkened a little to stop the scene's light washing them out. */
  tint: string;
  /** Strength of the relief faked from the photo's brightness. Low for glossy things, whose highlights would read as bumps. */
  relief: number;
  /** Strength of the fine grain laid over the photo. */
  grain: number;
  /** Edges lifting like a shallow cup. */
  cup: number;
  /** Ripples around the rim. */
  wave: number;
  /** Uneven buckling all over. */
  buckle: number;
  /** For leaves: how far the two halves lift either side of the midrib. */
  fold: number;
}

/** Real-world shape and finish of each photographed topping: the photo only gives its outline and colour. */
const PHOTO_LOOK: Record<Kind, PhotoLook> = {
  pepperoni: { radius: 0.07, thick: 0.0055, rough: 0.42, clearcoat: 0.3, tint: '#d2d2d2', relief: 1, grain: 2, cup: 0.004, wave: 0.002, buckle: 0.002, fold: 0 },
  mushroom: { radius: 0.062, thick: 0.009, rough: 0.5, clearcoat: 0, tint: '#d2d2d2', relief: 1, grain: 2, cup: 0.002, wave: 0.002, buckle: 0.004, fold: 0 },
  // Fresh basil goes on after the oven: bright, smooth, creased down the middle.
  basil: { radius: 0.095, thick: 0.0018, rough: 0.5, clearcoat: 0, tint: '#f4f4f4', relief: 0.7, grain: 0.5, cup: 0.002, wave: 0.004, buckle: 0.005, fold: 0.007 },
  // Baked olive slices: matt black flesh with a soft wet sheen, not a mirror gloss.
  olive: { radius: 0.05, thick: 0.009, rough: 0.4, clearcoat: 0.25, tint: '#d8d8d8', relief: 0.8, grain: 1, cup: 0, wave: 0.001, buckle: 0.001, fold: 0 },
  jalapeno: { radius: 0.05, thick: 0.007, rough: 0.36, clearcoat: 0.3, tint: '#d2d2d2', relief: 1, grain: 2, cup: 0, wave: 0.001, buckle: 0, fold: 0 },
  ham: { radius: 0.066, thick: 0.004, rough: 0.5, clearcoat: 0, tint: '#d2d2d2', relief: 1, grain: 2, cup: 0.004, wave: 0.004, buckle: 0.008, fold: 0 },
};

/** Fetch every topping atlas listed in the manifest. A topping whose atlas fails to load is left off the pizza. */
async function loadPhotos(gl: GL): Promise<PhotoSet> {
  const set: PhotoSet = {};
  const sheets = photoManifest.toppings as Partial<Record<Kind, { file: string; cutouts: PhotoCutout[] }>>;
  await Promise.all(
    (Object.keys(sheets) as Kind[]).map(async (kind) => {
      const sheet = sheets[kind]!;
      try {
        const image = await loadImage(sheet.file);
        set[kind] = {
          texture: createTexture(gl, image, { srgb: true, anisotropy: 8 }),
          normalMap: createTexture(gl, photoNormals(image), { anisotropy: 8 }),
          cutouts: sheet.cutouts,
        };
      } catch {
        // Leave this kind off the pizza.
      }
    }),
  );
  return set;
}

/**
 * Photographs for the base of the pizza, made by tools/cutout.mjs. Either is
 * null when it is missing, and the painted version is used on its own.
 */
interface BasePhotos {
  /** The crust unwrapped around the ring. */
  crust: WebGLTexture | null;
  /** A close-up of melted cheese, tiled over the painted cheese to give it a real surface. */
  cheeseDetail: WebGLTexture | null;
}

async function loadBasePhotos(gl: GL): Promise<BasePhotos> {
  const files = photoManifest as { crust: string | null; cheeseDetail: string | null };
  const load = (file: string | null, options: TextureOptions) =>
    file
      ? loadImage(file)
          .then((image) => createTexture(gl, image, { srgb: true, anisotropy: 8, ...options }))
          .catch(() => null)
      : null;
  const crust = load(files.crust, { wrap: 'repeat' });
  // Mirrored, so the photo meets itself at every repeat and no seam shows.
  const cheeseDetail = load(files.cheeseDetail, { wrap: 'mirror' });
  return { crust: await crust, cheeseDetail: await cheeseDetail };
}

/** A photo has no depth, so fake some: treat brightness as height. Read at half size, which also softens it. */
function photoNormals(image: HTMLImageElement, strength = 2.5) {
  const w = Math.max(1, image.width >> 1);
  const h = Math.max(1, image.height >> 1);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const heights = new Float32Array(w * h);
  for (let i = 0; i < heights.length; i++) {
    heights[i] = (data[i * 4] * 0.3 + data[i * 4 + 1] * 0.59 + data[i * 4 + 2] * 0.11) / 255;
  }
  return normalCanvas(heights, w, h, strength, false, false);
}

/**
 * A ring-shaped slice (olive, jalapeño) between an inner and an outer outline,
 * which must have the same number of points at the same angles, anticlockwise.
 * Rounded over the top, with a wall down into the hole and one down the outside.
 */
function ringSlab(outer: Point[], inner: Point[], b: Bounds, thick: number) {
  const n = outer.length;
  // Across the ring from the foot of the inner wall to the foot of the outer: [position, height].
  const profile = [
    [0, 0],
    [0, 0.55],
    [0.12, 0.9],
    [0.3, 1],
    [0.5, 1],
    [0.7, 1],
    [0.88, 0.9],
    [1, 0.55],
    [1, 0],
  ];
  const positions: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  for (const [t, z] of profile) {
    for (let k = 0; k < n; k++) {
      const x = mix(inner[k].x, outer[k].x, t);
      const y = mix(inner[k].y, outer[k].y, t);
      positions.push(x, y, z * thick);
      uvs.push((x - b.minX) / (b.maxX - b.minX), (y - b.minY) / (b.maxY - b.minY));
    }
  }
  for (let r = 0; r < profile.length - 1; r++) {
    for (let k = 0; k < n; k++) {
      const a = r * n + k;
      const a2 = r * n + ((k + 1) % n);
      index.push(a, a + n, a2 + n, a, a2 + n, a2);
    }
  }
  return geometryFrom(positions, uvs, index);
}

/**
 * Model for one photo cut-out: a slice with the photo's outline, mapped to its
 * tile of the atlas, then bent a little so it isn't a flat sticker.
 */
function photoGeometry(kind: Kind, cut: PhotoCutout, tile: number, tiles: number, seed: number) {
  const look = PHOTO_LOOK[kind];
  const widest = Math.max(...cut.outer);
  const W = look.radius / PHOTO_FILL; // world width of the whole tile
  const b: Bounds = { minX: -W / 2, maxX: W / 2, minY: -W / 2, maxY: W / 2 };
  const n = cut.outer.length;
  // Image y runs down and the model's runs up, which also flips the winding: walk the ring backwards.
  const ring = (radii: number[]) =>
    Array.from({ length: n }, (_, i) => {
      const k = (n - i) % n;
      const a = (k / n) * Math.PI * 2;
      return { x: Math.cos(a) * radii[k] * W, y: -Math.sin(a) * radii[k] * W };
    });
  const geo = cut.inner
    ? ringSlab(ring(cut.outer), ring(cut.inner), b, look.thick)
    : slab({
        outline: ring(cut.outer),
        bounds: b,
        top: (_x, _y, edge) => look.thick * (1 - 0.55 * smoothstep(0.8, 1, edge) ** 2),
      });
  for (let i = 0; i < geo.count; i++) geo.uv[i * 2] = (tile + geo.uv[i * 2]) / tiles;

  const rng = mulberry32(seed + tile * 31);
  const p2 = rng() * Math.PI * 2;
  const p3 = rng() * Math.PI * 2;
  const noise = makeNoise(seed + 211 + tile, 64);
  const reach = widest * W;
  // A leaf's long axis runs through its widest point (tip or stem), in model space.
  const longest = cut.outer.indexOf(widest);
  const axis = -(longest / n) * Math.PI * 2;
  return deform(geo, (p) => {
    const rr = Math.hypot(p.x, p.y) / reach;
    const a = Math.atan2(p.y, p.x);
    const across = Math.abs(-p.x * Math.sin(axis) + p.y * Math.cos(axis)) / (reach * 0.45);
    p.z +=
      look.fold * Math.pow(Math.min(across, 1.4), 1.4) +
      look.cup * rr ** 3 +
      look.wave * (Math.sin(a * 2 + p2) + 0.6 * Math.sin(a * 3 + p3)) * rr * rr +
      look.buckle * (noise.fbm(p.x * 22 + 3, p.y * 22 + 8, 2) - 0.5);
  });
}

/* ------------------------------------------------------------------ */
/* Surface grain                                                       */
/* ------------------------------------------------------------------ */

/**
 * A small tiling texture of fine grain shared by every food material:
 * red tints the colour, green varies the roughness, blue is a height field of
 * grain and pores. The painted maps give each surface its look at arm's
 * length; this keeps them from going smooth and plasticky when the zoom
 * magnifies them.
 */
function grainMap() {
  const SIZE = 256;
  const n = makeNoise(9001);
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = (x / SIZE) * 16;
      const v = (y / SIZE) * 16;
      const tint = n.fbm(u, v, 4, 0.6, 16, 16);
      const rough = n.fbm(u + 40.5, v + 12.5, 3, 0.6, 16, 16);
      const pore = n.cells(u * 1.5, v * 1.5, 24, 24);
      const pores = smoothstep(0.05, 0.45, pore.f1);
      const height = n.fbm(u * 2 + 7.5, v * 2 + 3.5, 3, 0.55, 32, 32) * 0.6 + pores * 0.4;
      const i = (y * SIZE + x) * 4;
      img.data[i] = tint * 255;
      img.data[i + 1] = rough * 255;
      img.data[i + 2] = height * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

type Painted = ReturnType<typeof paint>;
interface PaintedSet {
  seed: number;
  cheese: Painted;
  crust: Painted;
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
  paintedCache = { seed, cheese: cheeseTexture(seed), crust: crustTexture(seed) };
  return paintedCache;
}

/** A geometry and the material it is drawn with. */
interface Part {
  geometry: Geometry;
  material: Material;
}

interface BuiltPizza {
  /** One pizza, as a handful of merged meshes. Every nesting level draws the same ones. */
  parts: Part[];
  /** One of each topping on its own, standing up, for the options panel thumbnails. */
  samples: Partial<Record<Kind, Part>>;
  /** Textures made for this pizza alone, to delete with it. */
  textures: WebGLTexture[];
}

/** Rows of vertices around the cheese, and from its hole out to its edge. */
const TOP_AROUND = 320;
const TOP_ACROSS = 80;

function buildPizza(
  config: PizzaConfig,
  gl: GL,
  photos: PhotoSet,
  basePhotos: BasePhotos,
  /** The texture of a painted canvas, uploaded once and kept until the seed changes. */
  cached: (canvas: HTMLCanvasElement, options: TextureOptions) => WebGLTexture,
): BuiltPizza {
  const crustPhoto = basePhotos.crust;
  const rng = mulberry32(config.seed);
  const painted = paintedFor(config.seed);
  const parts: Part[] = [];
  const tiled: TextureOptions = { wrap: 'repeat', anisotropy: 8 };

  // Inner pizza hole: next level is `ratio` the size, including its crust.
  const holeRadius = (CRUST_RADIUS + CRUST_TUBE) * config.ratio * 0.97;

  /* Cheese + sauce top, from the hole out under the crust. */
  const cheese = painted.cheese;
  const cheeseMaterial: Material = {
    normalMap: cached(cheese.normal, tiled),
    // The painted bubbles would sit at odds with the photographed ones.
    normalScale: basePhotos.cheeseDetail ? 0.45 : 1,
    roughMap: cached(cheese.rough, tiled),
    grain: { repeat: [30, 30], tint: 0.14, bump: 2 },
    cheese: basePhotos.cheeseDetail,
    receives: true,
  };
  // Built lying in the xy plane, then laid flat for drawing.
  const top = displaceRing(ring(holeRadius, DISC_RADIUS, TOP_AROUND, TOP_ACROSS), cheese);
  parts.push({ geometry: top.clone().transform(rotation(0, -Math.PI / 2)), material: cheeseMaterial });
  // Surface height at a point on the pizza, so toppings sit on the cheese.
  // Read back from the ring's own vertices rather than the height map, so it
  // matches the mesh that is actually drawn and toppings neither sink into it
  // nor hover over it. Laid flat, world z = -geometry y.
  const topHeights = top.position;
  const vertexHeight = (ring: number, spoke: number) => topHeights[(ring * (TOP_AROUND + 1) + spoke) * 3 + 2];
  const heightAt = (x: number, z: number) => {
    const across = clamp01((Math.hypot(x, z) - holeRadius) / (DISC_RADIUS - holeRadius)) * TOP_ACROSS;
    const around = ((Math.atan2(-z, x) / (Math.PI * 2) + 1) % 1) * TOP_AROUND;
    const j = Math.min(Math.floor(across), TOP_ACROSS - 1);
    const i = Math.min(Math.floor(around), TOP_AROUND - 1);
    const tj = across - j;
    const ti = around - i;
    return mix(
      mix(vertexHeight(j, i), vertexHeight(j, i + 1), ti),
      mix(vertexHeight(j + 1, i), vertexHeight(j + 1, i + 1), ti),
      tj,
    );
  };
  /**
   * The plane through the cheese under a topping's footprint: where a stiff
   * topping rests, and how it tilts to the local slope.
   */
  const fitAt = (x: number, z: number, footprint: number) => {
    const f = footprint * 0.7;
    const east = heightAt(x + f, z);
    const west = heightAt(x - f, z);
    const south = heightAt(x, z + f);
    const north = heightAt(x, z - f);
    const centre = heightAt(x, z);
    const mean = (east + west + south + north + centre) / 5;
    let peak = Math.max(east, west, south, north, centre);
    for (let i = 0; i < 8; i++) {
      const a = ((i + 0.5) / 8) * Math.PI * 2;
      const d = footprint * (i % 2 ? 0.4 : 0.9);
      peak = Math.max(peak, heightAt(x + Math.cos(a) * d, z + Math.sin(a) * d));
    }
    return { x, z, h: mean * 0.1 + peak * 0.9, gx: (east - west) / (2 * f), gz: (south - north) / (2 * f) };
  };

  /*
   * Toppings mark the cheese around them: a soft contact shadow, and for the
   * fatty ones a halo of orange grease. Painted onto a copy of the cheese
   * colour map so every pizza gets marks that match its own toppings.
   */
  const stains = document.createElement('canvas');
  stains.width = stains.height = cheese.width;
  const ink = stains.getContext('2d')!;
  ink.drawImage(cheese.canvas, 0, 0);
  const halo = (x: number, z: number, from: number, to: number, colour: string, alpha: number) => {
    if (alpha <= 0) return;
    const px = (v: number) => (v / (2 * DISC_RADIUS)) * stains.width;
    const cx = px(x + DISC_RADIUS);
    const cy = px(z + DISC_RADIUS);
    const g = ink.createRadialGradient(cx, cy, px(from), cx, cy, px(to));
    g.addColorStop(0, `rgba(${colour},${alpha})`);
    g.addColorStop(1, `rgba(${colour},0)`);
    ink.fillStyle = g;
    ink.beginPath();
    ink.arc(cx, cy, px(to), 0, Math.PI * 2);
    ink.fill();
  };
  const stain = (x: number, z: number, radius: number, grease: number, shadow: number) => {
    halo(x, z, radius * 0.75, radius * 1.9, '216,98,28', grease);
    halo(x, z, radius * 0.55, radius * 1.3, '64,26,8', shadow);
  };
  // The inner pizza presses a shadow into the cheese around its recess.
  halo(0, 0, holeRadius * 0.9, holeRadius * 1.45, '52,20,6', 0.6);

  /* Base body under the cheese. */
  const dough = srgb('#9d6a38');
  parts.push({
    geometry: tube(DISC_RADIUS, DISC_RADIUS - 0.01, BASE_THICKNESS, 128).transform(translation(0, -BASE_THICKNESS / 2, 0)),
    material: { color: dough, rough: 0.95 },
  });
  parts.push({
    geometry: disc(DISC_RADIUS, 128).transform(compose(translation(0, -BASE_THICKNESS, 0), rotation(0, Math.PI / 2))),
    material: { color: dough, rough: 0.95, side: 'both' },
  });

  /* Hole wall so the inner pizza sits in a little recess. */
  parts.push({
    geometry: tube(holeRadius, holeRadius, BASE_THICKNESS, 64).transform(translation(0, -BASE_THICKNESS / 2, 0)),
    material: { color: srgb('#6e3a16'), side: 'back' },
  });

  /* Crust. */
  const crustMaps = painted.crust;
  parts.push({
    geometry: crustGeometry(config.seed, crustMaps).transform(compose(translation(0, -0.012, 0), rotation(0, Math.PI / 2))),
    // The photographed crust supplies the colour; the painted maps still give it its bumps, toned down.
    material: {
      map: crustPhoto ?? cached(crustMaps.canvas, { ...tiled, srgb: true }),
      color: crustPhoto ? srgb('#e8e8e8') : undefined,
      normalMap: cached(crustMaps.normal, tiled),
      normalScale: crustPhoto ? 0.5 : 1,
      roughMap: cached(crustMaps.rough, tiled),
      grain: { repeat: [94, 10], tint: 0.22, bump: 6 },
      casts: true,
      receives: true,
    },
  });

  /* Toppings: the cut-out's outline gives the model its shape, the photo its surface. */
  const pick = <T,>(list: T[]) => list[Math.floor(rng() * list.length)];
  const models: Partial<Record<Kind, Part[]>> = {};
  for (const kind of Object.keys(photos) as Kind[]) {
    const sheet = photos[kind]!;
    const look = PHOTO_LOOK[kind];
    const tiles = sheet.cutouts.length;
    // Tile the grain by real size: a tile is this many grain widths across.
    const across = look.radius / PHOTO_FILL / 0.06;
    const material: Material = {
      map: sheet.texture,
      color: srgb(look.tint),
      normalMap: sheet.normalMap,
      normalScale: look.relief,
      rough: look.rough,
      clearcoat: look.clearcoat,
      grain: { repeat: [tiles * across, across], tint: 0.08, bump: look.grain },
      casts: true,
      receives: true,
    };
    models[kind] = sheet.cutouts.map((cut, i) => ({ geometry: photoGeometry(kind, cut, i, tiles, config.seed), material }));
  }

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

  /*
   * Toppings are baked straight into the pizza rather than placed as objects:
   * each one is moved into position, pressed onto the cheese under it vertex
   * by vertex, and then everything sharing a material is merged into a single
   * mesh. Nothing hovers, and a pizza costs a handful of draw calls instead of
   * one per topping.
   */
  const baked = new Map<Material, Geometry[]>();
  /** Models are built lying in the xy plane; stand them up so y is up. */
  const stand = rotation(0, -Math.PI / 2);

  interface Lay {
    x: number;
    z: number;
    /** Size along x, up, and along z once the model is y-up. */
    scale: [number, number, number];
    /** Small random lean, radians about x and z. */
    lean: number;
    footprint: number;
    /** 0 rests stiffly on the fitted plane, 1 follows every bump of the cheese. */
    conform: number;
  }
  /** Slices rest just proud of the cheese so the two never fight for the same depth. */
  const LIFT = 0.0006;

  const lay = (model: Part, o: Lay) => {
    const fit = fitAt(o.x, o.z, o.footprint);
    const leanX = (rng() - 0.5) * o.lean;
    const turn = rng() * Math.PI * 2;
    const leanZ = (rng() - 0.5) * o.lean;
    const m = compose(translation(o.x, 0, o.z), rotation(1, turn), rotation(0, leanX), rotation(2, leanZ), scaling(...o.scale), stand);

    const surface = (x: number, z: number) =>
      mix(fit.h + fit.gx * (x - fit.x) + fit.gz * (z - fit.z), heightAt(x, z), o.conform);
    const E = 0.004;
    const g = model.geometry.clone().transform(m);
    const p = g.position;
    const n = g.normal;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i];
      const z = p[i + 2];
      const h = surface(x, z);
      p[i + 1] += h + LIFT;
      // Adding a height field shears the model, so shear its normals to match.
      const hx = (surface(x + E, z) - h) / E;
      const hz = (surface(x, z + E) - h) / E;
      const ny = n[i + 1];
      const nx = n[i] - hx * ny;
      const nz = n[i + 2] - hz * ny;
      const len = Math.hypot(nx, ny, nz) || 1;
      n[i] = nx / len;
      n[i + 1] = ny / len;
      n[i + 2] = nz / len;
    }
    const list = baked.get(model.material);
    if (list) list.push(g);
    else baked.set(model.material, [g]);
  };

  /** Place up to the configured number of one topping. A topping whose photos failed to load is left off. */
  const scatter = (kind: Kind, footprint: number, make: (model: Part, x: number, z: number) => void) => {
    const variants = models[kind];
    if (!variants) return;
    for (let i = 0; i < config.toppings[kind]; i++) {
      const pos = place(footprint);
      if (pos) make(pick(variants), pos.x, pos.z);
    }
  };

  scatter('pepperoni', 0.07, (model, x, z) => {
    const s = 0.8 + rng() * 0.45;
    lay(model, {
      x,
      z,
      scale: [s, 0.85 + rng() * 0.35, s * (0.92 + rng() * 0.16)],
      lean: 0.06,
      footprint: 0.066 * s,
      conform: 0.85,
    });
    stain(x, z, 0.068 * s, 0.5, 0.5);
  });
  scatter('mushroom', 0.075, (model, x, z) => {
    const s = 0.66 + rng() * 0.3;
    lay(model, { x, z, scale: [s, s, s], lean: 0.12, footprint: 0.05 * s, conform: 0.5 });
    stain(x, z, 0.056 * s, 0.12, 0.45);
  });
  scatter('basil', 0.07, (model, x, z) => {
    const s = 0.75 + rng() * 0.35;
    lay(model, {
      x,
      z,
      scale: [s * (0.85 + rng() * 0.3), s * (0.7 + rng() * 0.8), s],
      lean: 0.1,
      footprint: 0.05 * s,
      conform: 0.75,
    });
    stain(x, z, 0.05 * s, 0, 0.4);
  });
  scatter('olive', 0.045, (model, x, z) => {
    const s = 0.85 + rng() * 0.3;
    lay(model, { x, z, scale: [s * (0.9 + rng() * 0.2), 1, s], lean: 0.16, footprint: 0.04 * s, conform: 0.35 });
    stain(x, z, 0.04 * s, 0.15, 0.5);
  });
  scatter('jalapeno', 0.055, (model, x, z) => {
    const s = 0.8 + rng() * 0.35;
    lay(model, { x, z, scale: [s, 1, s], lean: 0.14, footprint: 0.05 * s, conform: 0.4 });
    stain(x, z, 0.05 * s, 0.1, 0.45);
  });
  scatter('ham', 0.065, (model, x, z) => {
    const s = 0.75 + rng() * 0.4;
    lay(model, { x, z, scale: [s, s, s], lean: 0.08, footprint: 0.055 * s, conform: 0.9 });
    stain(x, z, 0.056 * s, 0.25, 0.45);
  });

  for (const [material, geometries] of baked) parts.push({ geometry: merge(geometries), material });

  const samples: BuiltPizza['samples'] = {};
  for (const kind of Object.keys(models) as Kind[]) {
    const model = models[kind]![0];
    samples[kind] = { geometry: model.geometry.clone().transform(stand), material: model.material };
  }

  // The cheese is drawn with the stained copy of its colour map.
  cheeseMaterial.map = createTexture(gl, stains, { srgb: true, anisotropy: 8 });

  return { parts, samples, textures: [cheeseMaterial.map] };
}

/* ------------------------------------------------------------------ */
/* Scene                                                               */
/* ------------------------------------------------------------------ */

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** A camera `distance` from the middle of the pizza, raised `elevation` degrees above its surface. */
function cameraAt(fov: number, aspect: number, elevation: number, distance: number): View {
  const eye: Vec3 = [0, Math.sin(radians(elevation)) * distance, Math.cos(radians(elevation)) * distance];
  return { projection: perspective(fov, aspect, 0.05, 200), view: lookAt(eye, [0, 0, 0]), eye };
}

export async function createPizza(
  canvas: HTMLCanvasElement,
  initial: Partial<PizzaConfig> = {},
  onProgress: ProgressCallback = () => {},
): Promise<PizzaController> {
  const config: PizzaConfig = { ...defaultConfig, ...initial, toppings: { ...defaultConfig.toppings, ...initial.toppings } };

  const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
  if (!gl) throw new Error('This browser cannot draw the pizza: it has no WebGL2.');
  const pixelRatio = Math.min(window.devicePixelRatio, 2);
  const renderer = createRenderer(gl);
  renderer.setGrain(createTexture(gl, grainMap(), { wrap: 'repeat', anisotropy: 4 }));

  /* What is drawn each frame: every mesh of the pizza once per nesting level, and from where. */
  let items: Item[] = [];
  let view = cameraAt(config.fov, 1, config.elevation, 2.9);
  const drawScene = (target: Target | null) => renderer.render(items, view, target, { shadows: config.shadows });

  /* Look transitions: keep the frame from before a change, then wipe from it to the live result. */
  const transition = createTransition(gl);
  let before: Target | null = null;
  let live: Target | null = null;

  const makePipeline = () => createPipeline({ gl, effect: config.effect, pixelSize: config.pixelSize, drawScene });
  let pipeline: EffectPipeline = makePipeline();
  const rebuildPipeline = () => {
    pipeline.dispose();
    pipeline = makePipeline();
    pipeline.setSize(canvas.width, canvas.height);
  };

  /** Run `change` with a wipe from the frame before it to the frames after. */
  function withTransition(change: () => void, duration = 700) {
    before ??= createTarget(gl!, 'image', canvas.width, canvas.height);
    pipeline.render(before, elapsed);
    change();
    transition.begin(performance.now(), duration);
  }

  /* Pizza */
  let meshes: Mesh[] = [];
  let ownTextures: WebGLTexture[] = [];
  let samples: BuiltPizza['samples'] = {};
  const painted = new Map<HTMLCanvasElement, WebGLTexture>();
  let paintedSeed = config.seed;
  const cached = (source: HTMLCanvasElement, options: TextureOptions) => {
    let texture = painted.get(source);
    if (!texture) painted.set(source, (texture = createTexture(gl, source, options)));
    return texture;
  };

  function rebuild() {
    meshes.forEach((mesh) => mesh.free());
    ownTextures.forEach((texture) => gl!.deleteTexture(texture));
    if (paintedSeed !== config.seed) {
      // A new seed repaints the base, so the old paintings' textures go.
      painted.forEach((texture) => gl!.deleteTexture(texture));
      painted.clear();
      paintedSeed = config.seed;
    }
    const built = buildPizza(config, gl!, photos, base, cached);
    meshes = built.parts.map((part) => renderer.upload(part.geometry, part.material));
    ownTextures = built.textures;
    samples = built.samples;
  }

  // Start the downloads first, so they arrive while the base is being painted.
  const loading = Promise.all([loadPhotos(gl), loadBasePhotos(gl), loadImage('/pizza/env.png')]);
  await prepaint(config.seed, onProgress);
  const [photos, base, studio] = await loading;
  renderer.setEnvironment(studio);
  rebuild();

  /* Camera framing */
  function aim() {
    const aspect = canvas.width / canvas.height;
    // Keep the pizza filling the viewport: back off on portrait screens and narrow lenses.
    const distance = (aspect < 1 ? 2.9 / Math.max(aspect, 0.5) : 2.9) * (42 / config.fov);
    view = cameraAt(config.fov, aspect, Math.min(Math.max(config.elevation, 10), 89.9), distance);
  }
  function resize() {
    canvas.width = Math.floor(window.innerWidth * pixelRatio);
    canvas.height = Math.floor(window.innerHeight * pixelRatio);
    pipeline.setSize(canvas.width, canvas.height);
    deleteTarget(before);
    deleteTarget(live);
    before = live = null;
    aim();
  }
  resize();
  window.addEventListener('resize', resize);

  /* Animation */
  let phase = 0; // 0..1 progress through one zoom cycle
  let spin = 0; // accumulated rotation of the whole stack, radians
  let last = performance.now();
  let elapsed = 0;
  let raf = 0;

  /** Work out where every level of the stack sits for the current phase and spin. */
  function pose() {
    // Level 1 fills the frame at phase 0 and level 2 at phase 1.
    const k = config.ratio;
    const scale = Math.pow(k, -(1 + phase));
    // Each level sits LEVEL_DROP below its parent, so level n is at
    // LEVEL_DROP * (1 - k^n) / (1 - k) in the stack's own space. Lift the stack so the
    // level currently in focus (n = 1 + phase) always sits at the origin,
    // otherwise the stack drifts down over a cycle and snaps back on reset.
    const lift = (-scale * LEVEL_DROP * (1 - Math.pow(k, 1 + phase))) / (1 - k);
    // Each level sits just inside its parent's recess, `ratio` its size.
    const nest = compose(translation(0, LEVEL_DROP, 0), rotation(1, phase * config.innerSpinTurns * Math.PI * 2), scaling(k));
    const levels: Mat4[] = [compose(translation(0, lift, 0), rotation(1, spin), scaling(scale))];
    for (let i = 1; i < config.levels; i++) levels.push(multiply(levels[i - 1], nest));
    items = meshes.flatMap((mesh) => levels.map((matrix) => ({ mesh, matrix })));
  }

  function draw() {
    pose();
    if (transition.running && before) {
      live ??= createTarget(gl!, 'image', canvas.width, canvas.height);
      pipeline.render(live, elapsed);
      transition.draw(live, before, null);
    } else pipeline.render(null, elapsed);
  }

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

    if (import.meta.env.DEV) {
      // Development only: hold the animation at a chosen moment, to compare frames.
      const seek = (window as unknown as { __seek?: { phase: number; spin: number } }).__seek;
      if (seek) ({ phase, spin } = seek);
    }

    transition.tick(now);
    draw();
  }
  // Draw once before the reveal, so the first frame is already on the canvas.
  onProgress('Into the oven', 2 / 3);
  await breathe();
  draw();
  onProgress('Ready', 1);

  raf = requestAnimationFrame(frame);

  /** A target's picture as a PNG data URL. */
  function targetToDataUrl(target: Target) {
    const { width, height } = target;
    const pixels = renderer.read(target);
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const ctx = out.getContext('2d')!;
    const image = ctx.createImageData(width, height);
    const row = width * 4;
    // GL's rows run bottom-up.
    for (let y = 0; y < height; y++) image.data.set(pixels.subarray(y * row, (y + 1) * row), (height - 1 - y) * row);
    // Smoothed edges come back with their colour already faded by their coverage; a PNG wants it unfaded.
    for (let i = 0; i < image.data.length; i += 4) {
      const alpha = image.data[i + 3];
      if (alpha > 0 && alpha < 255) for (let c = 0; c < 3; c++) image.data[i + c] = Math.min(255, (image.data[i + c] * 255) / alpha);
    }
    ctx.putImageData(image, 0, 0);
    return out.toDataURL('image/png');
  }

  async function renderPreviews(size = 96): Promise<Previews> {
    const looks = {} as Record<EffectName, string>;
    const toppings = {} as Record<keyof ToppingCounts, string>;

    // Every look, drawn from the live pizza with a fixed, flattering camera so the tiles match whatever angle the page is at.
    const tile = cameraAt(42, 1, 50, 2.9);
    const picture = createTarget(gl!, 'image', size, size);
    for (const effect of EFFECTS) {
      const p = createPipeline({
        gl: gl!,
        effect,
        pixelSize: Math.max(2, Math.round(config.pixelSize / 2)),
        drawScene: (target) => renderer.render(items, tile, target, { shadows: config.shadows }),
      });
      p.setSize(size, size);
      p.render(picture, 1.3);
      looks[effect] = targetToDataUrl(picture);
      p.dispose();
      await breathe();
    }
    deleteTarget(picture);

    // Each topping on its own against a clear background.
    const stage = createTarget(gl!, 'scene', size, size);
    const from = normalize([0.35, 1, 0.55]);
    for (const kind of Object.keys(samples) as Kind[]) {
      const { geometry, material } = samples[kind]!;
      const mesh = renderer.upload(geometry, material);
      // Frame the ball that encloses the topping's bounding box.
      const low: Vec3 = [Infinity, Infinity, Infinity];
      const high: Vec3 = [-Infinity, -Infinity, -Infinity];
      geometry.position.forEach((v, i) => {
        low[i % 3] = Math.min(low[i % 3], v);
        high[i % 3] = Math.max(high[i % 3], v);
      });
      const centre = low.map((v, i) => (v + high[i]) / 2) as Vec3;
      const radius = Math.hypot(high[0] - low[0], high[1] - low[1], high[2] - low[2]) / 2;
      const distance = (radius * 1.15) / Math.sin(radians(14));
      const eye = centre.map((v, i) => v + from[i] * distance) as Vec3;
      renderer.render([{ mesh, matrix: identity() }], { projection: perspective(28, 1, 0.01, 10), view: lookAt(eye, centre), eye }, stage, {
        stage: true,
      });
      toppings[kind] = targetToDataUrl(stage);
      mesh.free();
      await breathe();
    }
    deleteTarget(stage);

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
        if (patch.elevation !== undefined || patch.fov !== undefined) aim();
        if (needsRebuild) rebuild();
      };

      // Wipe between looks and between shuffled pizzas; everything else changes live.
      if (lookChanged || seedChanged) withTransition(apply, lookChanged ? 700 : 500);
      else apply();
    },
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      // Dropping the context frees everything made with it.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
