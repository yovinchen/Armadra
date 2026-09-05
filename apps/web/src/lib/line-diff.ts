/**
 * 行级差异，输出与 Git unified patch 同形的行（E01/M4）。
 *
 * 编辑器发现磁盘版和草稿不一致时用它渲染「比较」，复用变更节点的
 * `PatchBody` 着色，不引入新的 diff 依赖，也不冒充 Git 的 diff 算法：
 * 这里只比较两段文本的行，不做重命名检测，也不做词级高亮。
 */

/** 超过这个规模就不做 LCS（O(n·m) 会卡住主线程），整段按替换呈现。 */
const MAX_LCS_LINES = 800;

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  // 末尾换行会切出一个空串，它不是一行内容。
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type Sign = " " | "-" | "+";
interface Operation {
  sign: Sign;
  text: string;
}

function backtrack(left: string[], right: string[]): Operation[] {
  const width = right.length + 1;
  const table = new Uint32Array((left.length + 1) * width);
  for (let row = left.length - 1; row >= 0; row -= 1) {
    for (let column = right.length - 1; column >= 0; column -= 1) {
      table[row * width + column] =
        left[row] === right[column]
          ? (table[(row + 1) * width + column + 1] ?? 0) + 1
          : Math.max(
              table[(row + 1) * width + column] ?? 0,
              table[row * width + column + 1] ?? 0,
            );
    }
  }
  const operations: Operation[] = [];
  let row = 0;
  let column = 0;
  while (row < left.length && column < right.length) {
    const leftLine = left[row] ?? "";
    const rightLine = right[column] ?? "";
    if (leftLine === rightLine) {
      operations.push({ sign: " ", text: leftLine });
      row += 1;
      column += 1;
    } else if (
      (table[(row + 1) * width + column] ?? 0) >=
      (table[row * width + column + 1] ?? 0)
    ) {
      operations.push({ sign: "-", text: leftLine });
      row += 1;
    } else {
      operations.push({ sign: "+", text: rightLine });
      column += 1;
    }
  }
  for (const text of left.slice(row)) operations.push({ sign: "-", text });
  for (const text of right.slice(column)) operations.push({ sign: "+", text });
  return operations;
}

/** 公共前后缀先剥掉，中间才做 LCS；超限时整段按删除 + 新增呈现。 */
function operationsOf(before: string[], after: string[]): Operation[] {
  let head = 0;
  while (
    head < before.length &&
    head < after.length &&
    before[head] === after[head]
  )
    head += 1;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail += 1;

  const left = before.slice(head, before.length - tail);
  const right = after.slice(head, after.length - tail);
  const middle: Operation[] =
    left.length > MAX_LCS_LINES || right.length > MAX_LCS_LINES
      ? [
          ...left.map((text): Operation => ({ sign: "-", text })),
          ...right.map((text): Operation => ({ sign: "+", text })),
        ]
      : backtrack(left, right);

  return [
    ...before.slice(0, head).map((text): Operation => ({ sign: " ", text })),
    ...middle,
    ...before
      .slice(before.length - tail)
      .map((text): Operation => ({ sign: " ", text })),
  ];
}

/**
 * `before` → `after` 的 unified patch 正文（不含文件头）。
 * 两段文本一致时返回空串，调用方据此显示「无差异」。
 */
export function unifiedLineDiff(
  before: string,
  after: string,
  context = 3,
): string {
  if (before === after) return "";
  const operations = operationsOf(splitLines(before), splitLines(after));

  // 每个操作在两侧的 1-based 行号，hunk 头直接查表，不再边走边算。
  const beforeAt: number[] = [];
  const afterAt: number[] = [];
  let beforeLine = 1;
  let afterLine = 1;
  for (const operation of operations) {
    beforeAt.push(beforeLine);
    afterAt.push(afterLine);
    if (operation.sign !== "+") beforeLine += 1;
    if (operation.sign !== "-") afterLine += 1;
  }

  const output: string[] = [];
  let index = 0;
  let previousEnd = 0;
  while (index < operations.length) {
    if (operations[index]?.sign === " ") {
      index += 1;
      continue;
    }
    const start = Math.max(previousEnd, index - context);
    // 相邻变更之间的上下文不超过 2×context 时并进同一个 hunk。
    let end = index + 1;
    let gap = 0;
    while (end < operations.length) {
      if (operations[end]?.sign !== " ") {
        gap = 0;
        end += 1;
        continue;
      }
      if (gap >= context * 2) break;
      gap += 1;
      end += 1;
    }
    end -= Math.max(0, gap - context);

    let beforeCount = 0;
    let afterCount = 0;
    const body: string[] = [];
    for (const operation of operations.slice(start, end)) {
      if (operation.sign !== "+") beforeCount += 1;
      if (operation.sign !== "-") afterCount += 1;
      body.push(`${operation.sign}${operation.text}`);
    }
    output.push(
      `@@ -${beforeAt[start] ?? 1},${beforeCount} +${afterAt[start] ?? 1},${afterCount} @@`,
      ...body,
    );
    previousEnd = end;
    index = end;
  }
  return output.join("\n");
}
