import { deflateSync, inflateSync } from "node:zlib";

/**
 * 整页截图拼接用的 PNG 编解码：只认 Chromium 截图会给的那一种（8 位、非交错、
 * RGB 或 RGBA），输出一律 RGBA。
 *
 * 不引依赖：压缩与解压是 Node 自带的 `node:zlib`，PNG 本身只是一个签名、几个
 * 带 CRC 的块和按行过滤的像素，剩下的一百来行就是这里。原生的图像库要跟着
 * Electron 与 Node 各编一份，为「把几张截图竖着摞起来」不值得；纯 JS 的现成包
 * 做的也是这一百来行，外加这里用不到的调色板、16 位与交错。
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** 一张解开的图：`pixels` 是逐行的 RGBA。 */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly pixels: Buffer;
}

export function decodePng(buffer: Buffer): RgbaImage {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("不是 PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const data: Buffer[] = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      colorType = body[9]!;
      if (body[8] !== 8 || body[12] !== 0)
        throw new Error("只解 8 位、非交错的 PNG");
    } else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (channels === 0) throw new Error(`不认识的 PNG 颜色类型 ${colorType}`);
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error("PNG 数据不完整");
  const pixels = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  let line = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    const filter = raw[start]!;
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? line[i - channels]! : 0;
      const up = previous[i]!;
      let value = raw[start + 1 + i]!;
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const upLeft = i >= channels ? previous[i - channels]! : 0;
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      line[i] = value & 0xff;
    }
    const row = y * width * 4;
    if (channels === 4) line.copy(pixels, row);
    else {
      for (let x = 0; x < width; x += 1) {
        pixels[row + x * 4] = line[x * 3]!;
        pixels[row + x * 4 + 1] = line[x * 3 + 1]!;
        pixels[row + x * 4 + 2] = line[x * 3 + 2]!;
        pixels[row + x * 4 + 3] = 255;
      }
    }
    [previous, line] = [line, previous];
  }
  return { width, height, pixels };
}

export function encodePng(image: RgbaImage): Buffer {
  const { width, height, pixels } = image;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    // 过滤方式 0（不过滤）：截图大多是大片同色，deflate 自己就压得动。
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 一张空白画布，像素全透明。 */
export function blank(width: number, height: number): RgbaImage {
  return { width, height, pixels: Buffer.alloc(width * height * 4) };
}

/**
 * 把 `piece` 贴到 `canvas` 的 (left, top)；超出画布的部分裁掉。后贴的盖住先贴
 * 的：最后一段滚到底时与上一段重叠，重叠处本来就是同一片像素。
 */
export function paste(
  canvas: RgbaImage,
  piece: RgbaImage,
  left: number,
  top: number,
): void {
  const x0 = Math.max(0, left);
  const x1 = Math.min(canvas.width, left + piece.width);
  if (x1 <= x0) return;
  for (
    let y = Math.max(0, top);
    y < Math.min(canvas.height, top + piece.height);
    y += 1
  ) {
    const from = ((y - top) * piece.width + (x0 - left)) * 4;
    piece.pixels.copy(
      canvas.pixels,
      (y * canvas.width + x0) * 4,
      from,
      from + (x1 - x0) * 4,
    );
  }
}
