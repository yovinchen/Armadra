/**
 * 把 Git unified patch 排成并排两列（G01/M4）。
 *
 * 只做排版，不重新计算差异：行的增删归属完全来自 patch 本身，行号来自
 * `@@` 头，所以并排视图和统一视图看到的是同一份 Git 结果。二进制、重命名
 * 之类的元信息行原样保留为 `meta`，不假装它们是内容。
 */

export type SideBySideKind = "hunk" | "context" | "change" | "meta";

export interface SideBySideCell {
  /** 1 起的行号；补齐用的空格没有行号。 */
  number: number | null;
  text: string;
}

export interface SideBySideRow {
  kind: SideBySideKind;
  left: SideBySideCell | null;
  right: SideBySideCell | null;
}

/** `@@ -12,7 +12,9 @@` → 左右两侧的起始行号。 */
function parseHunkHeader(line: string): { left: number; right: number } | null {
  const match = /^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!match) return null;
  return { left: Number(match[1]), right: Number(match[2]) };
}

/**
 * 删除块和新增块按顺序配对：第 i 行删除对应第 i 行新增，多出来的一侧
 * 另一边留空。这是并排视图的常规做法，也不会把不相干的行凑成一对——
 * 配对只发生在同一个连续块内。
 */
function pair(
  removed: SideBySideCell[],
  added: SideBySideCell[],
): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  for (let index = 0; index < Math.max(removed.length, added.length); index++) {
    rows.push({
      kind: "change",
      left: removed[index] ?? null,
      right: added[index] ?? null,
    });
  }
  return rows;
}

export function sideBySideRows(patch: string): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let leftNumber = 0;
  let rightNumber = 0;
  let removed: SideBySideCell[] = [];
  let added: SideBySideCell[] = [];
  const flush = () => {
    if (removed.length || added.length) rows.push(...pair(removed, added));
    removed = [];
    added = [];
  };
  for (const line of patch.split("\n")) {
    const hunk = parseHunkHeader(line);
    if (hunk) {
      flush();
      leftNumber = hunk.left;
      rightNumber = hunk.right;
      rows.push({
        kind: "hunk",
        left: { number: null, text: line },
        right: { number: null, text: line },
      });
      continue;
    }
    // `---`/`+++` 是文件头，不是内容行，必须在增删判断之前排除。
    if (
      line.startsWith("---") ||
      line.startsWith("+++") ||
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("\\ ") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename from") ||
      line.startsWith("rename to") ||
      line.startsWith("Binary files")
    ) {
      flush();
      rows.push({
        kind: "meta",
        left: { number: null, text: line },
        right: { number: null, text: line },
      });
      continue;
    }
    if (line.startsWith("-")) {
      removed.push({ number: leftNumber++, text: line.slice(1) });
      continue;
    }
    if (line.startsWith("+")) {
      added.push({ number: rightNumber++, text: line.slice(1) });
      continue;
    }
    flush();
    // 上下文行（前导空格）和补丁末尾的空串都按上下文处理。
    const text = line.startsWith(" ") ? line.slice(1) : line;
    if (text === "" && rows.length === 0) continue;
    rows.push({
      kind: "context",
      left: { number: leftNumber++, text },
      right: { number: rightNumber++, text },
    });
  }
  flush();
  return rows;
}

/** 命中搜索词的行数；空词表示没有搜索。 */
export function countMatches(rows: readonly SideBySideRow[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  return rows.filter((row) => rowMatches(row, needle)).length;
}

export function rowMatches(row: SideBySideRow, lowercaseQuery: string) {
  if (!lowercaseQuery) return false;
  return [row.left?.text, row.right?.text].some((text) =>
    text?.toLowerCase().includes(lowercaseQuery),
  );
}
