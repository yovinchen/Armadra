/**
 * 终端节点头部的内存徽标（路线图 §4.3）。
 *
 * 一个数字，比如 `512 MB`。它回答的是「这个会话现在占多少」，所以：
 *
 * - 数字是**进程树 RSS 之和**，是估计值。共享页会被每个进程各算一次，所以
 *   它不是「独占内存」，Popover 里说明这一点（设计 §8）。
 * - 测不出来显示 `unknown`，不显示 0——0 的意思是「量到了，是零」，那是另
 *   一句话，而且是假的。
 * - 越过阈值只变色并提醒一次，不做任何处置：不终止、不休眠、不压缩。
 *
 * **看不见的节点不催 Runtime 快采。** 节点折叠、滚出视口或者整个窗口切到
 * 后台时，徽标把自己的订阅节奏降到 30 秒；重新看得见就恢复。节奏是全局取
 * 最快的一档，所以一个可见的徽标就够把大家拉回正常速度。
 */
import * as React from "react";
import { toast } from "sonner";
import type { SessionResources } from "@armadra/shared";

import { usePreferencesStore, useT } from "@/app/preferences-store";
import { notify } from "@/platform";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { formatMetricBytes, formatPercent, UNKNOWN } from "./metrics";
import { claimAlert, crossedThreshold } from "./memory-alert";
import { useSessionResources } from "./use-resources";
import { useOnScreen, usePageVisible } from "./use-visibility";

export interface MemoryBadgeProps {
  nodeId: string;
  workspaceId: string | null;
  sessionId: string | null;
  generation: number | null;
  /** 节点自己知道的可见性：折叠 / 已退出的节点不需要快节奏。 */
  visible: boolean;
  /** 测试注入；默认按浏览器的实际状态判断。 */
  thresholdBytes?: number;
}

/** 窗口在后台时发系统通知，在前台时发一条 toast——总之要看得见。 */
async function remind(title: string, body: string): Promise<void> {
  const background =
    typeof document !== "undefined" &&
    (document.hidden || !document.hasFocus());
  if (background) {
    await notify(title, body);
    return;
  }
  toast.warning(title, { description: body });
}

export function MemoryBadge({
  nodeId,
  workspaceId,
  sessionId,
  generation,
  visible,
  thresholdBytes,
}: MemoryBadgeProps) {
  const t = useT();
  const stored = usePreferencesStore((state) => state.sessionMemoryWarnBytes);
  const threshold = thresholdBytes ?? stored;

  const anchor = React.useRef<HTMLButtonElement>(null);
  const onScreen = useOnScreen(anchor);
  const pageVisible = usePageVisible();
  const watched = visible && onScreen && pageVisible;
  const cadence = watched ? "fast" : "slow";
  // 只认这个会话这一代的行（换代之后旧行的数字属于另一次运行），而且只在
  // **这一行**变了的时候才重渲——整份快照进 state 的写法会让一屏三十个徽标
  // 每个采样 tick 全部重画一遍（见 `use-resources.ts` 的 `useSessionResources`）。
  const session: SessionResources | null = useSessionResources(
    workspaceId,
    sessionId,
    generation,
    cadence,
  );

  const memory = session?.memoryBytes ?? null;
  const over = crossedThreshold(memory, threshold);

  React.useEffect(() => {
    if (!over || !sessionId) return;
    if (!claimAlert(sessionId, session?.generation ?? generation ?? 0)) return;
    void remind(
      t("resources.memory.alertTitle"),
      t("resources.memory.alertBody", {
        value: formatMetricBytes(memory),
        limit: formatMetricBytes(threshold),
      }),
    );
  }, [over, sessionId, generation, session?.generation, memory, threshold, t]);

  if (!sessionId) return null;

  const value = formatMetricBytes(memory);
  const known = value !== UNKNOWN;
  const label = known ? value : t("resources.memory.unknown");

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          ref={anchor}
          type="button"
          data-testid={`memory-badge-${nodeId}`}
          data-over={over ? "true" : undefined}
          className={`flex min-h-6 shrink-0 items-center gap-1 rounded px-1 text-[length:var(--text-caption)] tabular-nums hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring ${
            over ? "text-[var(--danger)]" : "text-muted-foreground"
          }`}
          aria-label={t("resources.memory.badge", { value: label })}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <span className="whitespace-nowrap">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-72 max-w-[calc(100vw-1rem)] text-xs"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <h3 className="font-medium">{t("resources.memory.title")}</h3>
        <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-1.5">
          <dt className="text-muted-foreground">
            {t("resources.memory.value")}
          </dt>
          <dd className="m-0 text-right">{label}</dd>
          <dt className="text-muted-foreground">{t("resources.host.cpu")}</dt>
          <dd className="m-0 text-right">
            {formatPercent(session?.cpuPercent)}
          </dd>
          <dt className="text-muted-foreground">
            {t("resources.memory.children")}
          </dt>
          <dd className="m-0 text-right">{session?.childCount ?? UNKNOWN}</dd>
          <dt className="text-muted-foreground">
            {t("resources.memory.threshold")}
          </dt>
          <dd className="m-0 text-right">{formatMetricBytes(threshold)}</dd>
        </dl>
        <p className="text-muted-foreground">
          {t("resources.session.memoryEstimated")}
        </p>
        {!known && <p role="status">{t("resources.memory.unknownNote")}</p>}
        {over && <p>{t("resources.memory.overNote")}</p>}
        {!watched && (
          <p className="text-muted-foreground">
            {t("resources.memory.slowNote")}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
