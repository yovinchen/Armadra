/**
 * 会话表（T02，终端宿主设计 §8「Session」行）。
 *
 * 三条约束写在这里，因为它们都是「不要」：
 *  - 测不出来的格子是短横线，不是 0；
 *  - 内存是进程树 RSS 之和，标为**估计**，不叫「独占内存」；
 *  - 面板不会自动杀任何会话，结束是用户点的，而且要再确认一次。
 */
import { useState } from "react";
import { Crosshair, X } from "lucide-react";
import { toast } from "sonner";
import type { SessionResources } from "@armadra/shared";

import { runtimeApi } from "@/api/client";
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
import {
  formatCount,
  formatMetricBytes,
  formatPercent,
  sortSessions,
  unknownReasonKey,
  type SessionSort,
} from "./metrics";

export function SessionTable({
  sessions,
  sort,
  onSorted,
}: {
  sessions: readonly SessionResources[];
  sort: SessionSort;
  onSorted: (sort: SessionSort) => void;
}) {
  const t = useT();
  const nodes = useCanvasStore((state) => state.document?.nodes);
  const selectNodes = useCanvasStore((state) => state.selectNodes);
  const [ending, setEnding] = useState<SessionResources | null>(null);

  const titleOf = (session: SessionResources) =>
    nodes?.find((node) => node.id === session.nodeId)?.title ??
    session.cwd.split("/").pop() ??
    session.sessionId.slice(0, 8);

  const rows = sortSessions(sessions, sort, titleOf);

  const endSession = (session: SessionResources) => {
    setEnding(null);
    void runtimeApi
      .terminateTerminal(session.sessionId, "session")
      .catch(() => toast.error(t("resources.endFailed")));
  };

  if (rows.length === 0) {
    return (
      <p className="px-1 py-2 text-[12px] text-muted-foreground">
        {t("resources.noSessions")}
      </p>
    );
  }

  return (
    <>
      <div className="flex items-center gap-1 pb-1">
        {(["cpu", "memory", "name"] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => onSorted(key)}
            data-active={sort === key ? "true" : undefined}
            className="rounded-[var(--r-control)] px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent data-[active=true]:bg-accent data-[active=true]:text-foreground"
          >
            {t(`resources.sort.${key}`)}
          </button>
        ))}
      </div>

      <ul className="flex flex-col gap-0.5">
        {rows.map((session) => {
          const reasonKey = unknownReasonKey(session.unknownReason);
          return (
            <li
              key={session.sessionId}
              className="group flex items-center gap-2 rounded-[var(--r-control)] px-1.5 py-1 hover:bg-accent"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[12px]">
                    {titleOf(session)}
                  </span>
                  {!session.alive && (
                    <Badge variant="ghost" className="text-[10px]">
                      {t("resources.session.ended")}
                    </Badge>
                  )}
                  {session.location === "remote" && (
                    <Badge variant="outline" className="text-[10px]">
                      {t("resources.location.remote")}
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
                className="w-20 shrink-0 text-right text-[12px] tabular-nums"
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
                {session.alive && (
                  <IconButton
                    label={t("resources.session.end")}
                    onClick={() => setEnding(session)}
                  >
                    <X />
                  </IconButton>
                )}
              </div>
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
