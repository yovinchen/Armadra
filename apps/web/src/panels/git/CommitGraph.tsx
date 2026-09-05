import { useMemo } from "react";
import type { GitCommitRecord } from "@armadra/shared";
import { useT } from "../../app/preferences-store";

/**
 * 提交图的车道布局（roadmap §4.1）。
 *
 * 车道是**待画的父提交身份**，不是行号：一条车道从某个提交开始，一直等到
 * 那个父提交自己出现在某一行为止。所以：
 *
 * - 第一父提交继续占用同一条车道，主线因此是笔直的一列；
 * - 合并提交的其余父提交各自占一条新车道，画成从右侧汇入；
 * - 合并处旧车道被**回收**：所有在等这个提交的车道一次性清空，下一条分支
 *   可以立刻复用同一列，图不会越往下越宽。
 *
 * 这里只按当前这一页的提交排布。父提交还没翻页出来时 `to` 是 `undefined`，
 * 画成一小段虚线残桩，而不是猜一个位置——猜出来的连线会说谎。
 */

export interface GraphPoint {
  row: number;
  lane: number;
}
export interface GraphEdge {
  child: string;
  parent: string;
  from: GraphPoint;
  /** 父提交不在本页时为 `undefined`。 */
  to: GraphPoint | undefined;
  /** 第几个父提交；> 0 表示这是合并汇入的那条线。 */
  index: number;
}

export function commitGraph(commits: readonly GitCommitRecord[]) {
  const lanes: (string | null)[] = [];
  const points = new Map<string, GraphPoint>();
  const free = () => {
    const slot = lanes.indexOf(null);
    return slot < 0 ? lanes.length : slot;
  };
  for (const [row, commit] of commits.entries()) {
    let lane = lanes.indexOf(commit.oid);
    if (lane < 0) lane = free();
    points.set(commit.oid, { row, lane });
    // 回收：其他也在等这个提交的车道到此为止，空出来给后面的分支复用。
    for (const [index, pending] of lanes.entries()) {
      if (pending === commit.oid) lanes[index] = null;
    }
    const [first, ...rest] = commit.parents;
    // 第一父提交沿用本车道；除非已经有别的车道在等它，那样会画出两条同名线。
    lanes[lane] = first && !lanes.includes(first) ? first : null;
    for (const parent of rest) {
      if (lanes.includes(parent) || points.has(parent)) continue;
      lanes[free()] = parent;
    }
  }
  const edges: GraphEdge[] = commits.flatMap((commit) =>
    commit.parents.map((parent, index) => ({
      child: commit.oid,
      parent,
      index,
      from: points.get(commit.oid)!,
      to: points.get(parent),
    })),
  );
  return {
    points,
    edges,
    lanes: Math.max(1, ...[...points.values()].map((point) => point.lane + 1)),
  };
}

/**
 * 车道配色。用固定色板按车道下标循环，而不是按分支名哈希：同一页里相邻的
 * 两条线必须看得出不同，跨页保持稳定不如当页可读重要。
 */
const LANE_COLORS = [
  "var(--brand)",
  "#32d74b",
  "#ff9f0a",
  "#bf5af2",
  "#6ac4dc",
  "#ff453a",
  "#ffd60a",
];
export function laneColor(lane: number) {
  return LANE_COLORS[lane % LANE_COLORS.length]!;
}

export const ROW_HEIGHT = 44;
const LANE_WIDTH = 14;
const MAX_LANES = 12;

/**
 * 行内徽标：`refs` 里的 `refs/heads/x`、`refs/remotes/o/x`、`refs/tags/x`
 * 分成分支和 tag 两类，`HEAD -> x` 单独标出来。
 */
export function refBadges(refs: readonly string[]) {
  const badges: {
    label: string;
    kind: "head" | "branch" | "remote" | "tag";
  }[] = [];
  for (const entry of refs) {
    const value = entry.trim();
    if (!value) continue;
    if (value === "HEAD" || value.startsWith("HEAD -> ")) {
      badges.push({ label: "HEAD", kind: "head" });
      const target = value.slice("HEAD -> ".length).trim();
      if (target && target !== value) {
        badges.push({ label: shortRef(target), kind: "branch" });
      }
      continue;
    }
    if (value.startsWith("refs/tags/")) {
      badges.push({ label: value.slice("refs/tags/".length), kind: "tag" });
      continue;
    }
    if (value.startsWith("refs/remotes/")) {
      badges.push({
        label: value.slice("refs/remotes/".length),
        kind: "remote",
      });
      continue;
    }
    badges.push({ label: shortRef(value), kind: "branch" });
  }
  // 同一个提交上 `HEAD` 和它指向的分支会各来一次，去重后仍保留出现顺序。
  const seen = new Set<string>();
  return badges.filter((badge) => {
    const key = `${badge.kind}:${badge.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function shortRef(value: string) {
  return value.replace(/^refs\/(heads|remotes|tags)\//, "");
}

export function CommitGraphLanes({
  commits,
  selected,
}: {
  commits: readonly GitCommitRecord[];
  selected: string | null;
}) {
  const t = useT();
  const graph = useMemo(() => commitGraph(commits), [commits]);
  const lanes = Math.min(graph.lanes, MAX_LANES);
  const x = (lane: number) => Math.min(lane, MAX_LANES - 1) * LANE_WIDTH + 10;
  const y = (row: number) => row * ROW_HEIGHT + ROW_HEIGHT / 2;
  return (
    <div className="shrink-0 overflow-hidden">
      <svg
        role="img"
        aria-label={t("gitRepo.graph")}
        width={lanes * LANE_WIDTH + 12}
        height={Math.max(commits.length * ROW_HEIGHT, ROW_HEIGHT)}
      >
        {graph.edges.map((edge) => {
          // 汇入的线用父提交那条车道的颜色，这样一条分支从头到尾是一个色。
          const lane = edge.to ? edge.to.lane : edge.from.lane;
          const color = laneColor(edge.index > 0 ? lane : edge.from.lane);
          return (
            <path
              key={`${edge.child}:${edge.parent}`}
              data-child={edge.child}
              data-parent={edge.parent}
              fill="none"
              stroke={color}
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeDasharray={edge.to ? undefined : "3 3"}
              d={
                edge.to
                  ? `M${x(edge.from.lane)},${y(edge.from.row)} C${x(edge.from.lane)},${y(edge.from.row) + ROW_HEIGHT * 0.4} ${x(edge.to.lane)},${y(edge.to.row) - ROW_HEIGHT * 0.4} ${x(edge.to.lane)},${y(edge.to.row)}`
                  : `M${x(edge.from.lane)},${y(edge.from.row)} v${ROW_HEIGHT * 0.4}`
              }
            >
              <title>
                {edge.parent}
                {!edge.to ? ` — ${t("gitRepo.outsidePage")}` : ""}
              </title>
            </path>
          );
        })}
        {commits.map((commit) => {
          const point = graph.points.get(commit.oid);
          if (!point) return null;
          // 合并提交画空心点：一眼能和普通提交分开，不用读父提交个数。
          const merge = commit.parents.length > 1;
          return (
            <circle
              key={commit.oid}
              data-commit={commit.oid}
              data-merge={merge ? "true" : "false"}
              cx={x(point.lane)}
              cy={y(point.row)}
              r={selected === commit.oid ? 4.5 : 3.5}
              fill={merge ? "var(--background)" : laneColor(point.lane)}
              stroke={laneColor(point.lane)}
              strokeWidth="2"
            >
              <title>{commit.oid}</title>
            </circle>
          );
        })}
      </svg>
    </div>
  );
}
