"use strict";
/*
 * Pixel statistics used by acceptance item 3 (bitmap upscale vs re-raster).
 *
 * Discriminator, stated before running so the result cannot be read backwards:
 * take the SAME guest text box at several canvas zooms and look at the device
 * pixels it occupies.
 *   - Re-rasterised at the composited scale: stroke widths grow with the zoom
 *     while the anti-aliased edge stays ~1 device pixel, so the *fraction* of
 *     intermediate-luminance pixels FALLS as zoom rises and the maximum
 *     neighbour-to-neighbour gradient stays near full range.
 *   - Bitmap upscale of a zoom-1 raster: every source pixel is stretched (and
 *     usually interpolated), so the intermediate fraction stays flat or rises
 *     and the maximum gradient FALLS roughly in proportion to the zoom.
 */

/** Decode a NativeImage into { w, h, lum: Float32Array } in *device* pixels. */
function toLuminance(image) {
  const bitmap = image.toBitmap(); // BGRA
  const dip = image.getSize();
  const pixels = bitmap.length / 4;
  const scale = Math.max(
    1,
    Math.round(Math.sqrt(pixels / Math.max(1, dip.width * dip.height))),
  );
  const w = Math.round(dip.width * scale);
  const h = Math.round(pixels / Math.max(1, w));
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    const o = i * 4;
    lum[i] = 0.114 * bitmap[o] + 0.587 * bitmap[o + 1] + 0.299 * bitmap[o + 2];
  }
  return { w, h, lum, deviceScale: scale };
}

function textMetrics(image) {
  const { w, h, lum, deviceScale } = toLuminance(image);
  let min = 255;
  let max = 0;
  for (let i = 0; i < lum.length; i += 1) {
    if (lum[i] < min) min = lum[i];
    if (lum[i] > max) max = lum[i];
  }
  const span = Math.max(1, max - min);
  const lo = min + span * 0.2;
  const hi = max - span * 0.2;

  let intermediate = 0;
  let ink = 0;
  for (let i = 0; i < lum.length; i += 1) {
    if (lum[i] > lo && lum[i] < hi) intermediate += 1;
    if (lum[i] < min + span * 0.5) ink += 1;
  }

  let maxGrad = 0;
  let gradSum = 0;
  let gradCount = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 1; x < w; x += 1) {
      const d = Math.abs(lum[y * w + x] - lum[y * w + x - 1]);
      if (d > maxGrad) maxGrad = d;
      if (d > 4) {
        gradSum += d;
        gradCount += 1;
      }
    }
  }

  return {
    devicePixels: { w, h },
    deviceScale,
    lumMin: round(min),
    lumMax: round(max),
    inkFraction: round(ink / lum.length, 4),
    intermediateFraction: round(intermediate / lum.length, 4),
    maxHorizontalGradient: round(maxGrad),
    meanEdgeGradient: gradCount ? round(gradSum / gradCount) : 0,
    edgePixelFraction: round(gradCount / lum.length, 4),
  };
}

function round(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

module.exports = { textMetrics, toLuminance };
