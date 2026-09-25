/**
 * Git 行边标记的计算（编辑器设计 §2「Git 行边标记」）。
 *
 * core 没有「取 HEAD 里这个文件」的接口，但 `git/diff` 已经给出两段 patch：
 * 工作区 → 索引（`worktree`）与索引 → HEAD（`staged`）。拿磁盘上的正文把
 * 两段依次**倒着打回去**，就得到 HEAD 的行；之后每次按键都拿编辑器里的
 * 行和它比，标记跟着草稿走，而不是等保存。
 *
 * 倒打时逐行核对 patch 里的上下文与新增行。对不上（取 diff 与读文件之间
 * 磁盘又变了）就放弃这一轮，宁可没有标记，也不画错位的标记。
 */
import { lineOperations } from "@/lib/line-diff";

export type GutterKind = "added" | "modified" | "removed";

export interface GutterMark {
  /** 1 起的行号，按编辑器现在的正文。 */
  line: number;
  kind: GutterKind;
}

/** 按行切，末尾换行不算一行；`\r` 去掉，CRLF 文件与 patch 才对得上。 */
export function linesOf(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * 把一段 unified patch 倒着打回 `after`，返回 patch 之前的行。
 * 核对失败返回 `null`。
 */
export function unapplyPatch(
  patch: string,
  after: readonly string[],
): string[] | null {
  const before: string[] = [];
  let cursor = 0;
  const rows = patch.split("\n");
  let index = 0;
  while (index < rows.length) {
    const header = HUNK.exec(rows[index] ?? "");
    index += 1;
    if (!header) continue;
    const newStart = Number(header[3]);
    const newCount = header[4] === undefined ? 1 : Number(header[4]);
    // 新侧为空的 hunk，起点写的是「在它之后」的那一行。
    const start = newCount === 0 ? newStart : newStart - 1;
    if (start < cursor || start > after.length) return null;
    before.push(...after.slice(cursor, start));
    cursor = start;
    while (index < rows.length && !HUNK.test(rows[index] ?? "")) {
      const row = (rows[index] ?? "").replace(/\r$/, "");
      index += 1;
      const sign = row[0];
      const text = row.slice(1);
      if (sign === " ") {
        if (after[cursor] !== text) return null;
        before.push(text);
        cursor += 1;
      } else if (sign === "+") {
        if (after[cursor] !== text) return null;
        cursor += 1;
      } else if (sign === "-") {
        before.push(text);
      }
      // `\ No newline at end of file` 与其余非正文行不影响行内容。
    }
  }
  if (cursor > after.length) return null;
  before.push(...after.slice(cursor));
  return before;
}

/**
 * 相对 `head` 的标记：一段只有新增是 `added`，新增里夹着删除是 `modified`，
 * 只删不增在删除位置的下一行画 `removed`（删在末尾就画在最后一行）。
 */
export function gutterMarks(
  head: readonly string[],
  current: readonly string[],
): GutterMark[] {
  const operations = lineOperations(head, current);
  const marks: GutterMark[] = [];
  let line = 1;
  let index = 0;
  while (index < operations.length) {
    if (operations[index]?.sign === " ") {
      line += 1;
      index += 1;
      continue;
    }
    let added = 0;
    let removed = 0;
    while (index < operations.length && operations[index]?.sign !== " ") {
      if (operations[index]?.sign === "+") added += 1;
      else removed += 1;
      index += 1;
    }
    if (added === 0) {
      const at = Math.max(1, Math.min(line, current.length));
      if (current.length > 0) marks.push({ line: at, kind: "removed" });
      continue;
    }
    const kind: GutterKind = removed > 0 ? "modified" : "added";
    for (let offset = 0; offset < added; offset += 1)
      marks.push({ line: line + offset, kind });
    line += added;
  }
  return marks;
}

/** 一个文件在 `git/diff` 两个作用域里的样子；不在列表里就是 `undefined`。 */
export interface FileDiffs {
  worktree?: { status: string; patch: string; previewable: boolean };
  staged?: { status: string; patch: string; previewable: boolean };
}

/**
 * 从磁盘正文与两段 patch 还原 HEAD 的行。`null` 是「画不出来」：二进制、
 * patch 被截断、或者核对失败。
 */
export function headLines(disk: string, diffs: FileDiffs): string[] | null {
  const { worktree, staged } = diffs;
  // 未跟踪、或者刚 `git add` 的新文件：HEAD 里没有它，整份都是新增。
  if (worktree?.status === "?" || staged?.status === "A") return [];
  let lines = linesOf(disk);
  for (const diff of [worktree, staged]) {
    if (!diff) continue;
    if (!diff.previewable) return null;
    const before = unapplyPatch(diff.patch, lines);
    if (!before) return null;
    lines = before;
  }
  return lines;
}
