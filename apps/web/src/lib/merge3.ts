/**
 * 三方行合并（diff3），给编辑器的冲突视图用。
 *
 * 只做行级，不做词级，也不做重命名检测——和 `line-diff.ts` 一样，这里不冒充
 * Git 的算法，只把「哪几行两边各自改了」算清楚。做法是标准的 diff3：
 *
 *  1. base→ours 与 base→theirs 各算一次对齐，得到两侧在 base 行号上的改动；
 *  2. 顺着 base 走：两边都没动的是稳定段，只有一边动的直接取那一边，
 *     两边都动了才是冲突段；
 *  3. 冲突段把三份原文都留着，由界面让人挑，而不是这里替人选一个。
 *
 * 关键的一条：**两边改成了同一样东西不是冲突。** 那种情况在很多合并里占了
 * 一半，把它报成冲突等于让人反复确认自己没做过选择的事。
 */

const MAX_LCS_LINES = 2_000;

export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  // 末尾换行会切出一个空串，它不是一行内容。
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** 一段稳定的、三方一致的正文。 */
export interface StableRegion {
  kind: "stable";
  lines: string[];
}

/** 两边都动过同一段 base 的地方。三份原文都留着。 */
export interface ConflictRegion {
  kind: "conflict";
  base: string[];
  ours: string[];
  theirs: string[];
}

export type MergeRegion = StableRegion | ConflictRegion;

/**
 * base 的每一行在某一侧的位置：`matched[i]` 是 base 第 i 行在那一侧的行号，
 * 没有对应（这一行被删或被改）时是 `-1`。
 */
function align(base: string[], side: string[]): number[] {
  const matched = new Array<number>(base.length).fill(-1);
  let head = 0;
  while (
    head < base.length &&
    head < side.length &&
    base[head] === side[head]
  ) {
    matched[head] = head;
    head += 1;
  }
  let tail = 0;
  while (
    tail < base.length - head &&
    tail < side.length - head &&
    base[base.length - 1 - tail] === side[side.length - 1 - tail]
  ) {
    matched[base.length - 1 - tail] = side.length - 1 - tail;
    tail += 1;
  }
  const left = base.slice(head, base.length - tail);
  const right = side.slice(head, side.length - tail);
  // 剥掉公共前后缀之后仍然太大就不做 LCS：O(n·m) 会把主线程卡住，整段当作
  // 「都改了」处理，界面照样能让人整段挑一边。
  if (left.length > MAX_LCS_LINES || right.length > MAX_LCS_LINES)
    return matched;
  for (const [leftIndex, rightIndex] of commonLines(left, right))
    matched[head + leftIndex] = head + rightIndex;
  return matched;
}

/** LCS 回溯出的相同行对。 */
function commonLines(left: string[], right: string[]): Array<[number, number]> {
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
  const pairs: Array<[number, number]> = [];
  let row = 0;
  let column = 0;
  while (row < left.length && column < right.length) {
    if (left[row] === right[column]) {
      pairs.push([row, column]);
      row += 1;
      column += 1;
    } else if (
      (table[(row + 1) * width + column] ?? 0) >=
      (table[row * width + column + 1] ?? 0)
    ) {
      row += 1;
    } else {
      column += 1;
    }
  }
  return pairs;
}

/**
 * base / ours / theirs → 一串区段。
 *
 * 稳定段是三方一致的正文；冲突段带着三份原文。相邻的稳定段会合并成一段，
 * 界面因此不会被切成一堆一行的块。
 */
