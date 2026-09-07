import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { useT, usePreferencesStore } from "../../../app/preferences-store";
import { cn } from "../../../lib/cn";
import {
  LANE_WIDTH,
  MAX_LANES,
  commitGraph,
  laneColor,
  refBadges,
} from "../CommitGraph";
import { commitKey, logGraphKeys, repositoryColor } from "./graph";
import type { LogCommit } from "./types";

/**
 * 提交图表格（Git 工具窗口设计 §2.2「提交图表格」）。
 *
 * 三件事决定了它必须是虚拟化的、而且图与行必须同源：
 *
 * 1. **行高固定 24px**（紧凑档 20px），滚到底自动续页。历史动辄上万行，
 *    一次全画出来的表格在滚动时会掉帧到没法用。
 * 2. **图只画可见区间**。车道布局仍然按**整页**算——车道是「哪个父提交还没
 *    出现」，只看可见的十几行会把跨出屏幕的线算错——但 `<path>` / `<circle>`
 *    只为可见行生成，所以 DOM 里始终只有几十个节点。
 * 3. **未提交的变更**是最上面一行虚线节点，占用行号 0；提交的行号因此整体
 *    下移一格，图的 y 也跟着移，否则线会连到错位的行上。
 */

/** 行高：常规 24px，紧凑 20px（§2.2 与工具栏的「紧凑行」）。 */
export const LOG_ROW_HEIGHT = 24;
export const LOG_COMPACT_ROW_HEIGHT = 20;

export interface LogTableProps {
  commits: readonly LogCommit[];
  /** 仓库路径 → 调色板序号；只有一个仓库时不画颜色条。 */
  colors: ReadonlyMap<string, number>;
  /** 被选中的行（`commitKey`）；`"uncommitted"` 是那条合成行。 */
  selected: string | null;
  onSelect: (key: string, commit: LogCommit | null) => void;
  /** HEAD 有未提交变更的仓库；空 = 不显示那条虚线行。 */
  uncommitted: readonly string[];
  compact: boolean;
  showHash: boolean;
  /**
   * 手机宽度：只留「消息」和「日期」。作者与 hash 在 390px 里会把消息挤成
   * 三个字加省略号，而消息才是这一行存在的理由。
   */
  narrow?: boolean;
  /** 高亮我的提交时用来比对的邮箱；`null` = 不高亮。 */
  myEmail: string | null;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  /** 右键：把这一行交给菜单；合成行不触发。 */
  renderRowMenu?: (commit: LogCommit, row: ReactNode) => ReactNode;
}

export const UNCOMMITTED_KEY = "uncommitted";

type Row =
  | { kind: "uncommitted"; key: string }
  | { kind: "commit"; key: string; commit: LogCommit };

/** 今天的提交显示时刻，更早的显示日期——列窄，两者只能二选一。 */
function formatWhen(iso: string, now: number, locale: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  return new Intl.DateTimeFormat(
    locale,
    sameDay
      ? { hour: "2-digit", minute: "2-digit" }
      : { year: "numeric", month: "2-digit", day: "2-digit" },
  ).format(at);
}

