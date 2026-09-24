/**
 * Generates the PWA PNG icons from scratch - no image libraries, just zlib.
 *
 * Run with:  node tools/make-icons.mjs
 * Only needed if you change the icon design; the PNGs are committed.
 */

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'icons');

const BG = [21, 26, 34];       // --bg-2
const TRACK = [38, 47, 59];    // --line
const ACCENT = [76, 194, 255]; // --accent
const SWEEP_START = -Math.PI / 2;
const SWEEP_LEN = Math.PI * 1.55; // a cooldown most of the way round

/* ------------------------------------------------------------------- PNG */

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** rgba: Uint8Array of size*size*4 */
function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------- rasteriser */

/** Signed distance to a rounded rectangle centred on (cx, cy). */
function sdRoundRect(x, y, cx, cy, halfW, halfH, r) {
  const dx = Math.abs(x - cx) - (halfW - r);
  const dy = Math.abs(y - cy) - (halfH - r);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}

function angleInSweep(x, y, cx, cy) {
  let a = Math.atan2(y - cy, x - cx) - SWEEP_START;
  while (a < 0) a += Math.PI * 2;
  while (a >= Math.PI * 2) a -= Math.PI * 2;
  return a <= SWEEP_LEN;
}

function render(size, { maskable }) {
  const SS = 4; // supersample factor
  const n = size * SS;
  const c = n / 2;
  const out = new Uint8Array(size * size * 4);

  // Geometry, in supersampled pixels.
  const pad = maskable ? n * 0.22 : n * 0.06;  // maskable keeps art in the safe circle
  const half = c - pad;
  const ringOuter = half * 0.78;
  const ringWidth = half * 0.26;
  const ringInner = ringOuter - ringWidth;
  const dot = half * 0.2;
  const bgRadius = maskable ? 0 : n * 0.23;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = px * SS + sx + 0.5;
          const y = py * SS + sy + 0.5;

          let col = null;
          let alpha = 0;

          // Background plate.
          if (maskable) {
            col = BG; alpha = 1;
          } else if (sdRoundRect(x, y, c, c, c - 0.5, c - 0.5, bgRadius) <= 0) {
            col = BG; alpha = 1;
          }

          // Ring.
          const d = Math.hypot(x - c, y - c);
          if (d <= ringOuter && d >= ringInner) {
            col = angleInSweep(x, y, c, c) ? ACCENT : TRACK;
            alpha = 1;
          }
          // Centre dot.
          if (d <= dot) { col = ACCENT; alpha = 1; }

          if (col && alpha) { r += col[0]; g += col[1]; b += col[2]; a += 255; }
        }
      }
      const samples = SS * SS;
      const i = (py * size + px) * 4;
      const aa = a / samples;
      // Premultiply-free average over covered samples only, so edges stay crisp.
      const covered = a / 255 || 1;
      out[i] = Math.round(r / covered);
      out[i + 1] = Math.round(g / covered);
      out[i + 2] = Math.round(b / covered);
      out[i + 3] = Math.round(aa);
    }
  }
  return encodePng(size, out);
}

fs.mkdirSync(OUT, { recursive: true });
const targets = [
  ['icon-192.png', 192, { maskable: false }],
  ['icon-512.png', 512, { maskable: false }],
  ['maskable-192.png', 192, { maskable: true }],
  ['maskable-512.png', 512, { maskable: true }],
];
for (const [name, size, opts] of targets) {
  const png = render(size, opts);
  fs.writeFileSync(path.join(OUT, name), png);
  console.log(`${name}  ${size}x${size}  ${png.length} bytes`);
}
