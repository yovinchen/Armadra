import { describe, expect, it } from "vitest";
import {
  byteCapacity,
  encodeQr,
  formatBits,
  MAX_QR_VERSION,
  maskBit,
  qrPath,
  type QrCode,
} from "./qr";

/**
 * 反向读一遍矩阵：按规范的走位顺序取出数据位、去掉掩码、拆掉交错，
 * 再解出模式、长度和内容。放置、掩码、交错任何一步错了，这里都会对不上。
 */
function readBack(code: QrCode): { text: string; mask: number } {
  const size = code.size;
  const reserved = functionMap(code.version, size);
  // 格式信息里的掩码号必须和编码时选的一致。
  let mask = -1;
  for (let candidate = 0; candidate < 8; candidate += 1) {
    const bits = formatBits(candidate);
    let matches = true;
    for (let i = 0; i <= 5; i += 1)
      if (code.modules[i]![8] !== (((bits >> i) & 1) === 1)) matches = false;
    if (matches) mask = candidate;
  }
  const bits: number[] = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step += 1) {
      const y = upward ? size - 1 - step : step;
      for (const x of [right, right - 1]) {
        if (reserved[y]![x]) continue;
        const value = code.modules[y]![x]!;
        bits.push(value !== maskBit(mask, y, x) ? 1 : 0);
      }
    }
    upward = !upward;
  }
  const stream = new Uint8Array(bits.length >> 3);
  for (let i = 0; i < stream.length * 8; i += 1)
    if (bits[i]) stream[i >> 3]! |= 1 << (7 - (i & 7));
  // 版本 1–6 在 L 级下最多两块，且两块等长，所以去交错就是隔一取一。
  const blocks = code.version === 6 ? 2 : 1;
  const dataLength = dataCodewordCount(code.version);
  const data = new Uint8Array(dataLength);
  for (let i = 0; i < dataLength; i += 1) {
    const block = i % blocks;
    const index = Math.floor(i / blocks);
    data[block * (dataLength / blocks) + index] = stream[i]!;
  }
  expect(data[0]! >> 4).toBe(0b0100);
  const length = ((data[0]! & 0x0f) << 4) | (data[1]! >> 4);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    bytes[i] = ((data[i + 1]! & 0x0f) << 4) | (data[i + 2]! >> 4);
  }
  return { text: new TextDecoder().decode(bytes), mask };
}

const TOTAL = [26, 44, 70, 100, 134, 172];
const EC = [7, 10, 15, 20, 26, 18];
const BLOCK_COUNT = [1, 1, 1, 1, 1, 2];
function dataCodewordCount(version: number): number {
  return TOTAL[version - 1]! - EC[version - 1]! * BLOCK_COUNT[version - 1]!;
}

/** 与编码器同一份功能图形位置表，只用来知道哪些格子不是数据。 */
function functionMap(version: number, size: number): boolean[][] {
  const reserved = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  const mark = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < size && y < size) reserved[y]![x] = true;
  };
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy += 1)
      for (let dx = -4; dx <= 4; dx += 1) mark(cx + dx, cy + dy);
  }
  for (let i = 8; i < size - 8; i += 1) {
    mark(i, 6);
    mark(6, i);
  }
  const centres = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]][
    version - 1
  ]!;
  for (const y of centres)
    for (const x of centres) {
      if (
        (x === 6 && y === 6) ||
        (x === 6 && y === size - 7) ||
        (x === size - 7 && y === 6)
      )
        continue;
      for (let dy = -2; dy <= 2; dy += 1)
        for (let dx = -2; dx <= 2; dx += 1) mark(x + dx, y + dy);
    }
  for (let i = 0; i <= 8; i += 1) {
    if (i === 6) continue;
    mark(8, i);
    mark(i, 8);
  }
  for (let i = 0; i < 8; i += 1) {
    mark(8, size - 1 - i);
    mark(size - 1 - i, 8);
  }
  mark(8, size - 8);
  return reserved;
}

describe("QR codes for the external service address", () => {
  it("round-trips the addresses this panel actually shows", () => {
    for (const text of [
      "https://192.168.1.20:8443",
      "https://127.0.0.1:43555",
      "https://armadra.example",
      "https://10.0.0.7:8443/workspace/one",
      "x".repeat(byteCapacity(MAX_QR_VERSION)),
    ]) {
      const code = encodeQr(text);
      expect(code).not.toBeNull();
      const decoded = readBack(code!);
      expect(decoded.text).toBe(text);
      expect(decoded.mask).toBe(code!.mask);
    }
  });

  it("grows the version only as far as the payload needs", () => {
    expect(encodeQr("https://a.example")?.version).toBe(1);
    expect(encodeQr("https://127.0.0.1:8443")?.version).toBe(2);
    expect(encodeQr("x".repeat(byteCapacity(1)))?.version).toBe(1);
    expect(encodeQr("x".repeat(byteCapacity(1) + 1))?.version).toBe(2);
    // Nothing to show, and nothing that would need a version this code cannot
    // build: both answer with no picture rather than an unscannable one.
    expect(encodeQr("")).toBeNull();
    expect(encodeQr("x".repeat(byteCapacity(MAX_QR_VERSION) + 1))).toBeNull();
  });

  it("draws the three finder patterns and the timing rows", () => {
    const code = encodeQr("https://a.example")!;
    const size = code.size;
    expect(size).toBe(21);
    for (const [x, y] of [
      [0, 0],
      [size - 7, 0],
      [0, size - 7],
    ] as const) {
      for (let i = 0; i < 7; i += 1) {
        expect(code.modules[y]![x + i]).toBe(true);
        expect(code.modules[y + 6]![x + i]).toBe(true);
      }
      expect(code.modules[y + 1]![x + 1]).toBe(false);
      expect(code.modules[y + 3]![x + 3]).toBe(true);
    }
    for (let i = 8; i < size - 8; i += 1) {
      expect(code.modules[6]![i]).toBe(i % 2 === 0);
      expect(code.modules[i]![6]).toBe(i % 2 === 0);
    }
    // The one module that is always dark.
    expect(code.modules[size - 8]![8]).toBe(true);
  });

  it("renders one path whose runs cover exactly the dark modules", () => {
    const code = encodeQr("https://127.0.0.1:8443")!;
    const path = qrPath(code);
    const covered = [...path.matchAll(/M(\d+) (\d+)h(\d+)/g)].reduce(
      (total, match) => total + Number(match[3]),
      0,
    );
    const dark = code.modules.flat().filter(Boolean).length;
    expect(covered).toBe(dark);
  });
});
