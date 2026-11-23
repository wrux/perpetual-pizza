// Cuts individual toppings out of overhead pizza photos and packs them into one
// texture atlas per topping, plus a manifest of each cut-out's outline for the
// 3D models to follow.
//
//   node tools/cutout.mjs            build atlases + manifest
//   node tools/cutout.mjs --debug    also write outline previews to tools/debug/
//
// Each entry in tools/cutouts.json marks one topping in a source photo: its
// centre and rough radius in pixels. The outline is found by walking outward
// from the centre until the colour stops looking like the topping and starts
// looking like what surrounds it. Round toppings are more reliably marked by
// hand: "ellipse": [rx, ry, degrees] (fractions of r) sets the outline, and
// "holeEllipse" the hole of a ring. "squash" is the photo's vertical
// foreshortening (1 = shot from directly overhead), which is stretched back out.
// Irregular toppings that the colour walk gets wrong can be traced instead:
// "polygon": [[x, y], ...] in photo pixels, in which case cx / cy / r are derived.
// "holePolygon" traces the hole of a ring the same way; it must contain the centre.

import sharp from 'sharp';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = 384; // working resolution of the square around a topping
const REACH = 1.6; // that square spans this many radii from the centre
const TILE = 512; // atlas tile size
const FILL = 0.46; // a cut-out's widest point sits this far from its tile centre
const RAYS = 64;
/** How the textures are stored: AVIF is about half the size of WebP at the same quality. */
const AVIF = { quality: 50, effort: 6 };
const debug = process.argv.includes('--debug');

const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1];
};

/**
 * Colour model of a set of pixels as a few clusters (k-means), since a topping
 * or its surroundings is rarely one colour: a mushroom is pale flesh and dark gills.
 */
function model(samples, k = 3) {
  let centres = Array.from({ length: k }, (_, i) => samples[Math.floor(((i + 0.5) / k) * samples.length)]);
  let groups = [];
  for (let round = 0; round < 10; round++) {
    groups = centres.map(() => []);
    for (const s of samples) {
      let best = 0;
      let bestD = Infinity;
      centres.forEach((c, i) => {
        const d = (s[0] - c[0]) ** 2 + (s[1] - c[1]) ** 2 + (s[2] - c[2]) ** 2;
        if (d < bestD) [best, bestD] = [i, d];
      });
      groups[best].push(s);
    }
    centres = groups.map((g, i) => (g.length ? [0, 1, 2].map((c) => g.reduce((sum, s) => sum + s[c], 0) / g.length) : centres[i]));
  }
  return centres
    .map((centre, i) => ({
      centre,
      spread: [0, 1, 2].map((c) => Math.sqrt(groups[i].reduce((sum, s) => sum + (s[c] - centre[c]) ** 2, 0) / Math.max(groups[i].length, 1)) + 10),
      share: groups[i].length / samples.length,
    }))
    .filter((cluster) => cluster.share > 0.06);
}
const distance = (clusters, px) => Math.min(...clusters.map(({ centre, spread }) => Math.hypot(...centre.map((mid, c) => (px[c] - mid) / spread[c]))));

/** Radii of an ellipse [rx, ry, degrees] at each ray. */
const ellipseRing = ([rx, ry, degrees = 0]) =>
  Array.from({ length: RAYS }, (_, k) => {
    const a = (k / RAYS) * Math.PI * 2 - (degrees * Math.PI) / 180;
    return (rx * ry) / Math.hypot(ry * Math.cos(a), rx * Math.sin(a));
  });

function smoothRing(values) {
  const n = values.length;
  const at = (i) => values[((i % n) + n) % n];
  const med = values.map((_, i) => median([at(i - 2), at(i - 1), at(i), at(i + 1), at(i + 2)]));
  const atM = (i) => med[((i % n) + n) % n];
  return med.map((_, i) => (atM(i - 2) + 4 * atM(i - 1) + 6 * atM(i) + 4 * atM(i + 1) + atM(i + 2)) / 16);
}

