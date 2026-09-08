'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const iconsDir = path.join(__dirname, '..', 'public', 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

// Function to create an uncompressed/deflated raw PNG image with RGBA buffer
function createPng(width, height, getPixelRgba) {
  const bytesPerPixel = 4;
  const scanlineLength = 1 + width * bytesPerPixel;
  const rawData = Buffer.alloc(height * scanlineLength);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * scanlineLength;
    rawData[rowOffset] = 0; // Filter byte: None (0)
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = getPixelRgba(x, y, width, height);
      const pixelOffset = rowOffset + 1 + x * bytesPerPixel;
      rawData[pixelOffset] = r;
      rawData[pixelOffset + 1] = g;
      rawData[pixelOffset + 2] = b;
      rawData[pixelOffset + 3] = a;
    }
  }

  const deflated = zlib.deflateSync(rawData);

  // PNG Signature
  const signature = Buffer.from([137, 80, 78, 72, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // Bit depth
  ihdrData[9] = 6; // Color type: RGBA (6)
  ihdrData[10] = 0; // Compression method
  ihdrData[11] = 0; // Filter method
  ihdrData[12] = 0; // Interlace method
  const ihdrChunk = makeChunk('IHDR', ihdrData);

  // IDAT chunk
  const idatChunk = makeChunk('IDAT', deflated);

  // IEND chunk
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function crc32(buf) {
  let table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      if (c & 1) c = 0xedb88320 ^ (c >>> 1);
      else c = c >>> 1;
    }
    table[n] = c;
  }

  let c = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) {
    c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xff];
  }
  return (c ^ (-1)) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crcVal = crc32(body);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crcVal, 0);
  return Buffer.concat([len, body, crcBuf]);
}

// Draw stylish MasterDrinks icon (Dark slate background with neon violet/cyan cocktail glow)
function drawDrinkIcon(x, y, w, h) {
  const cx = w / 2;
  const cy = h / 2;
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const radius = w * 0.46;

  // Background circle with smooth anti-aliased edge
  if (dist > radius) {
    return [0, 0, 0, 0];
  }

  // Gradient background: Dark Slate / Indigo (#0f172a to #1e1b4b)
  const normY = y / h;
  let bgR = Math.round(15 + normY * 18);
  let bgG = Math.round(23 + normY * 10);
  let bgB = Math.round(42 + normY * 45);

  // Outer Neon Ring (Cyan/Purple)
  const ringDist = Math.abs(dist - radius * 0.92);
  if (ringDist < w * 0.035) {
    const ringAlpha = 1 - ringDist / (w * 0.035);
    const ringR = 139;
    const ringG = 92;
    const ringB = 246; // Violet (#8b5cf6)
    bgR = Math.round(bgR * (1 - ringAlpha) + ringR * ringAlpha);
    bgG = Math.round(bgG * (1 - ringAlpha) + ringG * ringAlpha);
    bgB = Math.round(bgB * (1 - ringAlpha) + ringB * ringAlpha);
  }

  // Central Cocktail Glass Art (Triangle cup + stem + base)
  // Triangle Glass cup (top y1=0.28, bottom y2=0.55)
  const cupTopY = h * 0.28;
  const cupBotY = h * 0.52;
  const cupTopHalfW = w * 0.25;

  let isGlass = false;
  let isDrink = false;
  let isStem = false;
  let isBase = false;
  let isGarnish = false;

  // Cup shape
  if (y >= cupTopY && y <= cupBotY) {
    const progress = (y - cupTopY) / (cupBotY - cupTopY);
    const maxHalfW = cupTopHalfW * (1 - progress * 0.95);
    const currentHalfW = Math.abs(dx);

    if (currentHalfW <= maxHalfW) {
      if (currentHalfW >= maxHalfW - (w * 0.02) || y >= cupBotY - (h * 0.02) || y <= cupTopY + (h * 0.015)) {
        isGlass = true;
      } else if (y >= cupTopY + (cupBotY - cupTopY) * 0.25) {
        isDrink = true;
      }
    }
  }

  // Stem
  const stemTopY = cupBotY;
  const stemBotY = h * 0.74;
  if (y >= stemTopY && y <= stemBotY && Math.abs(dx) <= w * 0.02) {
    isStem = true;
  }

  // Base
  const baseY = stemBotY;
  const baseHalfW = w * 0.18;
  if (y >= baseY && y <= baseY + h * 0.03 && Math.abs(dx) <= baseHalfW * (1 - (y - baseY) / (h * 0.03) * 0.3)) {
    isBase = true;
  }

  // Garnish (Citrus slice on glass rim)
  const garnishCx = cx + cupTopHalfW * 0.75;
  const garnishCy = cupTopY * 0.95;
  const gdx = x - garnishCx;
  const gdy = y - garnishCy;
  const gdist = Math.sqrt(gdx * gdx + gdy * gdy);
  if (gdist <= w * 0.09) {
    isGarnish = true;
  }

  if (isGarnish) {
    // Neon Lime / Amber citrus slice (#10b981 / #f59e0b)
    return [16, 185, 129, 255];
  }
  if (isDrink) {
    // Glowing Sunset Pink/Orange Cocktail (#ec4899 / #f43f5e)
    const drinkProg = (y - cupTopY) / (cupBotY - cupTopY);
    return [
      Math.round(236 + drinkProg * 18),
      Math.round(72 + drinkProg * 40),
      Math.round(153 - drinkProg * 60),
      255
    ];
  }
  if (isGlass || isStem || isBase) {
    // Crisp Cyan Glow Glass (#38bdf8)
    return [56, 189, 248, 255];
  }

  return [bgR, bgG, bgB, 255];
}

const png192 = createPng(192, 192, drawDrinkIcon);
fs.writeFileSync(path.join(iconsDir, 'icon-192.png'), png192);
console.log('✔ Icono 192x192 generado.');

const png512 = createPng(512, 512, drawDrinkIcon);
fs.writeFileSync(path.join(iconsDir, 'icon-512.png'), png512);
console.log('✔ Icono 512x512 generado.');
