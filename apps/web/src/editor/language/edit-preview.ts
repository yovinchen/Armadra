import type { ApplyLanguageEditResult } from "@armadra/shared";

import { runtimeApi } from "@/api/client";
import { unifiedLineDiff } from "@/lib/line-diff";
import { openFileState } from "./open-files";
import { isExternalUri, pathOfUri } from "./uri";

/**
 * `WorkspaceEdit` 的预览与应用（语言服务设计 §2.6）。
 *
 * 重命名、代码操作、跨文件格式化都会回一个 `WorkspaceEdit`。它可能改十几个
 * 文件，其中大部分没有打开——所以这里不是「先改了再说」，而是：
 *
 *  1. 逐文件取现在的正文（打开的取缓冲，没打开的从 Runtime 读），算出改完
 *     的样子和一份 unified diff；
 *  2. 任何一条走不通（工作空间之外、增删改文件名、有未保存草稿、读不到）
 *     就标 blocked，**整个编辑不可应用**——半个重命名比不重命名更糟；
 *  3. 用户确认后由执行主机逐文件按 `expectedSha256` 写入，返回 applied /
 *     failed 两张表。
 *
 * 内容版本是唯一的凭据：预览是对着某一版正文算的，写的时候那一版还在，
 * 才是同一次编辑。
 */

/** 一条 LSP `TextEdit`。 */
export interface TextEdit {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  newText: string;
}

export type BlockedReason =
  | "external"
  | "fileOperation"
  | "dirty"
  | "unreadable"
  | "noVersion";

export interface EditPreviewFile {
  uri: string;
  /** 工作空间相对路径；`external` 的项没有。 */
  path: string | null;
  /** unified diff，空串表示这个文件其实没被改动。 */
  patch: string;
  /** 预览所对着的内容版本，应用时原样送回去。 */
  expectedSha256?: string;
  blocked?: BlockedReason;
}

export interface EditPreview {
  workspaceId: string;
  sessionId: string;
  /** 对话框标题上的动作名，例如「重命名 foo → bar」。 */
  title: string;
  /** 原样的 `WorkspaceEdit`；应用时送回 Runtime，不在 Web 重新拼。 */
  edit: unknown;
  files: EditPreviewFile[];
  /** 有任何一项 blocked。 */
  blocked: boolean;
}

/* ------------------------------ TextEdit 应用 ------------------------------ */

/** 每行起点在整份正文里的偏移；`character` 是 UTF-16 码元，与 JS 下标一致。 */
function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") offsets.push(index + 1);
  }
  return offsets;
}

function offsetOf(
  offsets: number[],
  text: string,
  position: { line: number; character: number },
): number {
  const line = Math.max(position.line, 0);
  const start = offsets[line];
  if (start === undefined) return text.length;
  const end = offsets[line + 1] ?? text.length;
  return Math.min(start + Math.max(position.character, 0), end);
}

/**
 * 把一组 `TextEdit` 应用到正文。
 *
 * 从后往前改，前面的偏移就不会被后面的改动挪动；这是 LSP 规范建议的顺序，
 * 也是唯一不需要重新计算偏移的顺序。
 */
export function applyTextEdits(text: string, edits: TextEdit[]): string {
  const offsets = lineOffsets(text);
  const ranges = edits
    .map((edit) => ({
      from: offsetOf(offsets, text, edit.range.start),
      to: offsetOf(offsets, text, edit.range.end),
      insert: edit.newText,
    }))
    .sort((left, right) => right.from - left.from || right.to - left.to);
  let result = text;
  for (const range of ranges) {
    const from = Math.min(range.from, range.to);
    const to = Math.max(range.from, range.to);
    result = result.slice(0, from) + range.insert + result.slice(to);
  }
  return result;
}

/* --------------------------------- 预览 ---------------------------------- */

interface ParsedFile {
  uri: string;
  edits: TextEdit[];
  /** 这一项是 create / rename / delete，首版不应用。 */
  fileOperation?: boolean;
}

