import { describe, expect, it } from "vitest";
import { glyphAlpha, templateGlyph } from "./tray-glyph";

function bitmap(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number, number],
) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const [b, g, r, a] = paint(x, y);
      data.set([b, g, r, a], (y * width + x) * 4);
    }
  return { width, height, data };
}

describe("the menu-bar glyph", () => {
  it("keeps dark pixels, drops light ones, and grades the edge", () => {
    expect(glyphAlpha(30, 30, 30, 255)).toBe(255);
    expect(glyphAlpha(240, 240, 240, 255)).toBe(0);
    expect(glyphAlpha(0, 0, 0, 0)).toBe(0);
    const mid = glyphAlpha(125, 125, 125, 255);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(255);
  });

  it("trims to the shape and centres it in a padded square", () => {
    // A light 20×20 tile with a dark 4×8 bar at (6..9, 4..11).
    const source = bitmap(20, 20, (x, y) =>
      x >= 6 && x <= 9 && y >= 4 && y <= 11
        ? [20, 20, 20, 255]
        : [245, 245, 245, 255],
    );
    const glyph = templateGlyph(source);
    expect(glyph.width).toBe(glyph.height);
    // span 8 + 6% padding on both sides (rounded to 0 at this size) → 8
    expect(glyph.width).toBe(8);
    let opaque = 0;
    for (let i = 3; i < glyph.data.length; i += 4)
      if (glyph.data[i] === 255) opaque += 1;
    expect(opaque).toBe(4 * 8);
    // Colour bytes are zero everywhere: premultiplied black.
    for (let i = 0; i < glyph.data.length; i += 4) {
      expect(glyph.data[i]).toBe(0);
      expect(glyph.data[i + 1]).toBe(0);
      expect(glyph.data[i + 2]).toBe(0);
    }
  });

  it("answers a single transparent pixel for an image with no shape", () => {
    const glyph = templateGlyph(bitmap(4, 4, () => [255, 255, 255, 255]));
    expect(glyph.width).toBe(1);
    expect(glyph.data[3]).toBe(0);
  });
});
