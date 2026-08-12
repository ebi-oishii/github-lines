/* Generates the toolbar icons — three stacked bars, longest one red, which is
   the same visual language the extension uses on the page.

   Written by hand rather than pulled from a dependency so the repo stays
   build-free: `node scripts/make-icons.mjs` and you are done.

   Usage: node scripts/make-icons.mjs
*/
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const SIZES = [16, 32, 48, 128];
const SS = 4; // supersampling factor, for antialiased edges

/* ------------------------------------------------------------------- PNG */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------------------------------------------------------- drawing */

function fillRoundRect(buf, W, x0, y0, w, h, r, [cr, cg, cb]) {
  const x1 = x0 + w;
  const y1 = y0 + h;
  r = Math.min(r, w / 2, h / 2);
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      // Distance test only near the corners.
      const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
      const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      const i = (y * W + x) * 4;
      buf[i] = cr; buf[i + 1] = cg; buf[i + 2] = cb; buf[i + 3] = 255;
    }
  }
}

function downsample(src, W, H, factor) {
  const w = W / factor;
  const h = H / factor;
  const out = Buffer.alloc(w * h * 4);
  const n = factor * factor;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const i = ((y * factor + dy) * W + (x * factor + dx)) * 4;
          const alpha = src[i + 3];
          // Premultiply so transparent pixels do not darken the edges.
          r += src[i] * alpha; g += src[i + 1] * alpha; b += src[i + 2] * alpha;
          a += alpha;
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

const BARS = [
  { width: 1.0, color: [248, 81, 73] },   // danger red — the bloated file
  { width: 0.6, color: [210, 153, 34] },  // warn amber
  { width: 0.34, color: [88, 166, 255] }, // ok blue
];

function renderIcon(size) {
  const W = size * SS;
  const H = size * SS;
  const buf = Buffer.alloc(W * H * 4, 0);

  const pad = Math.round(W * 0.13);
  const inner = W - pad * 2;
  const barH = Math.round(H * 0.185);
  const gap = Math.round((H - pad * 2 - barH * 3) / 2);

  let y = pad;
  for (const bar of BARS) {
    const w = Math.max(barH, Math.round(inner * bar.width));
    fillRoundRect(buf, W, pad, y, w, barH, barH / 2, bar.color);
    y += barH + gap;
  }

  return encodePng(size, size, downsample(buf, W, H, SS));
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(file, renderIcon(size));
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