export function merge3(
  base: string,
  ours: string,
  theirs: string,
): MergeRegion[] {
  const baseLines = splitLines(base);
  const ourLines = splitLines(ours);
  const theirLines = splitLines(theirs);
  const toOurs = align(baseLines, ourLines);
  const toTheirs = align(baseLines, theirLines);

  const regions: MergeRegion[] = [];
  let baseAt = 0;
  let ourAt = 0;
  let theirAt = 0;

  const pushStable = (lines: string[]) => {
    if (lines.length === 0) return;
    const last = regions[regions.length - 1];
    if (last?.kind === "stable") last.lines.push(...lines);
    else regions.push({ kind: "stable", lines });
  };

  const push = (region: MergeRegion) => {
    if (region.kind === "stable") pushStable(region.lines);
    else regions.push(region);
  };

  while (baseAt < baseLines.length) {
    const ourLine = toOurs[baseAt] ?? -1;
    const theirLine = toTheirs[baseAt] ?? -1;
    if (ourLine >= 0 && theirLine >= 0) {
      // 这一行两边都还在。它*前面*两边各自插进去的内容先结成一段——插入的
      // 位置就在这里，不该被并进后面某个删除段里去。
      if (ourLine > ourAt || theirLine > theirAt) {
        push(
          regionFor(
            [],
            ourLines.slice(ourAt, ourLine),
            theirLines.slice(theirAt, theirLine),
          ),
        );
        ourAt = ourLine;
        theirAt = theirLine;
      }
      pushStable([baseLines[baseAt]!]);
      baseAt += 1;
      ourAt += 1;
      theirAt += 1;
      continue;
    }
    // 这一行至少有一边没有了。走到下一处两边都还在的 base 行，中间整段是
    // 一次改动。
    let next = baseAt + 1;
    while (
      next < baseLines.length &&
      !((toOurs[next] ?? -1) >= 0 && (toTheirs[next] ?? -1) >= 0)
    )
      next += 1;
    const ourEnd = next < baseLines.length ? toOurs[next]! : ourLines.length;
    const theirEnd =
      next < baseLines.length ? toTheirs[next]! : theirLines.length;
    push(
      regionFor(
        baseLines.slice(baseAt, next),
        ourLines.slice(ourAt, ourEnd),
        theirLines.slice(theirAt, theirEnd),
      ),
    );
    baseAt = next;
    ourAt = ourEnd;
    theirAt = theirEnd;
  }

  // base 走完之后两边各自追加的尾巴。
  const ourTail = ourLines.slice(ourAt);
  const theirTail = theirLines.slice(theirAt);
  if (ourTail.length > 0 || theirTail.length > 0)
    push(regionFor([], ourTail, theirTail));
  return regions;
}

/**
 * 一段改动到底算什么。
 *
 * 两边改成一样 → 稳定；只有一边改 → 取那一边，也是稳定；两边都改且不同 →
 * 冲突。这一层是 diff3 与「把每处差异都问一遍」的分界。
 */
function regionFor(
  base: string[],
  ours: string[],
  theirs: string[],
): MergeRegion {
  const same = (left: string[], right: string[]) =>
    left.length === right.length &&
    left.every((line, index) => line === right[index]);
  if (same(ours, theirs)) return { kind: "stable", lines: ours };
  if (same(base, ours)) return { kind: "stable", lines: theirs };
  if (same(base, theirs)) return { kind: "stable", lines: ours };
  return { kind: "conflict", base, ours, theirs };
}

/** 每个冲突段选了哪一侧。稳定段没有选择。 */
export type Choice = "ours" | "theirs" | "both" | "base" | "none";

/** 一次选择下的合并结果正文。 */
export function textOf(
  regions: MergeRegion[],
  choices: readonly Choice[],
  trailingNewline: boolean,
): string {
  const lines: string[] = [];
  let conflict = 0;
  for (const region of regions) {
    if (region.kind === "stable") {
      lines.push(...region.lines);
      continue;
    }
    const choice = choices[conflict] ?? "ours";
    conflict += 1;
    switch (choice) {
      case "ours":
        lines.push(...region.ours);
        break;
      case "theirs":
        lines.push(...region.theirs);
        break;
      case "both":
        lines.push(...region.ours, ...region.theirs);
        break;
      case "base":
        lines.push(...region.base);
        break;
      case "none":
        break;
    }
  }
  return lines.join("\n") + (trailingNewline && lines.length > 0 ? "\n" : "");
}

/** 冲突段的数量，界面用来显示「还有几处没定」。 */
export function countConflicts(regions: MergeRegion[]): number {
  return regions.filter((region) => region.kind === "conflict").length;
}