export function LogTable({
  commits,
  colors,
  selected,
  onSelect,
  uncommitted,
  compact,
  showHash,
  narrow = false,
  myEmail,
  hasMore,
  loading,
  onLoadMore,
  renderRowMenu,
}: LogTableProps) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const scroller = useRef<HTMLDivElement | null>(null);
  const rowHeight = compact ? LOG_COMPACT_ROW_HEIGHT : LOG_ROW_HEIGHT;
  const multiRepository = colors.size > 1;

  const rows = useMemo<Row[]>(() => {
    const head: Row[] =
      uncommitted.length > 0
        ? [{ kind: "uncommitted", key: UNCOMMITTED_KEY }]
        : [];
    return [
      ...head,
      ...commits.map<Row>((commit) => ({
        kind: "commit",
        key: commitKey(commit),
        commit,
      })),
    ];
  }, [commits, uncommitted.length]);

  // 车道按整页算，行号偏移交给渲染：合成行不进图，但它占着第 0 行。
  const offset = rows.length - commits.length;
  const graph = useMemo(() => commitGraph(commits, logGraphKeys), [commits]);
  const lanes = Math.min(graph.lanes, MAX_LANES);
  const gutter = lanes * LANE_WIDTH + 12;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });
  const items = virtualizer.getVirtualItems();

  // 滚到底继续翻页。判据是「最后一个虚拟行进入了视野」，不是滚动位置：
  // 行高变了、窗口变了都不用重新调这个数。
  const last = items[items.length - 1];
  useEffect(() => {
    if (!hasMore || loading) return;
    if (last && last.index >= rows.length - 1) onLoadMore();
  }, [hasMore, loading, last, rows.length, onLoadMore]);

  const first = items[0]?.index ?? 0;
  const until = last?.index ?? 0;
  const visible = (row: number) =>
    row + offset >= first - 4 && row + offset <= until + 4;

  const x = (lane: number) => Math.min(lane, MAX_LANES - 1) * LANE_WIDTH + 8;
  const y = (row: number) => (row + offset) * rowHeight + rowHeight / 2;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        role="row"
        className="flex shrink-0 items-center gap-2 border-b border-border pr-3 text-[11px] text-muted-foreground"
        style={{ height: rowHeight, paddingLeft: gutter }}
      >
        <span role="columnheader" className="min-w-0 flex-1 truncate">
          {t("gitLog.table.message")}
        </span>
        {!narrow && (
          <span role="columnheader" className="w-28 shrink-0 truncate">
            {t("gitLog.table.author")}
          </span>
        )}
        <span role="columnheader" className="w-20 shrink-0 truncate text-right">
          {t("gitLog.table.date")}
        </span>
        {showHash && !narrow && (
          <span
            role="columnheader"
            className="w-16 shrink-0 truncate text-right"
          >
            {t("gitLog.table.hash")}
          </span>
        )}
      </div>
      <div
        ref={scroller}
        data-slot="git-log-rows"
        className="relative min-h-0 flex-1 overflow-auto"
      >
        <div
          className="relative w-full"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          <svg
            aria-label={t("gitLog.table.graph")}
            role="img"
            className="pointer-events-none absolute top-0 left-0"
            width={gutter}
            height={virtualizer.getTotalSize()}
          >
            {graph.edges.map((edge) => {
              if (!visible(edge.from.row) && !visible(edge.to?.row ?? -99))
                return null;
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
                      ? `M${x(edge.from.lane)},${y(edge.from.row)} C${x(edge.from.lane)},${y(edge.from.row) + rowHeight * 0.5} ${x(edge.to.lane)},${y(edge.to.row) - rowHeight * 0.5} ${x(edge.to.lane)},${y(edge.to.row)}`
                      : `M${x(edge.from.lane)},${y(edge.from.row)} v${rowHeight * 0.5}`
                  }
                />
              );
            })}
            {offset > 0 && (
              // 未提交的变更：一个虚线空心点，接到 HEAD 那一行。
              <g data-slot="git-log-uncommitted">
                <circle
                  cx={x(0)}
                  cy={rowHeight / 2}
                  r={3.5}
                  fill="var(--background)"
                  stroke="var(--muted-foreground)"
                  strokeWidth="1.5"
                  strokeDasharray="2 2"
                />
                <path
                  d={`M${x(0)},${rowHeight / 2} v${rowHeight}`}
                  fill="none"
                  stroke="var(--muted-foreground)"
                  strokeWidth="1.5"
                  strokeDasharray="3 3"
                />
              </g>
            )}
            {commits.map((commit, row) => {
              if (!visible(row)) return null;
              const point = graph.points.get(commitKey(commit));
              if (!point) return null;
              const merge = commit.parents.length > 1;
              return (
                <circle
                  key={commitKey(commit)}
                  data-commit={commit.oid}
                  data-repository={commit.repositoryPath}
                  data-merge={merge ? "true" : "false"}
                  cx={x(point.lane)}
                  cy={y(point.row)}
                  r={selected === commitKey(commit) ? 4.5 : 3.5}
                  fill={merge ? "var(--background)" : laneColor(point.lane)}
                  stroke={laneColor(point.lane)}
                  strokeWidth="2"
                />
              );
            })}
          </svg>
          {items.map((item) => {
            const row = rows[item.index]!;
            const body =
              row.kind === "uncommitted" ? (
                <UncommittedRow
                  gutter={gutter}
                  height={rowHeight}
                  selected={selected === UNCOMMITTED_KEY}
                  onSelect={() => onSelect(UNCOMMITTED_KEY, null)}
                />
              ) : (
                <CommitRow
                  commit={row.commit}
                  gutter={gutter}
                  height={rowHeight}
                  color={
                    multiRepository
                      ? repositoryColor(
                          colors.get(row.commit.repositoryPath) ?? 0,
                        )
                      : null
                  }
                  mine={
                    myEmail !== null &&
                    row.commit.authorEmail.toLowerCase() ===
                      myEmail.toLowerCase()
                  }
                  showHash={showHash && !narrow}
                  narrow={narrow}
                  when={formatWhen(
                    row.commit.committerTime,
                    Date.now(),
                    locale,
                  )}
                  selected={selected === row.key}
                  onSelect={() => onSelect(row.key, row.commit)}
                />
              );
            return (
              <div
                key={row.key}
                data-index={item.index}
                className="absolute inset-x-0"
                style={{
                  height: `${rowHeight}px`,
                  transform: `translateY(${item.start}px)`,
                }}
              >
                {row.kind === "commit" && renderRowMenu
                  ? renderRowMenu(row.commit, body)
                  : body}
              </div>
            );
          })}
        </div>
      </div>
      {(loading || hasMore) && (
        <p
          role="status"
          className="shrink-0 border-t border-border px-3 py-1 text-[11px] text-muted-foreground"
        >
          {t(loading ? "gitLog.table.loading" : "gitLog.table.more")}
        </p>
      )}
      {!loading && rows.length === 0 && (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {t("gitLog.table.empty")}
        </p>
      )}
    </div>
  );
}

