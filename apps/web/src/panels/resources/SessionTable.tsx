/**
 * 会话表（T02，终端宿主设计 §8「Session」行）。
 *
 * 三条约束写在这里，因为它们都是「不要」：
 *  - 测不出来的格子是短横线，不是 0；
 *  - 内存是进程树 RSS 之和，标为**估计**，不叫「独占内存」；
 *  - 面板不会自动杀任何会话，结束是用户点的，而且要再确认一次；
 *  - 进程已经不在的会话不占一行，直接从列表里消失。
 */
import { useState } from "react";
import { ChevronDown, ChevronRight, Crosshair, X } from "lucide-react";
import { toast } from "sonner";
import type { SessionResources } from "@armadra/shared";

import { sessionGateway } from "@/session";
import { useT } from "@/app/preferences-store";
import { centerNode } from "@/sessions/SessionRow";
import { useCanvasStore } from "@/store/canvas-store";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/alert-dialog";
import { Badge } from "@/ui/badge";
import { IconButton } from "@/ui/icon-button";
import { usePreferencesStore } from "@/app/preferences-store";
import { ProcessTree } from "./ProcessTree";
import { crossedThreshold } from "./memory-alert";
import {
  LOCAL_HOST,
  executionHosts,
  formatCount,
  formatMetricBytes,
  formatPercent,
  liveSessions,
  sessionsOnHost,
  sortSessions,
  unknownReasonKey,
  type SessionSort,
} from "./metrics";

