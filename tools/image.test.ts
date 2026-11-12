import { describe, expect, test } from "bun:test";
import {
  contactSheets,
  createImage,
  diffImages,
  drawText,
  fillRect,
  hstack,
  textWidth,
} from "./image";

describe("image helpers", () => {
  test("drawText stamps pixels and textWidth matches the advance", () => {
    const image = createImage(40, 8);
    drawText(image, "A1", 1, 1, [255, 255, 255]);
    let lit = 0;
    for (let p = 0; p < 40 * 8; p++) {
      lit += image.rgba[p * 4] === 255 ? 1 : 0;
    }
    expect(lit).toBeGreaterThan(10);
    expect(textWidth("AB")).toBe(7);
    expect(textWidth("")).toBe(0);
  });

  test("contactSheets lays out a grid and splits into several sheets", () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      image: createImage(10, 6, [i * 40, 0, 0]),
      label: `V${i}`,
    }));
    const sheets = contactSheets(items, { cols: 2, rows: 2, separator: 1 });
    expect(sheets).toHaveLength(2);
    expect(sheets[0].items).toEqual([0, 1, 2, 3]);
    expect(sheets[1].items).toEqual([4]);
    expect(sheets[0].image.width).toBe(2 * 10 + 3);
    expect(sheets[0].image.height).toBe(2 * 6 + 3);
    expect(sheets[1].image.width).toBe(10 + 2);
  });

  test("diffImages counts changed pixels and amplifies", () => {
    const a = createImage(10, 10, [50, 50, 50]);
    const b = createImage(10, 10, [50, 50, 50]);
    fillRect(b, 0, 0, 5, 2, [70, 50, 50]);
    fillRect(b, 9, 9, 1, 1, [51, 50, 50]); // below the threshold
    const diff = diffImages(a, b);
    expect(diff.changedPixels).toBe(10);
    expect(diff.changedPercent).toBeCloseTo(10);
    expect(diff.image.rgba[0]).toBe(160);
    expect(diffImages(a, a).changedPixels).toBe(0);
    expect(() => diffImages(a, createImage(5, 5))).toThrow();
  });

  test("hstack widens by the sum plus separators", () => {
    const out = hstack([createImage(4, 3), createImage(5, 2)], 1);
    expect(out.width).toBe(4 + 5 + 3);
    expect(out.height).toBe(3 + 2);
  });
});
