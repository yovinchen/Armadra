import { GithubPullFile, GithubReviewComment } from "../../api/github";

/**
 * 把 GitHub 返回的 unified diff 拆成可以逐行评论的行（Git/GitHub 设计 §8
 * 「行内评论」）。
 *
 * 行内评论必须记下 path、左右侧和行号；这些数字**只**在 hunk 头里，所以这层
 * 存在的理由就是把它们算出来，而不是让界面按数组下标猜。
 *
 * 三条规矩：
 *  - **算不出行号的行不给评论入口。** hunk 头、`\ No newline at end of file`
 *    这类元数据行不是代码行，在上面留一个入口只会产出一条贴错位置的评论。
 *  - **左右侧分开。** 删除的行属于 LEFT（base），新增和上下文属于 RIGHT
 *    （head）。GitHub 的行内评论就是按这两侧定位的。
 *  - **读不懂就返回空。** patch 缺失或者 hunk 头解析不出来时，这个文件没有
 *    行内入口——普通评审评论仍然可用。
 */

export type DiffLineKind = "context" | "add" | "remove" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  /** 原样的一行（含前导的 ` `/`+`/`-`），界面直接显示。 */
  text: string;
  /** base 侧行号，`null` 表示这一行在 base 里不存在。 */
  leftLine: number | null;
  /** head 侧行号，`null` 表示这一行在 head 里不存在。 */
  rightLine: number | null;
}

/** 一条能被评论的位置：GitHub 需要的 path + line + side。 */
export interface CommentAnchor {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
}

/** hunk 头 `@@ -a,b +c,d @@`。行数缺省是 1。 */
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parsePatch(patch: string): DiffLine[] {
  if (!patch) return [];
  const lines: DiffLine[] = [];
  let left = 0;
  let right = 0;
  let started = false;
  for (const text of patch.split("\n")) {
    const hunk = HUNK.exec(text);
    if (hunk) {
      left = Number(hunk[1]);
      right = Number(hunk[3]);
      started = true;
      lines.push({ kind: "meta", text, leftLine: null, rightLine: null });
      continue;
    }
    // Anything before the first hunk header has no line numbers to attach to.
    if (!started) {
      lines.push({ kind: "meta", text, leftLine: null, rightLine: null });
      continue;
    }
    if (text.startsWith("+")) {
      lines.push({ kind: "add", text, leftLine: null, rightLine: right });
      right += 1;
    } else if (text.startsWith("-")) {
      lines.push({ kind: "remove", text, leftLine: left, rightLine: null });
      left += 1;
    } else if (text.startsWith(" ")) {
      lines.push({ kind: "context", text, leftLine: left, rightLine: right });
      left += 1;
      right += 1;
    } else {
      // `\ No newline at end of file`, and the empty final element `split`
      // leaves behind. Neither is a line of the file.
      lines.push({ kind: "meta", text, leftLine: null, rightLine: null });
    }
  }
  return lines;
}

/**
 * 这一行能不能被评论，以及评在哪一侧。
 *
 * 新增行评在 RIGHT，删除行评在 LEFT，上下文行按 RIGHT（head 上存在的那一份）。
 * 元数据行返回 `null`：没有位置可写。
 */
export function anchorFor(path: string, line: DiffLine): CommentAnchor | null {
  if (line.kind === "meta") return null;
  if (line.kind === "remove" && line.leftLine !== null)
    return { path, line: line.leftLine, side: "LEFT" };
  if (line.rightLine !== null)
    return { path, line: line.rightLine, side: "RIGHT" };
  return null;
}

/** 同一个位置的键，用来把草稿挂到行上，也用来防止同一行挂两条草稿。 */
export function anchorKey(anchor: CommentAnchor): string {
  return `${anchor.side}:${anchor.line}:${anchor.path}`;
}

/**
 * 已提交的行内评论，按位置分组。
 *
 * `outdated` 的那一条不会被挂到任何行上：它锚在另一个 commit 上，画到当前
 * diff 的同号行上就是贴错位置——设计 §8 明确要求不这么做。它们由调用方
 * 单独列出来并标明过期。
 */
export function commentsByAnchor(
  comments: readonly GithubReviewComment[],
): Map<string, GithubReviewComment[]> {
  const grouped = new Map<string, GithubReviewComment[]>();
  for (const comment of comments) {
    if (comment.outdated || comment.line <= 0n || !comment.path) continue;
    const side = comment.side === "LEFT" ? "LEFT" : "RIGHT";
    const key = anchorKey({
      path: comment.path,
      line: Number(comment.line),
      side,
    });
    const bucket = grouped.get(key);
    if (bucket) bucket.push(comment);
    else grouped.set(key, [comment]);
  }
  return grouped;
}

/** 有 patch 才有行内入口；二进制文件和被丢弃的大 patch 都没有。 */
export function commentable(file: GithubPullFile): boolean {
  return !file.binary && file.patch.length > 0;
}
