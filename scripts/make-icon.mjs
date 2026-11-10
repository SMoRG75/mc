// Draws images/icon.png, the Marketplace icon: two panes, the active one lit.
//
//   node scripts/make-icon.mjs
//
// Drawn here rather than kept only as a PNG so it can be changed without
// measuring pixels: every shape is a rounded rectangle, sampled 8×8 per pixel
// for smooth edges. The sizes are the ones the hand-drawn 1.0 icon had, with
// the panes run down to the same margin at the bottom as at the top.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';

const SIZE = 128;
const SAMPLES = 8;

const BACKGROUND = [21, 27, 39];
const ACTIVE = [166, 186, 152];     // the active pane's frame, and its cursor row
const ACTIVE_TEXT = [228, 227, 228];
const INACTIVE = [148, 149, 155];
const INACTIVE_TEXT = [136, 138, 144];

const PANE = { top: 15, bottom: 113, width: 45, stroke: 3.5, radius: 7 };
const PANES_AT = [16, 67];
const ROW = { first: 28, pitch: 11, height: 5, inset: 9 };
/** Where each row ends, counted from the pane's left edge; 7 rows fill a pane. */
const LEFT_ROWS = [35, 29, 38, 26, 32, 36, 23];
const RIGHT_ROWS = [38, 26, 32, 35, 29, 33, 22];
/** The row the cursor is on in the active pane. */
const CURSOR = 1;

/** A rounded rectangle: [x0, x1) × [y0, y1), corners of radius r. */
const rect = (x0, y0, x1, y1, r) => ({ x0, y0, x1, y1, r });

function inside({ x0, y0, x1, y1, r }, x, y) {
  if (x < x0 || x >= x1 || y < y0 || y >= y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

const layers = [];
const fill = (shape, color) => layers.push({ shape, color });
const frame = (outer, stroke, color) => layers.push({
  shape: outer,
  hole: rect(outer.x0 + stroke, outer.y0 + stroke, outer.x1 - stroke, outer.y1 - stroke, Math.max(outer.r - stroke, 0)),
  color,
});

fill(rect(4, 4, 124, 124, 20), BACKGROUND);
PANES_AT.forEach((left, pane) => {
  const active = pane === 0;
  frame(rect(left, PANE.top, left + PANE.width, PANE.bottom, PANE.radius), PANE.stroke, active ? ACTIVE : INACTIVE);
  (active ? LEFT_ROWS : RIGHT_ROWS).forEach((end, row) => {
    const top = ROW.first + row * ROW.pitch;
    const color = !active ? INACTIVE_TEXT : row === CURSOR ? ACTIVE : ACTIVE_TEXT;
    fill(rect(left + ROW.inset, top, left + end, top + ROW.height, ROW.height / 2), color);
  });
});

const pixels = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    // Each layer's coverage of the pixel, put over what is below it.
    let [r, g, b, a] = [0, 0, 0, 0];
    for (const { shape, hole, color } of layers) {
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const px = x + (sx + 0.5) / SAMPLES;
          const py = y + (sy + 0.5) / SAMPLES;
          if (inside(shape, px, py) && !(hole && inside(hole, px, py))) hits++;
        }
      }
      const cover = hits / (SAMPLES * SAMPLES);
      if (cover === 0) continue;
      const out = cover + a * (1 - cover);
      [r, g, b] = [r, g, b].map((v, i) => (color[i] * cover + v * a * (1 - cover)) / out);
      a = out;
    }
    pixels.set([r, g, b, a * 255].map(Math.round), (y * SIZE + x) * 4);
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'images', 'icon.png');
fs.writeFileSync(target, png(SIZE, SIZE, pixels));
console.log(`Wrote ${path.relative(root, target)}`);

/** An 8-bit RGBA PNG, no filtering. */
function png(width, height, rgba) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = table[(c ^ byte) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
