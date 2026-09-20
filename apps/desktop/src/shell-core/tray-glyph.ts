/**
 * The menu-bar glyph, cut out of the app icon.
 *
 * macOS wants a *template* image in the menu bar: black shapes on
 * transparency, which it tints for light and dark bars itself. The app icon
 * is a dark armadillo on a light rounded tile, so handing it over as a
 * template painted the whole tile — a solid square. This keeps the dark
 * pixels (the animal) as opaque black, lets the tile go transparent, and
 * trims to the shape so the glyph fills the 18 px it gets.
 *
 * Pure: BGRA in, BGRA out. Electron's `nativeImage` does the decoding and
 * the resizing on either side.
 */

export interface Bitmap {
  readonly width: number;
  readonly height: number;
  /** BGRA, row-major, `width * height * 4` bytes. */
  readonly data: Buffer;
}

/** Luminance at or below this is fully part of the glyph… */
export const DARK_LUMINANCE = 80;
/** …and at or above this is fully background; in between is anti-aliasing. */
export const LIGHT_LUMINANCE = 170;
/** Transparent margin kept around the trimmed shape, as a fraction of it. */
export const PADDING = 0.06;

export function glyphAlpha(b: number, g: number, r: number, a: number): number {
  if (a === 0) return 0;
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  const darkness =
    (LIGHT_LUMINANCE - luminance) / (LIGHT_LUMINANCE - DARK_LUMINANCE);
  return Math.round(a * Math.min(1, Math.max(0, darkness)));
}

/** Black-on-transparent version of `source`, trimmed to the shape. */
export function templateGlyph(source: Bitmap): Bitmap {
  const { width, height, data } = source;
  const alpha = new Uint8Array(width * height);
  let top = height;
  let bottom = -1;
  let left = width;
  let right = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const a = glyphAlpha(data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!);
      alpha[y * width + x] = a;
      if (a > 0) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (bottom < 0) return { width: 1, height: 1, data: Buffer.alloc(4) };
  // Square around the shape, so resizing keeps the aspect and centres it.
  const span = Math.max(right - left + 1, bottom - top + 1);
  const pad = Math.round(span * PADDING);
  const side = span + pad * 2;
  const originX = Math.round((left + right) / 2 - side / 2);
  const originY = Math.round((top + bottom) / 2 - side / 2);
  const out = Buffer.alloc(side * side * 4);
  for (let y = 0; y < side; y += 1) {
    const sy = originY + y;
    if (sy < 0 || sy >= height) continue;
    for (let x = 0; x < side; x += 1) {
      const sx = originX + x;
      if (sx < 0 || sx >= width) continue;
      // Premultiplied black is all zeros; only the alpha byte carries the shape.
      out[(y * side + x) * 4 + 3] = alpha[sy * width + sx]!;
    }
  }
  return { width: side, height: side, data: out };
}