/** `WorkspaceEdit` 的两种形状：`documentChanges`（有序）与 `changes`（映射）。 */
export function parseWorkspaceEdit(edit: unknown): ParsedFile[] {
  const value = edit as {
    changes?: Record<string, TextEdit[]>;
    documentChanges?: unknown[];
  } | null;
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value.documentChanges)) {
    return value.documentChanges.map((change) => {
      const entry = change as {
        kind?: string;
        textDocument?: { uri?: string };
        edits?: TextEdit[];
      };
      if (entry.kind) {
        return {
          uri: entry.textDocument?.uri ?? "",
          edits: [],
          fileOperation: true,
        };
      }
      return {
        uri: entry.textDocument?.uri ?? "",
        edits: Array.isArray(entry.edits) ? entry.edits : [],
      };
    });
  }
  if (value.changes && typeof value.changes === "object") {
    // 映射本身没有顺序；排一下，applied / failed 两张表才是可复现的。
    return Object.entries(value.changes)
      .map(([uri, edits]) => ({
        uri,
        edits: Array.isArray(edits) ? edits : [],
      }))
      .sort((left, right) => left.uri.localeCompare(right.uri));
  }
  return [];
}

/**
 * 逐文件算出预览。
 *
 * 打开的文件用编辑器缓冲：预览必须显示用户正看着的正文，而不是磁盘上的。
 * 但脏文件直接标 blocked——应用会经磁盘写，草稿会被覆盖。
 */
export async function buildEditPreview(options: {
  workspaceId: string;
  sessionId: string;
  title: string;
  edit: unknown;
}): Promise<EditPreview> {
  const { workspaceId, sessionId, title, edit } = options;
  const parsed = parseWorkspaceEdit(edit);
  const files: EditPreviewFile[] = [];

  for (const entry of parsed) {
    if (isExternalUri(entry.uri)) {
      files.push({
        uri: entry.uri,
        path: null,
        patch: "",
        blocked: "external",
      });
      continue;
    }
    if (entry.fileOperation) {
      const path = pathOfUri(entry.uri);
      files.push({
        uri: entry.uri,
        path,
        patch: "",
        blocked: "fileOperation",
      });
      continue;
    }
    const path = pathOfUri(entry.uri);
    if (!path) {
      files.push({
        uri: entry.uri,
        path: null,
        patch: "",
        blocked: "external",
      });
      continue;
    }
    const open = openFileState(path);
    if (open?.dirty) {
      files.push({ uri: entry.uri, path, patch: "", blocked: "dirty" });
      continue;
    }
    let before: string;
    let sha256: string | undefined;
    if (open) {
      before = open.read();
      sha256 = open.sha256;
    } else {
      try {
        const file = await runtimeApi.readFile(workspaceId, path);
        before = file.content;
        sha256 = file.sha256;
      } catch {
        files.push({ uri: entry.uri, path, patch: "", blocked: "unreadable" });
        continue;
      }
    }
    if (!sha256) {
      // 没有内容版本就没有凭据可写（非 UTF-8 或旧 Runtime）。
      files.push({ uri: entry.uri, path, patch: "", blocked: "noVersion" });
      continue;
    }
    files.push({
      uri: entry.uri,
      path,
      patch: unifiedLineDiff(before, applyTextEdits(before, entry.edits)),
      expectedSha256: sha256,
    });
  }

  return {
    workspaceId,
    sessionId,
    title,
    edit,
    files,
    blocked: files.some((file) => file.blocked !== undefined),
  };
}

/**
 * 确认后交给执行主机写。
 *
 * `expectedSha256` 里缺的路径表示「这个文件必须还不存在」；预览里每个可应用
 * 的项都有版本，所以这里的缺席只可能来自 blocked 项，而 blocked 的预览根本
 * 不会走到这里。
 */
export function applyEditPreview(
  preview: EditPreview,
): Promise<ApplyLanguageEditResult> {
  const expected: Record<string, string> = {};
  for (const file of preview.files) {
    if (file.path && file.expectedSha256)
      expected[file.path] = file.expectedSha256;
  }
  return runtimeApi.applyLanguageEdit(
    preview.workspaceId,
    preview.sessionId,
    preview.edit,
    expected,
  );
}
