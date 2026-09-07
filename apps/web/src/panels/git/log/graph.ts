import type { GraphKeys } from "../CommitGraph";
import type { LogCommit } from "./types";

/**
 * 多仓库日志里一个提交的身份（Git 工具窗口设计 §2.2）。
 *
 * `仓库路径:oid`，而不是裸 oid。同一个工作空间里两个检出可能持有同一个 oid
 * ——链接 worktree 与主仓库本来就是同一个仓库，cherry-pick 过去的提交也可能
 * 撞上——裸 oid 会把两条本来无关的线连起来，画出一张说谎的图。
 */
export function commitKey(commit: {
  repositoryPath: string;
  oid: string;
}): string {
  return `${commit.repositoryPath}:${commit.oid}`;
}

/** 父提交永远在同一个仓库里，所以父的身份也带同一个仓库路径。 */
export const logGraphKeys: GraphKeys<LogCommit> = {
  key: commitKey,
  parent: (commit, parent) => `${commit.repositoryPath}:${parent}`,
};

/**
 * 仓库颜色条的调色板（§2.2「多仓库时每行左侧 3px 颜色条」）。
 *
 * 序号来自日志响应里的 `repositories[].color`，不是色值——主题换了颜色跟着
 * 换，而「哪个仓库是第几号」由服务端一次定下来，翻页不会变。
 */
const REPOSITORY_COLORS = [
  "var(--brand)",
  "#32d74b",
  "#ff9f0a",
  "#bf5af2",
  "#6ac4dc",
  "#ff453a",
  "#ffd60a",
  "#5e5ce6",
];

export function repositoryColor(index: number): string {
  const size = REPOSITORY_COLORS.length;
  return REPOSITORY_COLORS[((index % size) + size) % size]!;
}
