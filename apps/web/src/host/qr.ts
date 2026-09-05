/**
 * 一个只够用的 QR 编码器：字节模式、纠错等级 L、版本 1–6。
 *
 * 「对外服务」那一页要把访问地址变成手机能扫的图，而这份前端不该为一张图加一个
 * 运行时依赖，所以这里只实现需要的那一小块规范：
 *
 *  - 版本上限 6（L 级 134 字节），远超一个 `https://192.168.1.20:8443` 的长度，
 *    也正好避开版本 ≥ 7 才有的版本信息块；
 *  - 只有字节模式，因为地址里有 `:` `/` 这些字符，数字/字母模式压不下；
 *  - 掩码按规范的四条罚分规则挑，不是固定 0。
 *
 * 装不下就返回 `null`：宁可只显示那行地址，也不画一张扫不出来的图。
 */

/** 版本 1–6 的总码字数。 */
const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172];
/** 版本 1–6 在 L 级下每块的纠错码字数。 */
const EC_PER_BLOCK = [7, 10, 15, 20, 26, 18];
/** 版本 1–6 在 L 级下的纠错块数。 */
const BLOCKS = [1, 1, 1, 1, 1, 2];
/** 版本 1–6 的对齐图形中心坐标。 */
const ALIGNMENT: number[][] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]];
export const MAX_QR_VERSION = TOTAL_CODEWORDS.length;

function dataCodewords(version: number): number {
  const index = version - 1;
  return TOTAL_CODEWORDS[index]! - EC_PER_BLOCK[index]! * BLOCKS[index]!;
}

/** 字节模式下这个版本能装多少字节（4 位模式 + 8 位长度）。 */
export function byteCapacity(version: number): number {
  return dataCodewords(version) - 2;
}

/* --------------------------------- GF(256) -------------------------------- */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = value;
    LOG[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]!;
}

function multiply(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

function generator(degree: number): Uint8Array {
  let result = new Uint8Array([1]);
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(result.length + 1);
    for (let j = 0; j < result.length; j += 1) {
      next[j] = next[j]! ^ result[j]!;
      next[j + 1] = next[j + 1]! ^ multiply(result[j]!, EXP[i]!);
    }
    result = next;
  }
  return result;
}

function remainder(data: Uint8Array, degree: number): Uint8Array {
  const divisor = generator(degree);
  const result = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ result[0]!;
    result.copyWithin(0, 1);
    result[degree - 1] = 0;
    for (let i = 0; i < degree; i += 1) {
      result[i] = result[i]! ^ multiply(divisor[i + 1]!, factor);
    }
  }
  return result;
}

/* ------------------------------- 码字与分块 -------------------------------- */

/** 把一段字节编成这个版本完整的、已交错的码字序列。 */
export function codewords(bytes: Uint8Array, version: number): Uint8Array {
  const index = version - 1;
  const capacity = dataCodewords(version);
  // 4 位模式 0100 + 8 位长度 + 内容 + 结束符，再补到字节边界。
  const bits: number[] = [];
  const push = (value: number, count: number) => {
    for (let i = count - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const byte of bytes) push(byte, 8);
  push(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const data = new Uint8Array(capacity);
  for (let i = 0; i < bits.length; i += 1) {
    if (bits[i]) data[i >> 3]! |= 1 << (7 - (i & 7));
  }
  // 剩下的按规范交替填 0xEC / 0x11。
  for (let i = bits.length / 8; i < capacity; i += 1) {
    data[i] = (i - bits.length / 8) % 2 === 0 ? 0xec : 0x11;
  }

  const blocks = BLOCKS[index]!;
  const short = Math.floor(capacity / blocks);
  const longBlocks = capacity % blocks;
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let block = 0; block < blocks; block += 1) {
    const size = short + (block >= blocks - longBlocks ? 1 : 0);
    const slice = data.subarray(offset, offset + size);
    offset += size;
    dataBlocks.push(slice);
    ecBlocks.push(remainder(slice, EC_PER_BLOCK[index]!));
  }
  const result = new Uint8Array(TOTAL_CODEWORDS[index]!);
  let cursor = 0;
  for (let i = 0; i < short + 1; i += 1) {
    for (const block of dataBlocks)
      if (i < block.length) result[cursor++] = block[i]!;
  }
  for (let i = 0; i < EC_PER_BLOCK[index]!; i += 1) {
    for (const block of ecBlocks) result[cursor++] = block[i]!;
  }
  return result;
}

/* --------------------------------- 矩阵 ----------------------------------- */

export interface QrCode {
  version: number;
  size: number;
  /** `true` 是深色模块。索引是 `[row][col]`。 */
  modules: boolean[][];
  mask: number;
}

function emptyMatrix(size: number): boolean[][] {
  return Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
}

/** 画出功能图形，并记下哪些格子不能放数据。 */
function functionModules(version: number): {
  modules: boolean[][];
  reserved: boolean[][];
} {
  const size = 17 + 4 * version;
  const modules = emptyMatrix(size);
  const reserved = emptyMatrix(size);
  const set = (x: number, y: number, dark: boolean) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y]![x] = dark;
    reserved[y]![x] = true;
  };
  // 以中心点画：距离 0/1/3 是深色，2 是内圈白环，4 是分隔带。
  const finder = (x: number, y: number) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        set(x + dx, y + dy, distance !== 2 && distance !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  for (let i = 8; i < size - 8; i += 1) {
    set(i, 6, i % 2 === 0);
    set(6, i, i % 2 === 0);
  }
  const centres = ALIGNMENT[version - 1]!;
  for (const y of centres) {
    for (const x of centres) {
      const corner =
        (x === 6 && y === 6) ||
        (x === 6 && y === size - 7) ||
        (x === size - 7 && y === 6);
      if (corner) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
  // 格式信息的位置先占住，值稍后写。第 6 行/列是时序图形，格式信息绕开它。
  for (let i = 0; i <= 8; i += 1) {
    if (i === 6) continue;
    set(8, i, false);
    set(i, 8, false);
  }
  for (let i = 0; i < 8; i += 1) {
    set(8, size - 1 - i, false);
    set(size - 1 - i, 8, false);
  }
  set(8, size - 8, true);
  return { modules, reserved };
}

function placeData(
  modules: boolean[][],
  reserved: boolean[][],
  data: Uint8Array,
): void {
  const size = modules.length;
  let bit = 0;
  const next = (): boolean => {
    const index = bit >> 3;
    const value =
      index < data.length && ((data[index]! >> (7 - (bit & 7))) & 1) === 1;
    bit += 1;
    return value;
  };
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step += 1) {
      const y = upward ? size - 1 - step : step;
      for (const x of [right, right - 1]) {
        if (reserved[y]![x]) continue;
        modules[y]![x] = next();
      }
    }
    upward = !upward;
  }
}

