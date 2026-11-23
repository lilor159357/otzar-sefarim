import fs from "fs";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(__dirname, "..", "build");
fs.mkdirSync(buildDir, { recursive: true });

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

function blendPixel(buf, size, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= size || y >= size || a <= 0) return;
  const idx = (y * size + x) * 4;
  const alpha = a / 255;
  const inv = 1 - alpha;
  buf[idx] = Math.round(r * alpha + buf[idx] * inv);
  buf[idx + 1] = Math.round(g * alpha + buf[idx + 1] * inv);
  buf[idx + 2] = Math.round(b * alpha + buf[idx + 2] * inv);
  buf[idx + 3] = Math.min(255, Math.round(a + buf[idx + 3] * inv));
}

function drawRoundedRect(buf, size, rx, ry, rw, rh, radius, r, g, b, a = 255) {
  const x0 = Math.max(0, Math.floor(rx));
  const y0 = Math.max(0, Math.floor(ry));
  const x1 = Math.min(size - 1, Math.ceil(rx + rw));
  const y1 = Math.min(size - 1, Math.ceil(ry + rh));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const cx = Math.max(rx + radius, Math.min(rx + rw - radius, px));
      const cy = Math.max(ry + radius, Math.min(ry + rh - radius, py));
      const dx = px - cx;
      const dy = py - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= radius + 0.7) {
        const cov = dist <= radius - 0.5 ? 1 : Math.max(0, Math.min(1, radius + 0.5 - dist));
        blendPixel(buf, size, x, y, r, g, b, Math.round(a * cov));
      }
    }
  }
}

function renderIconRgba(size) {
  const buf = Buffer.alloc(size * size * 4, 0);
  const pad = Math.round(size * 0.06);
  const box = size - pad * 2;
  const rad = Math.round(size * 0.2);

  // Warm deep slate/charcoal outer squircle
  drawRoundedRect(buf, size, pad, pad, box, box, rad, 28, 25, 23, 255);
  // Rich Otzar orange inner surface
  const inset = Math.max(2, Math.round(size * 0.04));
  drawRoundedRect(buf, size, pad + inset, pad + inset, box - inset * 2, box - inset * 2, Math.max(2, rad - inset), 234, 88, 12, 255);

  // Open book pages (cream white #FFF7ED) left & right with subtle dark spine gap
  const bookW = Math.round(size * 0.56);
  const bookH = Math.round(size * 0.44);
  const bx = Math.round((size - bookW) / 2);
  const by = Math.round(size * 0.28);
  const halfW = Math.round((bookW - Math.max(2, Math.round(size * 0.04))) / 2);
  const gap = Math.max(2, Math.round(size * 0.04));

  // Spine backing bar
  drawRoundedRect(buf, size, bx - Math.max(1, Math.round(size * 0.02)), by + Math.round(bookH * 0.1), bookW + Math.max(2, Math.round(size * 0.04)), bookH, Math.max(2, Math.round(size * 0.03)), 154, 52, 18, 255);
  // Left & right pages
  drawRoundedRect(buf, size, bx, by, halfW, bookH, Math.max(2, Math.round(size * 0.03)), 255, 247, 237, 255);
  drawRoundedRect(buf, size, bx + halfW + gap, by, halfW, bookH, Math.max(2, Math.round(size * 0.03)), 255, 247, 237, 255);

  // Subtle horizontal text lines on pages for crisp book recognition at large sizes
  if (size >= 32) {
    const lineH = Math.max(1, Math.round(size * 0.025));
    const lineW = Math.max(4, Math.round(halfW * 0.62));
    const lx1 = bx + Math.round((halfW - lineW) / 2);
    const lx2 = bx + halfW + gap + Math.round((halfW - lineW) / 2);
    for (let i = 0; i < 3; i++) {
      const ly = by + Math.round(bookH * (0.24 + i * 0.22));
      drawRoundedRect(buf, size, lx1, ly, lineW, lineH, 1, 234, 88, 12, 175);
      drawRoundedRect(buf, size, lx2, ly, lineW, lineH, 1, 234, 88, 12, 175);
    }
  }

  return buf;
}

function buildIco(sizes) {
  const pngEntries = sizes.map((sz) => {
    const rgba = renderIconRgba(sz);
    return { size: sz, png: encodePng(sz, sz, rgba) };
  });

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // icon type
  header.writeUInt16LE(pngEntries.length, 4);

  let offset = 6 + pngEntries.length * 16;
  const dirEntries = [];
  for (const entry of pngEntries) {
    const d = Buffer.alloc(16);
    d[0] = entry.size >= 256 ? 0 : entry.size;
    d[1] = entry.size >= 256 ? 0 : entry.size;
    d[2] = 0;
    d[3] = 0;
    d.writeUInt16LE(1, 4); // planes
    d.writeUInt16LE(32, 6); // bpp
    d.writeUInt32LE(entry.png.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += entry.png.length;
    dirEntries.push(d);
  }

  return Buffer.concat([header, ...dirEntries, ...pngEntries.map((e) => e.png)]);
}

const png256 = encodePng(256, 256, renderIconRgba(256));
fs.writeFileSync(path.join(buildDir, "icon.png"), png256);
const ico = buildIco([16, 32, 48, 64, 256]);
fs.writeFileSync(path.join(buildDir, "icon.ico"), ico);
console.log("Generated build/icon.png (" + png256.length + "B) and build/icon.ico (" + ico.length + "B)");
