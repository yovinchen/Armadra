/**
 * Worker 这一侧的分块传输：比一帧大的字节分几帧上传、分几帧下载。
 *
 * 帧本身不变（一帧仍是一个完整的 JSON，上限 16 MiB，见 {@link ./frames}）；
 * 分块是帧之上的一组动作：
 *
 *  * `transfer.begin {transferId, size, sha256}`：控制端自己取 id，所以重发一次
 *    begin 就是同一个传输，可以重放；
 *  * `transfer.chunk {transferId, offset, base64}`：只接在已收字节的末尾或之前
 *    （之前的是重发，按位置覆盖同样的字节），答已收多少——同样可以重放；
 *  * `transfer.status {transferId}`：续传用。连接断了、Worker 换了一个，暂存还
 *    在磁盘上，控制端问一句从哪里接着发；
 *  * 消费方（导入、白板资产）拿 `transferId` 取字节时核对长度与 SHA-256，取完删掉。
 *
 * 暂存在 `<状态目录>/transfers/`，不随 Worker 会话收掉——正是为了续传。放了一天
 * 还没被取走的，下一次 begin 时清掉。
 *
 * 下载反过来：`files.downloadChunk {path, offset, length}` 答这一段与文件当前的
 * 长度和修改时间，控制端据此发现「下到一半文件变了」。
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { MAX_FILE_BYTES } from "../imports/limits";
import { DomainError, badRequest } from "../workspaces/support";
import { stateBase } from "./integration-worker";

/** 一个传输最大多少字节：一批导入的上限。 */
export const MAX_TRANSFER_BYTES = 64 * 1024 * 1024;
/** 一块最多多少字节（base64 之前）：一帧放得下，还留足信封。 */
export const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
/** 暂存放多久没人取就清掉。 */
const STALE_MS = 24 * 60 * 60_000;

const ID = /^[A-Za-z0-9-]{8,64}$/u;

interface Meta {
  readonly size: number;
  readonly sha256: string;
  readonly createdAt: number;
}

function directory(stateDir: string | undefined): string {
  return join(stateBase(stateDir), "transfers");
}

function paths(
  stateDir: string | undefined,
  id: unknown,
): { part: string; meta: string } {
  if (typeof id !== "string" || !ID.test(id)) {
    throw badRequest("transferId is invalid");
  }
  const base = directory(stateDir);
  return { part: join(base, `${id}.part`), meta: join(base, `${id}.json`) };
}

function readMeta(path: string): Meta | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Meta;
  } catch {
    return undefined;
  }
}

function received(part: string): number {
  try {
    return statSync(part).size;
  } catch {
    return 0;
  }
}

function sweep(stateDir: string | undefined): void {
  const base = directory(stateDir);
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const meta = readMeta(join(base, name));
    if (meta !== undefined && now - meta.createdAt < STALE_MS) continue;
    const id = name.slice(0, -".json".length);
    rmSync(join(base, `${id}.part`), { force: true });
    rmSync(join(base, name), { force: true });
  }
}

export function beginTransfer(
  stateDir: string | undefined,
  args: Record<string, unknown>,
): { transferId: string; received: number } {
  const { part, meta } = paths(stateDir, args.transferId);
  const size = args.size;
  const sha256 = args.sha256;
  if (
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > MAX_TRANSFER_BYTES ||
    typeof sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(sha256)
  ) {
    throw badRequest("A transfer needs a size and a SHA-256");
  }
  const existing = readMeta(meta);
  if (existing !== undefined) {
    if (existing.size !== size || existing.sha256 !== sha256) {
      throw new DomainError(
        409,
        "conflict",
        "This transfer id is already used for other bytes",
      );
    }
    return { transferId: args.transferId as string, received: received(part) };
  }
  sweep(stateDir);
  mkdirSync(directory(stateDir), { recursive: true, mode: 0o700 });
  writeFileSync(part, Buffer.alloc(0), { mode: 0o600 });
  writeFileSync(
    meta,
    JSON.stringify({ size, sha256, createdAt: Date.now() } satisfies Meta),
    { mode: 0o600 },
  );
  return { transferId: args.transferId as string, received: 0 };
}

