/**
 * Development-only PNG writer, for preview scripts run with Bun (never
 * imported by the game). Lets a module dump an image to `out/` to look at.
 *
 *   import { writePng } from "../../tools/png";
 *   await writePng("out/textures.png", width, height, rgba);
 */
import { deflateSync, inflateSync } from "node:zlib";

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encodes RGBA8 pixels (row-major from the top-left) as a PNG file. */
export function encodePng(
  width: number,
  height: number,
  rgba: Uint8Array,
): Uint8Array {
  if (rgba.length !== width * height * 4) {
    throw new Error(
      "encodePng: pixel buffer does not match width * height * 4",
    );
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Writes RGBA8 pixels to a PNG file, creating parent folders as needed. */
export async function writePng(
  path: string,
  width: number,
  height: number,
  rgba: Uint8Array,
): Promise<void> {
  await Bun.write(path, encodePng(width, height, rgba));
}

export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA8, row-major from the top-left. */
  rgba: Uint8Array;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}

/**
 * Decodes an 8-bit, non-interlaced RGB or RGBA PNG (what this project writes
 * and what the browser's canvas export produces). Always returns RGBA.
 */
export function decodePng(bytes: Uint8Array): DecodedPng {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (signature.some((value, i) => bytes[i] !== value)) {
    throw new Error("decodePng: not a PNG file");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      const depth = data[8];
      const colour = data[9];
      if (depth !== 8 || (colour !== 2 && colour !== 6) || data[12] !== 0) {
        throw new Error(
          "decodePng: only 8-bit RGB/RGBA non-interlaced PNGs are supported",
        );
      }
      channels = colour === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  const raw = new Uint8Array(inflateSync(Buffer.concat(idat)));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) {
    throw new Error("decodePng: truncated image data");
  }
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[dst + x - channels] : 0;
      const b = y > 0 ? pixels[dst - stride + x] : 0;
      const c =
        y > 0 && x >= channels ? pixels[dst - stride + x - channels] : 0;
      const value = raw[src + x];
      let predicted = 0;
      switch (filter) {
        case 0:
          break;
        case 1:
          predicted = a;
          break;
        case 2:
          predicted = b;
          break;
        case 3:
          predicted = (a + b) >> 1;
          break;
        case 4:
          predicted = paeth(a, b, c);
          break;
        default:
          throw new Error(`decodePng: bad filter type ${filter}`);
      }
      pixels[dst + x] = (value + predicted) & 0xff;
    }
  }
  if (channels === 4) {
    return { width, height, rgba: pixels };
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = pixels[i * 3];
    rgba[i * 4 + 1] = pixels[i * 3 + 1];
    rgba[i * 4 + 2] = pixels[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  return { width, height, rgba };
}

/** Reads and decodes a PNG file. */
export async function readPng(path: string): Promise<DecodedPng> {
  return decodePng(new Uint8Array(await Bun.file(path).arrayBuffer()));
}