/** Round off a hand-traced polygon: a closed Catmull-Rom curve through its points. */
function smoothPolygon(points, steps = 6) {
  const n = points.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [points[(i + n - 1) % n], points[i], points[(i + 1) % n], points[(i + 2) % n]];
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      out.push(
        [0, 1].map(
          (c) =>
            0.5 *
            (2 * p1[c] + (p2[c] - p0[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t * t + (3 * p1[c] - p0[c] - 3 * p2[c] + p3[c]) * t * t * t),
        ),
      );
    }
  }
  return out;
}

/** A region of a photo as raw RGB, padded where it runs off the edge. */
async function region(src, left, top, width, height, size) {
  const image = sharp(path.join(ROOT, 'tools/photos', src)).rotate();
  const meta = await sharp(path.join(ROOT, 'tools/photos', src)).metadata();
  const x0 = Math.max(left, 0);
  const y0 = Math.max(top, 0);
  const x1 = Math.min(left + width, meta.width);
  const y1 = Math.min(top + height, meta.height);
  // Pad in a first pass: sharp always resizes before it extends, whatever order they are called in.
  const padded = await image
    .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
    .extend({ left: x0 - left, top: y0 - top, right: left + width - x1, bottom: top + height - y1, background: '#808080' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return sharp(padded.data, { raw: { width: padded.info.width, height: padded.info.height, channels: 3 } })
    .resize(size, size, { fit: 'fill' })
    .raw()
    .toBuffer();
}

/** Distance from a point to where a ray leaves a polygon (the farthest crossing). */
function rayToPolygon(polygon, ox, oy, a) {
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  let far = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i];
    const [x2, y2] = polygon[(i + 1) % polygon.length];
    const ex = x2 - x1;
    const ey = y2 - y1;
    const det = dx * ey - dy * ex;
    if (Math.abs(det) < 1e-9) continue;
    const t = ((x1 - ox) * ey - (y1 - oy) * ex) / det;
    const u = ((x1 - ox) * dy - (y1 - oy) * dx) / det;
    if (t > 0 && u >= 0 && u <= 1) far = Math.max(far, t);
  }
  return far;
}