export function writeChunk(
  stateDir: string | undefined,
  args: Record<string, unknown>,
): { received: number } {
  const { part, meta } = paths(stateDir, args.transferId);
  const info = readMeta(meta);
  if (info === undefined) {
    throw new DomainError(404, "not_found", "The transfer is not staged here");
  }
  const offset = args.offset;
  if (
    typeof offset !== "number" ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    typeof args.base64 !== "string"
  ) {
    throw badRequest("A chunk needs an offset and bytes");
  }
  const bytes = Buffer.from(args.base64, "base64");
  if (bytes.byteLength > MAX_CHUNK_BYTES) {
    throw badRequest("A chunk is larger than one frame may carry");
  }
  const have = received(part);
  // 只能接在已收的末尾（或重发已收的一段）：中间留洞的文件核对不出来。
  if (offset > have) {
    throw new DomainError(
      409,
      "conflict",
      `The transfer has ${have} bytes; a chunk at ${offset} leaves a gap`,
    );
  }
  if (offset + bytes.byteLength > info.size) {
    throw badRequest("A chunk runs past the declared size");
  }
  const handle = openSync(part, "r+");
  try {
    writeSync(handle, bytes, 0, bytes.byteLength, offset);
  } finally {
    closeSync(handle);
  }
  return { received: received(part) };
}

export function transferStatus(
  stateDir: string | undefined,
  args: Record<string, unknown>,
): { received: number; size: number | null } {
  const { part, meta } = paths(stateDir, args.transferId);
  const info = readMeta(meta);
  return {
    received: info === undefined ? 0 : received(part),
    size: info?.size ?? null,
  };
}

export function discardTransfer(
  stateDir: string | undefined,
  args: Record<string, unknown>,
): { discarded: boolean } {
  const { part, meta } = paths(stateDir, args.transferId);
  const existed = readMeta(meta) !== undefined;
  rmSync(part, { force: true });
  rmSync(meta, { force: true });
  return { discarded: existed };
}

/**
 * 取出一个已传完的传输的字节：长度与哈希都要对上。`consume` 为真时取完就删。
 */
export function takeTransfer(
  stateDir: string | undefined,
  id: unknown,
  consume = true,
): Buffer {
  const { part, meta } = paths(stateDir, id);
  const info = readMeta(meta);
  if (info === undefined) {
    throw new DomainError(404, "not_found", "The transfer is not staged here");
  }
  const bytes = readFileSync(part);
  if (
    bytes.byteLength !== info.size ||
    createHash("sha256").update(bytes).digest("hex") !== info.sha256
  ) {
    throw new DomainError(
      409,
      "conflict",
      "The transfer is incomplete or does not match its hash",
    );
  }
  if (consume) {
    rmSync(part, { force: true });
    rmSync(meta, { force: true });
  }
  return bytes;
}

/* ---------------------------------- 下载 ---------------------------------- */

export interface DownloadChunk {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly offset: number;
  readonly base64: string;
}

/**
 * 文件的一段。`resolve` 是文件域的路径规则（留在根里、不跟符号链接逃出去），
 * 由调用方传进来，这里只读字节。
 */
export function readChunk(
  resolved: { readonly absolute: string; readonly relative: string },
  args: Record<string, unknown>,
): DownloadChunk {
  const offset = args.offset;
  const length = args.length;
  if (
    typeof offset !== "number" ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length <= 0
  ) {
    throw badRequest("A download chunk needs an offset and a length");
  }
  const info = statSync(resolved.absolute);
  if (!info.isFile()) throw badRequest("Requested path is not a file");
  if (info.size > MAX_FILE_BYTES) {
    throw badRequest("File exceeds the 16 MiB download limit");
  }
  const size = Math.max(
    0,
    Math.min(length, MAX_CHUNK_BYTES, info.size - offset),
  );
  const buffer = Buffer.alloc(size);
  const handle = openSync(resolved.absolute, "r");
  try {
    let filled = 0;
    while (filled < size) {
      const read = readSync(
        handle,
        buffer,
        filled,
        size - filled,
        offset + filled,
      );
      if (read === 0) break;
      filled += read;
    }
  } finally {
    closeSync(handle);
  }
  return {
    path: resolved.relative,
    size: info.size,
    mtimeMs: info.mtimeMs,
    offset,
    base64: buffer.toString("base64"),
  };
}