function UncommittedRow({
  gutter,
  height,
  selected,
  onSelect,
}: {
  gutter: number;
  height: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      style={{ height, paddingLeft: gutter }}
      className="flex w-full min-w-0 items-center gap-2 pr-3 text-left text-xs italic text-muted-foreground hover:bg-muted aria-pressed:bg-muted"
    >
      <span className="min-w-0 flex-1 truncate">
        {t("gitLog.table.uncommitted")}
      </span>
    </button>
  );
}

function CommitRow({
  commit,
  gutter,
  height,
  color,
  mine,
  showHash,
  narrow,
  when,
  selected,
  onSelect,
}: {
  commit: LogCommit;
  gutter: number;
  height: number;
  color: string | null;
  mine: boolean;
  showHash: boolean;
  narrow: boolean;
  when: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const badges = useMemo(() => refBadges(commit.refs), [commit.refs]);
  return (
    <button
      type="button"
      aria-pressed={selected}
      data-commit={commit.oid}
      onClick={onSelect}
      style={{ height, paddingLeft: gutter }}
      className={cn(
        "relative flex w-full min-w-0 items-center gap-2 pr-3 text-left text-xs hover:bg-muted aria-pressed:bg-muted",
        mine && "font-medium text-foreground",
      )}
    >
      {color && (
        <span
          aria-hidden
          data-slot="git-log-repository-color"
          className="absolute inset-y-0 left-0 w-[3px]"
          style={{ background: color }}
        />
      )}
      <span className="min-w-0 flex-1 truncate" title={commit.subject}>
        {commit.subject || commit.oid.slice(0, 12)}
      </span>
      {badges.map((badge) => (
        <span
          key={`${badge.kind}:${badge.label}`}
          title={badge.label}
          className={cn(
            "max-w-28 shrink-0 truncate rounded px-1 text-[10px] leading-4",
            badge.kind === "tag"
              ? "bg-[color-mix(in_srgb,var(--brand)_16%,transparent)] text-[var(--brand)]"
              : badge.kind === "head"
                ? "bg-foreground text-background"
                : "border border-border text-muted-foreground",
          )}
        >
          {badge.label}
        </span>
      ))}
      {!narrow && (
        <span
          className="w-28 shrink-0 truncate text-muted-foreground"
          title={`${commit.authorName} <${commit.authorEmail}>`}
        >
          {commit.authorName}
        </span>
      )}
      <span
        className="w-20 shrink-0 truncate text-right tabular-nums text-muted-foreground"
        title={commit.committerTime}
      >
        {when}
      </span>
      {showHash && (
        <span className="w-16 shrink-0 truncate text-right font-mono text-muted-foreground">
          {commit.oid.slice(0, 7)}
        </span>
      )}
    </button>
  );
}
