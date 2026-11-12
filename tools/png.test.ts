import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { decodePng, encodePng } from "./png";

function noisy(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  let seed = 12345;
  for (let i = 0; i < pixels.length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    pixels[i] = seed >>> 24;
  }
  return pixels;
}

describe("decodePng", () => {
  test("round-trips through encodePng", () => {
    const pixels = noisy(17, 9);
    const decoded = decodePng(encodePng(17, 9, pixels));
    expect(decoded.width).toBe(17);
    expect(decoded.height).toBe(9);
    expect(Array.from(decoded.rgba)).toEqual(Array.from(pixels));
  });

  test("handles every filter type on RGB data", () => {
    const width = 5;
    const height = 5;
    const channels = 3;
    const stride = width * channels;
    const image = new Uint8Array(stride * height);
    for (let i = 0; i < image.length; i++) {
      image[i] = (i * 37 + 11) & 0xff;
    }
    const paeth = (a: number, b: number, c: number): number => {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    };
    const raw = new Uint8Array((stride + 1) * height);
    for (let y = 0; y < height; y++) {
      raw[y * (stride + 1)] = y; // filter types 0..4, one per row
      for (let x = 0; x < stride; x++) {
        const a = x >= channels ? image[y * stride + x - channels] : 0;
        const b = y > 0 ? image[(y - 1) * stride + x] : 0;
        const c =
          y > 0 && x >= channels ? image[(y - 1) * stride + x - channels] : 0;
        const predicted = [0, a, b, (a + b) >> 1, paeth(a, b, c)][y];
        raw[y * (stride + 1) + 1 + x] =
          (image[y * stride + x] - predicted) & 255;
      }
    }
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    header[8] = 8;
    header[9] = 2;
    const chunk = (type: string, data: Uint8Array): Uint8Array => {
      const out = new Uint8Array(12 + data.length);
      new DataView(out.buffer).setUint32(0, data.length);
      for (let i = 0; i < 4; i++) {
        out[4 + i] = type.charCodeAt(i);
      }
      out.set(data, 8);
      return out; // CRC left zero: the decoder does not verify it
    };
    const parts = [
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", new Uint8Array(deflateSync(raw))),
      chunk("IEND", new Uint8Array(0)),
    ];
    const file = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      file.set(part, offset);
      offset += part.length;
    }
    const decoded = decodePng(file);
    for (let i = 0; i < width * height; i++) {
      expect(decoded.rgba[i * 4]).toBe(image[i * 3]);
      expect(decoded.rgba[i * 4 + 1]).toBe(image[i * 3 + 1]);
      expect(decoded.rgba[i * 4 + 2]).toBe(image[i * 3 + 2]);
      expect(decoded.rgba[i * 4 + 3]).toBe(255);
    }
  });

  test("rejects non-PNG data", () => {
    expect(() => decodePng(new Uint8Array(20))).toThrow();
  });
});