async function cut(entry) {
  if (entry.polygon) {
    entry.polygon = smoothPolygon(entry.polygon);
    // Centre on the middle of the traced shape's bounding box.
    const xs = entry.polygon.map((p) => p[0]);
    const ys = entry.polygon.map((p) => p[1]);
    entry.cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    entry.cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    entry.r = Math.max(...entry.polygon.map(([x, y]) => Math.hypot(x - entry.cx, y - entry.cy)));
  }
  const { src, cx, cy, r, squash = 1 } = entry;
  if (entry.holePolygon) entry.holePolygon = smoothPolygon(entry.holePolygon);
  const hole = entry.hole ?? Boolean(entry.holeEllipse || entry.holePolygon);
  let outer = [];
  let inner = [];
  const traced = (entry.polygon || entry.ellipse) && (!hole || entry.holeEllipse || entry.holePolygon);
  if (!traced) {
    const half = Math.round(r * REACH);
    const halfY = Math.round(r * REACH * squash);
    const data = await region(src, Math.round(cx - half), Math.round(cy - halfY), half * 2, halfY * 2, WORK);
    const px = (x, y) => {
      const i = (Math.min(Math.max(Math.round(y), 0), WORK - 1) * WORK + Math.min(Math.max(Math.round(x), 0), WORK - 1)) * 3;
      return [data[i], data[i + 1], data[i + 2]];
    };
    const C = WORK / 2;
    const R = WORK / 2 / REACH; // the entry's radius, in working pixels

    // Colour of the topping (sampled from its body) and of its surroundings.
    const body = hole ? [0.6, 0.85] : [0.04, entry.body ?? 0.3];
    const inside = [];
    const outside = [];
    for (let y = 0; y < WORK; y += 2) {
      for (let x = 0; x < WORK; x += 2) {
        const d = Math.hypot(x - C, y - C) / R;
        if (d > body[0] && d < body[1]) inside.push(px(x, y));
        else if (d > 1.3 && d < 1.58) outside.push(px(x, y));
        else if (hole && d < 0.2) outside.push(px(x, y));
      }
    }
    const fg = model(inside);
    const bg = model(outside);
    const score = new Float32Array(WORK * WORK);
    for (let y = 0; y < WORK; y++) for (let x = 0; x < WORK; x++) score[y * WORK + x] = distance(bg, px(x, y)) - distance(fg, px(x, y));
    // Box blur so single odd pixels don't end a walk early.
    const blurred = new Float32Array(WORK * WORK);
    const B = 3;
    for (let y = 0; y < WORK; y++) {
      for (let x = 0; x < WORK; x++) {
        let sum = 0;
        let count = 0;
        for (let j = -B; j <= B; j++) {
          for (let i = -B; i <= B; i++) {
            const xx = x + i;
            const yy = y + j;
            if (xx < 0 || yy < 0 || xx >= WORK || yy >= WORK) continue;
            sum += score[yy * WORK + xx];
            count++;
          }
        }
        blurred[y * WORK + x] = sum / count;
      }
    }
    const isTopping = (x, y) => blurred[Math.round(y) * WORK + Math.round(x)] > 0;

    for (let k = 0; k < RAYS; k++) {
      const a = (k / RAYS) * Math.PI * 2;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      const start = (hole ? 0.7 : 0.4) * R;
      let edge = start;
      let misses = 0;
      for (let d = start; d < R * 1.55; d++) {
        if (isTopping(C + dx * d, C + dy * d)) {
          edge = d;
          misses = 0;
        } else if (++misses > 4) break;
      }
      outer.push(edge / R);
      if (hole) {
        let lip = start;
        misses = 0;
        for (let d = start; d > 0; d--) {
          if (isTopping(C + dx * d, C + dy * d)) {
            lip = d;
            misses = 0;
          } else if (++misses > 3) break;
        }
        inner.push(lip / R);
      }
    }
  }
  outer = entry.ellipse ? ellipseRing(entry.ellipse) : traced ? outer : smoothRing(outer);
  if (entry.polygon) {
    outer = Array.from({ length: RAYS }, (_, k) => rayToPolygon(entry.polygon, cx, cy, (k / RAYS) * Math.PI * 2) / r);
  }
  if (entry.wobble) {
    // A torn, uneven edge for toppings cut as a patch out of a larger sheet.
    const w = entry.wobble;
    outer = outer.map((v, k) => {
      const a = (k / RAYS) * Math.PI * 2;
      return v * (1 + 0.1 * Math.sin(a * 3 + w) + 0.07 * Math.sin(a * 5 + w * 2.3) + 0.04 * Math.sin(a * 9 + w * 4.1));
    });
  }
  inner = hole ? (entry.holeEllipse ? ellipseRing(entry.holeEllipse) : smoothRing(inner)) : null;
  if (entry.holePolygon) {
    inner = Array.from({ length: RAYS }, (_, k) => rayToPolygon(entry.holePolygon, cx, cy, (k / RAYS) * Math.PI * 2) / r);
  }

  // Pull the outline in a touch so no fringe of cheese comes along.
  const INSET = entry.inset ?? 0.02;
  outer = outer.map((v) => v - INSET);
  if (inner) inner = inner.map((v) => v + INSET);

  // Re-cut at tile resolution, scaled so the widest point fills the tile.
  const widest = Math.max(...outer);
  const span = (widest * r) / FILL; // source pixels across the whole tile
  const left = Math.round(cx - span / 2);
  const top = Math.round(cy - (span * squash) / 2);
  const tile = await region(src, left, top, Math.round(span), Math.round(span * squash), TILE);
  const toTile = (v) => (v * r) / span; // radii as fractions of the tile
  const outerT = outer.map(toTile);
  const innerT = inner?.map(toTile) ?? null;
  const ringAt = (ring, a) => {
    const f = (((a / (Math.PI * 2)) % 1) + 1) % 1 * RAYS;
    const i = Math.floor(f);
    return ring[i % RAYS] + (ring[(i + 1) % RAYS] - ring[i % RAYS]) * (f - i);
  };
  // Outside the outline, repeat the colour at the edge so filtering never drags
  // in the background. Further out than filtering reaches, fill with the
  // topping's average colour instead: flat colour costs almost nothing to store.
  const MARGIN = 0.03;
  const mean = [0, 0, 0];
  let counted = 0;
  for (let y = 0; y < TILE; y += 2) {
    for (let x = 0; x < TILE; x += 2) {
      const ux = x / TILE - 0.5;
      const uy = y / TILE - 0.5;
      const d = Math.hypot(ux, uy);
      const a = Math.atan2(uy, ux);
      if (d > ringAt(outerT, a) || (innerT && d < ringAt(innerT, a))) continue;
      for (let c = 0; c < 3; c++) mean[c] += tile[(y * TILE + x) * 3 + c];
      counted++;
    }
  }
  const out = Buffer.alloc(TILE * TILE * 3);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const ux = x / TILE - 0.5;
      const uy = y / TILE - 0.5;
      const d = Math.hypot(ux, uy);
      const a = Math.atan2(uy, ux);
      let sample = d;
      let far = false;
      const max = ringAt(outerT, a) - 0.004;
      if (d > max) {
        sample = max;
        far = d > max + MARGIN;
      }
      if (innerT) {
        const min = ringAt(innerT, a) + 0.004;
        if (d < min) {
          sample = min;
          far = d < min - MARGIN;
        }
      }
      if (far) {
        for (let c = 0; c < 3; c++) out[(y * TILE + x) * 3 + c] = mean[c] / counted;
        continue;
      }
      const sx = Math.min(Math.max(Math.round((0.5 + Math.cos(a) * sample) * TILE), 0), TILE - 1);
      const sy = Math.min(Math.max(Math.round((0.5 + Math.sin(a) * sample) * TILE), 0), TILE - 1);
      const o = (y * TILE + x) * 3;
      const s = (sy * TILE + sx) * 3;
      out[o] = tile[s];
      out[o + 1] = tile[s + 1];
      out[o + 2] = tile[s + 2];
    }
  }

  let preview = null;
  if (debug) {
    const dots = [];
    for (let k = 0; k < RAYS; k++) {
      const a = (k / RAYS) * Math.PI * 2;
      for (const ring of innerT ? [outerT, innerT] : [outerT]) {
        const x = (0.5 + Math.cos(a) * ring[k]) * TILE;
        const y = (0.5 + Math.sin(a) * ring[k]) * TILE;
        dots.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="#00e5ff"/>`);
      }
    }
    preview = await sharp(tile, { raw: { width: TILE, height: TILE, channels: 3 } })
      .composite([{ input: Buffer.from(`<svg width="${TILE}" height="${TILE}" xmlns="http://www.w3.org/2000/svg">${dots.join('')}</svg>`) }])
      .png()
      .toBuffer();
  }
  const round = (v) => Number(v.toFixed(4));
  return { pixels: out, outer: outerT.map(round), inner: innerT?.map(round) ?? null, preview };
}

const config = JSON.parse(await readFile(path.join(ROOT, 'tools/cutouts.json'), 'utf8'));
const manifest = {};
await mkdir(path.join(ROOT, 'public/pizza/toppings'), { recursive: true });
if (debug) await mkdir(path.join(ROOT, 'tools/debug'), { recursive: true });

for (const [kind, entries] of Object.entries(config.toppings)) {
  if (!entries.length) continue;
  const cuts = [];
  for (const entry of entries) cuts.push(await cut(entry));
  const atlas = sharp({ create: { width: TILE * cuts.length, height: TILE, channels: 3, background: '#000' } }).composite(
    cuts.map((c, i) => ({ input: c.pixels, raw: { width: TILE, height: TILE, channels: 3 }, left: i * TILE, top: 0 })),
  );
  await atlas.avif(AVIF).toFile(path.join(ROOT, `public/pizza/toppings/${kind}.avif`));
  manifest[kind] = { file: `/pizza/toppings/${kind}.avif`, cutouts: cuts.map((c) => ({ outer: c.outer, inner: c.inner })) };
  if (debug) {
    const strip = sharp({ create: { width: TILE * cuts.length, height: TILE, channels: 3, background: '#000' } }).composite(
      cuts.map((c, i) => ({ input: c.preview, left: i * TILE, top: 0 })),
    );
    await strip.png().toFile(path.join(ROOT, `tools/debug/${kind}.png`));
  }
  console.log(`${kind}: ${cuts.length} cut-outs`);
}
// The base of the pizza can come from one overhead photo of a whole, plain
// pizza: "base": { src, cx, cy, inner, outer } gives its centre and the radii
// of the crust's inside and outside edges, in photo pixels. Real pizzas aren't
// round, so "rim": [[degrees, inner, outer], ...] can give those radii at
// several angles (clockwise from 3 o'clock), and they are blended between.
// Only the crust is taken from it; the cheese is painted.
if (config.base) {
  const { src, cx, cy, rim } = config.base;
  // Radii of the crust's edges at an angle: blended smoothly between the marked angles.
  const marks = rim ? [...rim].sort((p, q) => p[0] - q[0]) : null;
  const edges = (a) => {
    if (!marks) return [config.base.inner, config.base.outer];
    const deg = (((a * 180) / Math.PI) % 360 + 360) % 360;
    let i = marks.findIndex((m) => m[0] > deg);
    if (i < 0) i = marks.length;
    const before = marks[(i + marks.length - 1) % marks.length];
    const after = marks[i % marks.length];
    const span = (after[0] - before[0] + 360) % 360 || 360;
    const t = ((deg - before[0] + 360) % 360) / span;
    const ease = (1 - Math.cos(t * Math.PI)) / 2;
    return [before[1] + (after[1] - before[1]) * ease, before[2] + (after[2] - before[2]) * ease];
  };
  const outer = marks ? Math.max(...marks.map((m) => m[2])) : config.base.outer;

  // Crust: unwrapped into the layout the 3D crust is mapped with. u runs around
  // the ring, v around the tube it is built from (0 outside edge, 0.25 top, 0.5
  // inside edge, then the same again underneath). Seen from above, a point at
  // tube angle t sits (cos t + 1) / 2 of the way from the inside edge to the
  // outside. Sampling exactly there smears the photo down the crust's steep
  // sides, so most of the weight goes to wrapping it evenly around the tube.
  const W = 2048;
  const H = 256;
  const pad = Math.ceil(outer) + 2;
  const side = pad * 2;
  const photo = await region(src, Math.round(cx - pad), Math.round(cy - pad), side, side, side);
  const out = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    const t = (y / H) * Math.PI * 2;
    const wrapped = 1 - Math.abs(t <= Math.PI ? t : Math.PI * 2 - t) / Math.PI;
    const across = ((Math.cos(t) + 1) / 2) * 0.25 + wrapped * 0.75;
    for (let x = 0; x < W; x++) {
      const a = (x / W) * Math.PI * 2;
      const [from, to] = edges(a);
      const r = from + (to - from) * across;
      const fx = pad + Math.cos(a) * r;
      const fy = pad + Math.sin(a) * r;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      for (let c = 0; c < 3; c++) {
        const at = (px, py) => photo[(py * side + px) * 3 + c];
        const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
        const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
        out[(y * W + x) * 3 + c] = top * (1 - ty) + bottom * ty;
      }
    }
  }
  await sharp(out, { raw: { width: W, height: H, channels: 3 } }).avif(AVIF).toFile(path.join(ROOT, 'public/pizza/toppings/crust.avif'));
  if (debug) {
    await sharp(out, { raw: { width: W, height: H, channels: 3 } }).extract({ left: 0, top: 0, width: W, height: H / 2 }).png().toFile(path.join(ROOT, 'tools/debug/crust.png'));
  }
  console.log('base: crust unwrapped');
}

// A close-up of melted cheese, tiled over the painted cheese to give it a real
// surface: "cheeseDetail": { src, left, top, size } is a square of photo pixels.
if (config.cheeseDetail) {
  const { src, left, top, size } = config.cheeseDetail;
  const DETAIL = 1024;
  const detail = await region(src, left, top, size, size, DETAIL);
  await sharp(detail, { raw: { width: DETAIL, height: DETAIL, channels: 3 } }).avif(AVIF).toFile(path.join(ROOT, 'public/pizza/toppings/cheese-detail.avif'));
  console.log('cheese detail: cropped');
}

await writeFile(
  path.join(ROOT, 'src/scripts/topping-photos.json'),
  JSON.stringify({
    crust: config.base ? '/pizza/toppings/crust.avif' : null,
    cheeseDetail: config.cheeseDetail ? '/pizza/toppings/cheese-detail.avif' : null,
    toppings: manifest,
  }) + '\n',
);