export function maskBit(mask: number, y: number, x: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

/** 15 位格式信息：等级 L (01) + 掩码，BCH(15,5) 后再异或 0x5412。 */
export function formatBits(mask: number): number {
  const data = 0b01000 | mask;
  let bits = data << 10;
  for (let i = 4; i >= 0; i -= 1) {
    if (bits & (1 << (i + 10))) bits ^= 0x537 << i;
  }
  return ((data << 10) | (bits & 0x3ff)) ^ 0x5412;
}

function writeFormat(modules: boolean[][], mask: number): void {
  const size = modules.length;
  const bits = formatBits(mask);
  const bit = (index: number) => ((bits >> index) & 1) === 1;
  const set = (x: number, y: number, dark: boolean) => {
    modules[y]![x] = dark;
  };
  for (let i = 0; i <= 5; i += 1) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);
}

function penalty(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;
  const line = (get: (index: number) => boolean) => {
    let run = 1;
    for (let i = 1; i < size; i += 1) {
      if (get(i) === get(i - 1)) {
        run += 1;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else run = 1;
    }
  };
  for (let i = 0; i < size; i += 1) {
    line((index) => modules[i]![index]!);
    line((index) => modules[index]![i]!);
  }
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const value = modules[y]![x]!;
      if (
        value === modules[y]![x + 1] &&
        value === modules[y + 1]![x] &&
        value === modules[y + 1]![x + 1]
      )
        score += 3;
    }
  }
  const finderLike = [true, false, true, true, true, false, true];
  const quiet = [false, false, false, false];
  const matches = (
    get: (index: number) => boolean,
    start: number,
    pattern: boolean[],
  ) => pattern.every((value, offset) => get(start + offset) === value);
  const scan = (get: (index: number) => boolean) => {
    for (let start = 0; start + 11 <= size; start += 1) {
      if (matches(get, start, [...finderLike, ...quiet])) score += 40;
      if (matches(get, start, [...quiet, ...finderLike])) score += 40;
    }
  };
  for (let i = 0; i < size; i += 1) {
    scan((index) => modules[i]![index]!);
    scan((index) => modules[index]![i]!);
  }
  let dark = 0;
  for (const row of modules) for (const value of row) if (value) dark += 1;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

/**
 * 把一段文本编成 QR 矩阵；装不下（或是空串）时返回 `null`。
 */
export function encodeQr(text: string): QrCode | null {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length === 0) return null;
  const version = TOTAL_CODEWORDS.findIndex(
    (_, index) => byteCapacity(index + 1) >= bytes.length,
  );
  if (version < 0) return null;
  const data = codewords(bytes, version + 1);
  const { modules: base, reserved } = functionModules(version + 1);
  let best: QrCode | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    const modules = base.map((row) => [...row]);
    placeData(modules, reserved, data);
    for (let y = 0; y < modules.length; y += 1) {
      for (let x = 0; x < modules.length; x += 1) {
        if (!reserved[y]![x] && maskBit(mask, y, x))
          modules[y]![x] = !modules[y]![x];
      }
    }
    writeFormat(modules, mask);
    const score = penalty(modules);
    if (score < bestScore) {
      bestScore = score;
      best = { version: version + 1, size: modules.length, modules, mask };
    }
  }
  return best;
}

/**
 * 深色模块合并成一条 SVG path。整块图只有一个 `<path>`，不是几百个 `<rect>`。
 */
export function qrPath(code: QrCode): string {
  const parts: string[] = [];
  for (let y = 0; y < code.size; y += 1) {
    let run = 0;
    for (let x = 0; x <= code.size; x += 1) {
      const dark = x < code.size && code.modules[y]![x]!;
      if (dark) run += 1;
      else if (run > 0) {
        parts.push(`M${x - run} ${y}h${run}v1h-${run}z`);
        run = 0;
      }
    }
  }
  return parts.join("");
}
