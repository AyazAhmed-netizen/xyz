// Generates PNG icons (orange circle + white dot) without dependencies
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  return zlib.crc32(buf) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makePng(size) {
  const cx = (size - 1) / 2;
  const rOuter = size * 0.47;
  const rInner = size * 0.20;

  // Raw RGBA scanlines, each prefixed with filter byte 0
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const d = Math.sqrt((x - cx) ** 2 + (y - cx) ** 2);
      let r = 0, g = 0, b = 0, a = 0;
      if (d <= rOuter + 0.5) {
        if (d <= rInner) {
          r = 255; g = 255; b = 255; a = 255; // white center
        } else if (d <= rOuter - 0.5) {
          r = 255; g = 69; b = 0; a = 255; // orange
        } else {
          // 1px anti-aliased edge
          r = 255; g = 69; b = 0;
          a = Math.round(255 * (rOuter + 0.5 - d));
        }
      }
      raw[p++] = r; raw[p++] = g; raw[p++] = b; raw[p++] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const dir = __dirname;
for (const size of [16, 32, 48, 128]) {
  const file = path.join(dir, `icon${size}.png`);
  fs.writeFileSync(file, makePng(size));
  console.log(`Created ${file}`);
}
