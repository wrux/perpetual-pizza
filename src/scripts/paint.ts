/**
 * Paints the base of the pizza, pixel by pixel: the cheese and sauce, and the
 * crust. It is slow work that needs nothing from the page, so it runs in
 * workers (paint.worker.ts) while the photographs download.
 */

/* ------------------------------------------------------------------ */
/* Random + noise                                                      */
/* ------------------------------------------------------------------ */

type Rng = () => number;

export function mulberry32(seed: number): Rng {
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
export function makeNoise(seed: number, period = 256) {
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

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;

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
 * Tangent-space normal map of a height field, as RGBA bytes. Unlike a bump map this is
 * filtered like any other texture, so it stays smooth when magnified.
 */
export function normalMap(heights: Float32Array, w: number, h: number, strength: number, wrapU: boolean, wrapV: boolean) {
  const normal = new Uint8ClampedArray(w * h * 4);
  const edge = (i: number, n: number, wraps: boolean) => (wraps ? (i + n) % n : Math.min(Math.max(i, 0), n - 1));
  for (let y = 0; y < h; y++) {
    const up = edge(y - 1, h, wrapV) * w;
    const down = edge(y + 1, h, wrapV) * w;
    for (let x = 0; x < w; x++) {
      const dx = (heights[y * w + edge(x + 1, w, wrapU)] - heights[y * w + edge(x - 1, w, wrapU)]) * strength;
      // Image rows run top-down, texture v runs bottom-up.
      const dy = (heights[down + x] - heights[up + x]) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * w + x) * 4;
      normal[i] = (-dx * inv * 0.5 + 0.5) * 255;
      normal[i + 1] = (dy * inv * 0.5 + 0.5) * 255;
      normal[i + 2] = (inv * 0.5 + 0.5) * 255;
      normal[i + 3] = 255;
    }
  }
  return normal;
}

/** A painted surface: colour, normal and roughness as RGBA bytes, row by row from the top, plus its height field. */
export interface Maps {
  color: Uint8ClampedArray;
  normal: Uint8ClampedArray;
  rough: Uint8ClampedArray;
  heightData: Float32Array;
  width: number;
  height: number;
}

/** Per-pixel painter producing colour, normal and roughness maps. */
function paint(
  w: number,
  h: number,
  shade: (u: number, v: number) => { color: Rgb; height?: number; rough?: number },
  { normal: strength = 2, wrapU = false, wrapV = false }: PaintOptions = {},
): Maps {
  const color = new Uint8ClampedArray(w * h * 4);
  const rough = new Uint8ClampedArray(w * h * 4);
  const heightData = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const s = shade(x / w, y / h);
      color[i] = s.color[0];
      color[i + 1] = s.color[1];
      color[i + 2] = s.color[2];
      heightData[y * w + x] = clamp01(s.height ?? 0.5);
      rough[i] = rough[i + 1] = rough[i + 2] = Math.round(clamp01(s.rough ?? 0.5) * 255);
      color[i + 3] = rough[i + 3] = 255;
    }
  }
  return { color, normal: normalMap(heightData, w, h, strength, wrapU, wrapV), rough, heightData, width: w, height: h };
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
 * Planar top-of-pizza texture: melted mozzarella over tomato sauce. The cheese
 * stops short of the crust, thins to orange where the sauce shows through, and
 * blisters into bubbles whose tops brown.
 *
 * With a photographed cheese surface laid over it (`PHOTO_CHEESE`), the
 * painting only needs to say where the cheese is and how thick: the photo
 * brings its own browning and flecks, and two sets would fight.
 */
export function cheeseTexture(seed: number, PHOTO_CHEESE: boolean) {
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
export function crustTexture(seed: number) {
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
