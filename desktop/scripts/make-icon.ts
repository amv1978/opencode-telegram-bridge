// Generates app icon (PNG + ICO) without external dependencies.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SIZE = 256;
const BG = [10, 14, 10];
const GREEN = [46, 255, 106];
const ACCENT = [28, 194, 75];

const pixels = Buffer.alloc(SIZE * SIZE * 4);
const c = (SIZE - 1) / 2;

function smooth(edge: number, dist: number): number {
  const t = Math.min(1, Math.max(0, edge + 0.5 - dist));
  return t * t * (3 - 2 * t);
}

for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const dx = Math.abs(x - c);
    const dy = Math.abs(y - c);
    const rounded = Math.max(dx, dy) - 26; // rounded-square mask
    const corner = Math.hypot(Math.max(dx - 52, 0), Math.max(dy - 52, 0)) - 26;
    const squareAlpha = smooth(0, Math.max(rounded, corner));

    const ringDist = Math.abs(Math.hypot(x - c, y - c) - 78);
    const ringAlpha = smooth(1.6, ringDist);
    const dotDist = Math.hypot(x - c, y - c);
    const dotAlpha = smooth(1.2, Math.abs(dotDist - 26) - 14);

    let r = BG[0];
    let g = BG[1];
    let b = BG[2];
    const glow = Math.max(ringAlpha, dotAlpha);
    r = r * (1 - glow) + GREEN[0] * glow;
    g = g * (1 - glow) + GREEN[1] * glow;
    b = b * (1 - glow) + GREEN[2] * glow;

    // subtle inner tint
    const tint = smooth(90, dotDist) * 0.25;
    r = r * (1 - tint) + ACCENT[0] * tint;
    g = g * (1 - tint) + ACCENT[1] * tint;
    b = b * (1 - tint) + ACCENT[2] * tint;

    const i = (y * SIZE + x) * 4;
    pixels[i] = Math.round(r);
    pixels[i + 1] = Math.round(g);
    pixels[i + 2] = Math.round(b);
    pixels[i + 3] = Math.round(squareAlpha * 255);
  }
}

const table = new Uint32Array(256).map((_, n) => {
  let value = n;
  for (let k = 0; k < 8; k += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0;
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const ico = Buffer.alloc(6 + 16);
ico.writeUInt16LE(0, 0);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico[6] = 0;
ico[7] = 0;
ico[8] = 0;
ico[9] = 0;
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14);
ico.writeUInt32LE(6 + 16, 18);
const icoFile = Buffer.concat([ico, png]);

const out = join(process.cwd(), "build");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "icon.png"), png);
writeFileSync(join(out, "icon.ico"), icoFile);
console.log(`icon.png ${png.length}B, icon.ico ${icoFile.length}B -> ${out}`);
