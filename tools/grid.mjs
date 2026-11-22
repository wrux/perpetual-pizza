// Debug helper: node tools/grid.mjs <photo> [left top width height] -> tools/debug/grid-<photo>.jpg
// Writes a reduced copy of (a region of) a source photo with a labelled pixel grid, for picking cut-out centres.
import sharp from 'sharp';
const [file, l, t, w, h] = process.argv.slice(2);
const src = sharp(`tools/photos/${file}`).rotate();
const meta = await sharp(`tools/photos/${file}`).metadata();
const left = Number(l ?? 0), top = Number(t ?? 0), width = Number(w ?? meta.width), height = Number(h ?? meta.height);
const scale = 1500 / Math.max(width, height);
const W = Math.round(width * scale), H = Math.round(height * scale);
const step = [50, 100, 200, 250, 500, 1000].find((s) => width / s <= 14) ?? 1000;
let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" font-family="sans-serif" font-size="15" font-weight="bold">`;
for (let x = Math.ceil(left / step) * step; x < left + width; x += step) {
  const px = (x - left) * scale;
  svg += `<line x1="${px}" y1="0" x2="${px}" y2="${H}" stroke="#00e5ff" stroke-width="1" opacity="0.8"/><text x="${px + 3}" y="15" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke">${x}</text>`;
}
for (let y = Math.ceil(top / step) * step; y < top + height; y += step) {
  const py = (y - top) * scale;
  svg += `<line x1="0" y1="${py}" x2="${W}" y2="${py}" stroke="#00e5ff" stroke-width="1" opacity="0.8"/><text x="3" y="${py - 3}" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke">${y}</text>`;
}
svg += '</svg>';
const suffix = l === undefined ? '' : `-${left}-${top}`;
await src.extract({ left, top, width, height }).resize(W, H).composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 82 }).toFile(`tools/debug/grid-${file.replace('.jpg', '')}${suffix}.jpg`);
