import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { ServiceDefinitionError } from "./spec";

/**
 * 日志尾部。
 *
 * 从文件末尾往回按块读，够行就停：一份几个 GB 的日志和一份几 KB 的代价一样。
 * 两个上限都在——行数和字节数——因为「一行写了 200 MB」的日志不该让这条命令
 * 无限分配内存。
 */

export const DEFAULT_LINES = 200;
export const MAX_LINES = 5000;
const MAX_TAIL_BYTES = 4 << 20;
const CHUNK_BYTES = 64 << 10;

export function tail(path: string, lines = DEFAULT_LINES): string[] {
  const wanted = Math.min(
    Math.max(Number.isInteger(lines) && lines > 0 ? lines : DEFAULT_LINES, 1),
    MAX_LINES,
  );
  const handle = openSync(path, "r");
  try {
    const stat = fstatSync(handle);
    if (!stat.isFile()) {
      throw new ServiceDefinitionError("日志必须是一个普通文件");
    }
    let offset = stat.size;
    let collected = Buffer.alloc(0);
    let truncated = false;
    while (offset > 0) {
      if (collected.byteLength >= MAX_TAIL_BYTES) {
        truncated = true;
        break;
      }
      const step = Math.min(CHUNK_BYTES, offset);
      offset -= step;
      const chunk = Buffer.alloc(step);
      readSync(handle, chunk, 0, step, offset);
      collected = Buffer.concat([chunk, collected]);
      // 多读一行：缓冲区里的第一行可能是上一行的残段，除非读到了文件开头。
      if (count(collected, 0x0a) > wanted) break;
    }
    let partial = truncated;
    if (offset > 0 && !partial) {
      const previous = Buffer.alloc(1);
      readSync(handle, previous, 0, 1, offset - 1);
      partial = previous[0] !== 0x0a;
    }
    const text = collected.toString("utf8").replace(/\n+$/, "");
    if (text === "") return [];
    let split = text.split("\n");
    if (partial && split.length > 1) split = split.slice(1);
    if (split.length > wanted) split = split.slice(split.length - wanted);
    return split.map((line) => line.replace(/\r+$/, ""));
  } finally {
    closeSync(handle);
  }
}

function count(buffer: Buffer, byte: number): number {
  let found = 0;
  for (const value of buffer) if (value === byte) found += 1;
  return found;
}
