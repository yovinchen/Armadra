/**
 * 控制端这一侧的分块传输（Worker 那一半见 {@link ./transfer-worker}）。
 *
 * 一帧最多 16 MiB，base64 之后能带的内容约 11 MiB；比这大的上传与下载分成
 * 4 MiB 一块，一块一帧。上传的续传：某一块的请求因连接断开失败时，问 Worker
 * 「这个传输你已经收了多少」，从那里接着发——暂存在 Worker 的磁盘上，换了一个
 * Worker 进程也还在。Worker 太旧（不带 `remote.transfer.v1`）时调用方退回单帧。
 */

import { createHash, randomUUID } from "node:crypto";
import { DomainError } from "../workspaces/support";
import { type ExecutionTarget, executeOn } from "./execute";

/** 一块多少字节。 */
export const CHUNK_BYTES = 4 * 1024 * 1024;
/** 单个文件不超过这么大就直接放进帧里。 */
export const INLINE_FILE_BYTES = 1024 * 1024;
/** 一帧里直接带的内容合计不超过这么多。 */
export const INLINE_TOTAL_BYTES = 8 * 1024 * 1024;
/** 一块失败后最多续传几次。 */
const MAX_RESUMES = 3;

/** Worker 不认分块传输：调用方要退回单帧。 */
export function transferUnsupported(failure: unknown): boolean {
  return (
    failure instanceof DomainError &&
    failure.status === 501 &&
    failure.code === "unsupported"
  );
}

/** 连接层面的失败：换一个连接问一句收了多少，还能接着传。 */
function resumable(failure: unknown): boolean {
  if (!(failure instanceof DomainError)) return false;
  return (
    failure.code === "unavailable" ||
    failure.code === "unknown_outcome" ||
    failure.status === 503 ||
    failure.status === 504
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把一段字节分块传到执行主机的暂存里，答传输 id。 */
export async function upload(
  target: ExecutionTarget,
  bytes: Buffer,
): Promise<string> {
  const transferId = randomUUID();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const begin = async (): Promise<number> =>
    (
      (await executeOn(target, "transfer.begin", {
        transferId,
        size: bytes.byteLength,
        sha256,
      })) as { received: number }
    ).received;
  let received = await begin();
  let resumes = 0;
  while (received < bytes.byteLength) {
    try {
      const answer = (await executeOn(target, "transfer.chunk", {
        transferId,
        offset: received,
        base64: bytes
          .subarray(received, received + CHUNK_BYTES)
          .toString("base64"),
      })) as { received: number };
      received = answer.received;
    } catch (failure) {
      if (!resumable(failure) || resumes >= MAX_RESUMES) throw failure;
      resumes += 1;
      await sleep(200 * resumes);
      // 续传：从 Worker 已经收下的地方接着发。暂存没了（被清理）就从头来。
      const status = (await executeOn(target, "transfer.status", {
        transferId,
      })) as { received: number; size: number | null };
      received = status.size === null ? await begin() : status.received;
    }
  }
  return transferId;
}

/** 放弃一个传了一半或没用上的暂存；失败不要紧，Worker 一天后自己清。 */
export async function discard(
  target: ExecutionTarget,
  transferId: string,
): Promise<void> {
  try {
    await executeOn(target, "transfer.discard", { transferId });
  } catch {
    // 留给 Worker 的过期清理。
  }
}

/**
 * 分块下载一个文件。每块都带着文件当前的长度与修改时间；中途变了就是 409，
 * 而不是把两个版本的字节拼在一起交出去。
 */
export async function download(
  target: ExecutionTarget,
  path: string,
): Promise<{ path: string; bytes: Buffer }> {
  const chunks: Buffer[] = [];
  let offset = 0;
  let expected: { size: number; mtimeMs: number } | undefined;
  let name = path;
  for (;;) {
    const chunk = (await executeOn(target, "files.downloadChunk", {
      path,
      offset,
      length: CHUNK_BYTES,
    })) as {
      path: string;
      size: number;
      mtimeMs: number;
      base64: string;
    };
    if (
      expected !== undefined &&
      (chunk.size !== expected.size || chunk.mtimeMs !== expected.mtimeMs)
    ) {
      throw new DomainError(
        409,
        "conflict",
        "The file changed on the execution host while it was being downloaded",
      );
    }
    expected = { size: chunk.size, mtimeMs: chunk.mtimeMs };
    name = chunk.path;
    const bytes = Buffer.from(chunk.base64, "base64");
    chunks.push(bytes);
    offset += bytes.byteLength;
    if (offset >= chunk.size || bytes.byteLength === 0) break;
  }
  return { path: name, bytes: Buffer.concat(chunks) };
}