export function SessionTable({
  sessions,
  sort,
  onSorted,
  host: controlledHost,
  onHost,
  extraHosts = [],
  hostName = (id) => id,
}: {
  sessions: readonly SessionResources[];
  sort: SessionSort;
  onSorted: (sort: SessionSort) => void;
  /** 由抽屉持有时，主机总览与会话表跟着同一个筛选走。 */
  host?: string | null | "all";
  onHost?: (host: string | null | "all") => void;
  /** 没有会话、但工作空间牵涉到的远端主机，也要能被选中看总览。 */
  extraHosts?: readonly string[];
  hostName?: (id: string) => string;
}) {
  const t = useT();
  const nodes = useCanvasStore((state) => state.document?.nodes);
  const workspaceHostId = useCanvasStore(
    (state) => state.workspace?.executionHostId,
  );
  const selectNodes = useCanvasStore((state) => state.selectNodes);
  const [ending, setEnding] = useState<SessionResources | null>(null);
  // `"all"` 或者一个具体主机；`null` 是「判不出来的那些」。
  const [ownHost, setOwnHost] = useState<string | null | "all">("all");
  const host = controlledHost ?? ownHost;
  const setHost = onHost ?? setOwnHost;
  // 展开的会话；默认全收起，因为大多数会话下面只有一个 shell。
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const threshold = usePreferencesStore(
    (state) => state.sessionMemoryWarnBytes,
  );

  const titleOf = (session: SessionResources) =>
    nodes?.find((node) => node.id === session.nodeId)?.title ??
    session.cwd.split("/").pop() ??
    session.sessionId.slice(0, 8);

  // 结束了的会话不留占位行：进程不在了就从列表消失（`liveSessions`）。
  const live = liveSessions(sessions);
  const seen = executionHosts(live, nodes, workspaceHostId);
  const hosts = [
    ...seen,
    ...extraHosts.filter((entry) => !seen.includes(entry)),
  ];
  const rows = sortSessions(
    sessionsOnHost(live, host, nodes, workspaceHostId),
    sort,
    titleOf,
  );
  const hostLabel = (value: string | null) => {
    if (value === null) return t("resources.host.filter.unknown");
    if (value === LOCAL_HOST) return t("resources.host.filter.local");
    return hostName(value);
  };

  const endSession = (session: SessionResources) => {
    setEnding(null);
    void sessionGateway
      .terminate(
        useCanvasStore.getState().workspace?.id ?? "",
        session.sessionId,
        "session",
      )
      .catch(() => toast.error(t("resources.endFailed")));
  };

  // 执行主机过滤只在真的有第二台主机时出现：一台机器上的「全部主机」是一个
  // 只有一个选项的控件。一行会话都没有时也要有它——它同时管上面的主机总览，
  // 远端工作空间还没开终端时正是要看远端那张卡的时候。
  const filter = hosts.length > 1 && (
    <div className="flex items-center gap-1 pb-1">
      <span className="text-[11px] text-muted-foreground">
        {t("resources.host.filter")}
      </span>
      {(["all", ...hosts] as const).map((value) => (
        <button
          key={value === "all" ? "all" : (value ?? "unknown")}
          type="button"
          data-slot="resource-host-filter"
          data-host={value === "all" ? "all" : (value ?? "unknown")}
          data-active={host === value ? "true" : undefined}
          onClick={() => setHost(value)}
          className="max-w-32 truncate rounded-[var(--r-control)] px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent data-[active=true]:bg-accent data-[active=true]:text-foreground"
        >
          {value === "all" ? t("resources.host.filter.all") : hostLabel(value)}
        </button>
      ))}
    </div>
  );

  if (live.length === 0) {
    return (
      <>
        {filter}
        <p className="px-1 py-2 text-[12px] text-muted-foreground">
          {t("resources.noSessions")}
        </p>
      </>
    );
  }

  return (
    <>
      {filter}

      {rows.length === 0 && (
        <p className="px-1 py-2 text-[12px] text-muted-foreground">
          {t("resources.host.filterEmpty")}
        </p>
      )}

      <div className="flex items-center gap-1 pb-1">
        {/* 排序只换看的顺序，测不出来的一律排在最后，不当 0 混进来。 */}
        {(["cpu", "memory", "name"] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => onSorted(key)}
            data-active={sort === key ? "true" : undefined}
            title={t("resources.sort.hint")}
            className="rounded-[var(--r-control)] px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent data-[active=true]:bg-accent data-[active=true]:text-foreground"
          >
            {t(`resources.sort.${key}`)}
          </button>
        ))}
      </div>

      <ul className="flex flex-col gap-0.5">
        {rows.map((session) => {
          const reasonKey = unknownReasonKey(session.unknownReason);
          // 高占用只是高亮：面板不会自动结束任何会话（设计 §8）。
          const high = crossedThreshold(session.memoryBytes, threshold);
          const open = expanded.has(session.sessionId);
          const expandable = session.children.length > 0;
          return (
            <li
              key={session.sessionId}
              data-high={high ? "true" : undefined}
              className="group flex flex-col rounded-[var(--r-control)] px-1.5 py-1 hover:bg-accent data-[high=true]:bg-[var(--danger)]/8"
            >
              <div className="flex w-full items-center gap-2">
                {/*
                没有子进程时留一个占位方块而不是一个禁用按钮：一个点不动的
                「展开进程树」按钮在读屏器里仍然会被念出来。
              */}
                {expandable ? (
                  <IconButton
                    label={
                      open
                        ? t("resources.session.treeCollapse")
                        : t("resources.session.tree")
                    }
                    onClick={() =>
                      setExpanded((current) => {
                        const next = new Set(current);
                        if (!next.delete(session.sessionId))
                          next.add(session.sessionId);
                        return next;
                      })
                    }
                  >
                    {open ? <ChevronDown /> : <ChevronRight />}
                  </IconButton>
                ) : (
                  <span aria-hidden="true" className="size-[24px] shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[12px]">
                      {titleOf(session)}
                    </span>
                    {session.location === "remote" && (
                      <Badge variant="outline" className="text-[10px]">
                        {t("resources.location.remote")}
                      </Badge>
                    )}
                    {high && (
                      <Badge
                        variant="outline"
                        className="border-[var(--danger)] text-[10px] text-[var(--danger)]"
                      >
                        {t("resources.session.high")}
                      </Badge>
                    )}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {reasonKey ? (
                      t(reasonKey)
                    ) : (
                      <>
                        {t("resources.session.children", {
                          count: formatCount(session.childCount),
                        })}
                        {session.state ? ` · ${session.state}` : ""}
                        {typeof session.pid === "number"
                          ? ` · pid ${session.pid}`
                          : ""}
                      </>
                    )}
                  </div>
                </div>

                <span className="w-14 shrink-0 text-right text-[12px] tabular-nums">
                  {formatPercent(session.cpuPercent)}
                </span>
                <span
                  className={`w-20 shrink-0 text-right text-[12px] tabular-nums ${
                    high ? "text-[var(--danger)]" : ""
                  }`}
                  // 共享页会被重复计入，所以这是估计值而不是独占内存（设计 §8）。
                  title={
                    session.memoryEstimated
                      ? t("resources.session.memoryEstimated")
                      : undefined
                  }
                >
                  {formatMetricBytes(session.memoryBytes)}
                  {session.memoryEstimated && session.memoryBytes !== null ? (
                    <span className="ml-0.5 text-muted-foreground">≈</span>
                  ) : null}
                </span>

                <div className="flex shrink-0 items-center">
                  {session.nodeId && (
                    <IconButton
                      label={t("resources.session.locate")}
                      onClick={() => {
                        selectNodes([session.nodeId!]);
                        centerNode(session.nodeId!);
                      }}
                    >
                      <Crosshair />
                    </IconButton>
                  )}
                  {/* 列表里除了休眠的都还在跑，所以「结束」对它们总是可按的；
                      休眠的进程早就不在了，没有什么可结束。 */}
                  {session.unknownReason !== "hibernated" && (
                    <IconButton
                      label={t("resources.session.end")}
                      onClick={() => setEnding(session)}
                    >
                      <X />
                    </IconButton>
                  )}
                </div>
              </div>

              {open && (
                <ProcessTree
                  processes={session.children}
                  total={session.childCount}
                />
              )}
            </li>
          );
        })}
      </ul>

      <AlertDialog
        open={ending !== null}
        onOpenChange={(open) => {
          if (!open) setEnding(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("resources.endTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("resources.endBody", {
                name: ending ? titleOf(ending) : "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("resources.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => ending && endSession(ending)}
              className="bg-[var(--danger)] text-white hover:bg-[var(--danger)]/90"
            >
              {t("resources.session.end")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
