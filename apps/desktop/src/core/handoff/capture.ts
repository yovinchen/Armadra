import { locate, readTail } from "../collab/transcript";
import { gitFingerprint } from "../git/fingerprint";
import {
  type FileReference,
  type GitFingerprint,
  fingerprintFiles,
} from "./bundle";

/**
 * 交接材料里要到「文件所在的那台机器」上读的部分：文件引用的指纹、Git 指纹与
 * 转录的尾巴。
 *
 * 本机工作空间在控制端直接调；远端工作空间经 Worker 的 `handoff.capture` 在执行
 * 主机上调同一个函数——读控制端磁盘上同名的路径，交出去的就是另一堆文件的指纹。
 * 转录跟着 Agent 走：SSH 终端里的 Agent 的转录在执行主机上，本机终端的在本机。
 */

/** 转录尾巴最多读这么多字节。 */
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

export interface CaptureRequest {
  readonly paths: readonly string[];
  /** 工作空间的执行授权：读索引可能跑仓库过滤器，没有就只给身份。 */
  readonly execute: boolean;
  /** 写进每条文件引用的 `executionHost`。 */
  readonly executionHost: string;
  /** 在这台机器上读转录：CLI 报来的路径，只认那一个。 */
  readonly transcript?: {
    readonly provider: string;
    readonly path: string;
  };
}

export interface Captured {
  readonly files: readonly FileReference[];
  readonly git: GitFingerprint;
  /** 要了转录时才有。 */
  readonly transcript?: TranscriptTail;
}

/**
 * 转录读到了什么：`missing` 是那个路径上没有文件（与没有转录同一个结论），
 * `unreadable` 是有文件但读的时候失败或变了。
 */
export type TranscriptTail =
  | { readonly state: "read"; readonly text: string }
  | { readonly state: "missing" }
  | { readonly state: "unreadable" };

export function readTranscriptTail(
  provider: string,
  path: string,
): TranscriptTail {
  const located = locate(provider, path, undefined);
  if (located === undefined) return { state: "missing" };
  try {
    return {
      state: "read",
      text: readTail(located.path, TRANSCRIPT_TAIL_BYTES),
    };
  } catch {
    return { state: "unreadable" };
  }
}

export function capture(root: string, request: CaptureRequest): Captured {
  const files = fingerprintFiles(root, request.paths).map((file) => ({
    ...file,
    executionHost: request.executionHost,
  }));
  const git = gitFingerprint({ rootPath: root, execute: request.execute });
  return {
    files,
    git,
    ...(request.transcript === undefined
      ? {}
      : {
          transcript: readTranscriptTail(
            request.transcript.provider,
            request.transcript.path,
          ),
        }),
  };
}

/** Worker 收到的参数，逐项核对后交给 {@link capture}。 */
export function captureArgs(args: Record<string, unknown>): CaptureRequest {
  const paths = Array.isArray(args.paths)
    ? args.paths.filter((path): path is string => typeof path === "string")
    : [];
  const transcript = args.transcript as
    | { provider?: unknown; path?: unknown }
    | undefined;
  return {
    paths: paths.slice(0, 32),
    execute: args.execute === true,
    executionHost:
      typeof args.executionHost === "string"
        ? args.executionHost
        : "local-runtime",
    ...(typeof transcript?.provider === "string" &&
    typeof transcript.path === "string"
      ? {
          transcript: {
            provider: transcript.provider,
            path: transcript.path,
          },
        }
      : {}),
  };
}
