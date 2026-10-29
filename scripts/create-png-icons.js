import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

function createPng(width, height, r, g, b) {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8); // bit depth: 8
  ihdrData.writeUInt8(2, 9); // color type: 2 (RGB)
  ihdrData.writeUInt8(0, 10); // compression method
  ihdrData.writeUInt8(0, 11); // filter method
  ihdrData.writeUInt8(0, 12); // interlace method
  const ihdr = createChunk('IHDR', ihdrData);

  // Raw image data with scanline filter byte (0)
  const rowSize = 1 + width * 3;
  const rawData = Buffer.alloc(height * rowSize);

  const cx = width / 2;
  const cy = height / 2;
  const radius = width * 0.4;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    rawData[rowOffset] = 0; // Filter type 0 (None)

    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 3;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < radius) {
        // Inner amber/brass circle
        const ratio = dist / radius;
        rawData[pxOffset] = Math.round(245 - ratio * 50); // R
        rawData[pxOffset + 1] = Math.round(184 - ratio * 60); // G
        rawData[pxOffset + 2] = Math.round(77 - ratio * 50);  // B
      } else {
        // Dark vintage chassis
        rawData[pxOffset] = r;
        rawData[pxOffset + 1] = g;
        rawData[pxOffset + 2] = b;
      }
    }
  }

  const compressedData = zlib.deflateSync(rawData);
  const idat = createChunk('IDAT', compressedData);
  const iend = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

function createChunk(type, data) {
  const length = data.length;
  const buffer = Buffer.alloc(4 + 4 + length + 4);
  buffer.writeUInt32BE(length, 0);
  buffer.write(type, 4, 4, 'ascii');
  data.copy(buffer, 8);

  // Calculate CRC32 over chunk type and data
  const crc = crc32(buffer.subarray(4, 8 + length));
  buffer.writeUInt32BE(crc, 8 + length);
  return buffer;
}

// Standard CRC32 table
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// Generate for root and public
const publicDir = path.resolve('public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

const pwa192 = createPng(192, 192, 26, 22, 19);
const pwa512 = createPng(512, 512, 26, 22, 19);
const appleIcon = createPng(180, 180, 26, 22, 19);

fs.writeFileSync('pwa-192x192.png', pwa192);
fs.writeFileSync('pwa-512x512.png', pwa512);
fs.writeFileSync('apple-touch-icon.png', appleIcon);

fs.writeFileSync('public/pwa-192x192.png', pwa192);
fs.writeFileSync('public/pwa-512x512.png', pwa512);
fs.writeFileSync('public/apple-touch-icon.png', appleIcon);

// Also copy icon.svg to public/icon.svg
if (fs.existsSync('icon.svg')) {
  fs.copyFileSync('icon.svg', 'public/icon.svg');
}

console.log('Successfully generated PWA icon files!');
