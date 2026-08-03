// Generates the PWA icons with no image tooling — just zlib and pixel maths.
// Run once with `npm run icons`; the PNGs are committed alongside the app.
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixel) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5);
      const i = rowStart + 1 + x * 4;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Signed distance to a rounded rectangle centred on (cx, cy). */
function roundedRect(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - (hx - r);
  const qy = Math.abs(py - cy) - (hy - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

const BG = [15, 17, 21];
const FG = [255, 255, 255];

/** A banknote outline with a coin in the middle. `mark` scales the glyph. */
function makeIcon(size, mark) {
  const s = size / 512;
  const c = size / 2;
  const aa = 0.8;

  return (x, y) => {
    const px = (x - c) / mark + c;
    const py = (y - c) / mark + c;

    const stroke = 22 * s;
    const d = roundedRect(px, py, c, c, 168 * s, 96 * s, 26 * s);
    const outline = 1 - smoothstep(stroke / 2 - aa, stroke / 2 + aa, Math.abs(d));
    const coin = 1 - smoothstep(40 * s - aa, 40 * s + aa, Math.hypot(px - c, py - c));

    const a = clamp01(Math.max(outline, coin));
    return [
      Math.round(BG[0] + (FG[0] - BG[0]) * a),
      Math.round(BG[1] + (FG[1] - BG[1]) * a),
      Math.round(BG[2] + (FG[2] - BG[2]) * a),
      255,
    ];
  };
}

fs.mkdirSync(OUT, { recursive: true });

const targets = [
  ['icon-512.png', 512, 1],
  ['icon-192.png', 192, 1],
  ['icon-180.png', 180, 1],
  ['icon-maskable-512.png', 512, 0.72], // shrunk into the maskable safe zone
];

for (const [file, size, mark] of targets) {
  fs.writeFileSync(path.join(OUT, file), encodePng(size, makeIcon(size, mark)));
  console.log('wrote', file, `${size}x${size}`);
}
