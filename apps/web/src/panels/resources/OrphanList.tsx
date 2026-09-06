/**
 * 孤立会话（T02，终端宿主设计 §8「孤立会话」行）。
 *
 * 两个动作：**附着到新节点**和**终止**。
 *
 * 附着不是新建一个空终端：Runtime 先把会话行绑回去，并告诉前端该用哪个
 * `nodeId`——那正是这个会话自己的 key，也就是它原来那个节点的 id，所以
 * 恢复出来的节点拥有的就是原来那个进程，而不是它的一份副本。节点仍然是
 * 画布建、随画布保存（`canvas-store` 是画布改动的唯一入口）。
 *
 * 终止要再确认一次，因为它不可逆。
 */
import { useState } from "react";
import { CornerUpLeft, X } from "lucide-react";
import { toast } from "sonner";
import type { OrphanSession } from "@armadra/shared";

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
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { nodeDropPosition } from "@/canvas/placement";

export function OrphanList({
  workspaceId,
  orphans,
  onChanged,
}: {
  workspaceId: string;
  orphans: readonly OrphanSession[];
  onChanged: () => void;
}) {
  const t = useT();
  const addNode = useCanvasStore((state) => state.addNode);
  const [ending, setEnding] = useState<OrphanSession | null>(null);

  const adopt = async (orphan: OrphanSession) => {
    if (!orphan.sessionId) return;
    try {
      const adopted = await runtimeApi.adoptOrphanSession(
        workspaceId,
        orphan.sessionId,
      );
      // `id` 必须是 Runtime 给的那个：它就是会话的 key，用别的 id 建出来的
      // 节点会拿到一个新会话，而不是这一个。
      addNode("terminal", {
        id: adopted.nodeId,
        position: nodeDropPosition("terminal"),
        data: {
          kind: "terminal",
          sessionId: adopted.sessionId,
          cwd: adopted.cwd,
          ...(adopted.shell ? { shell: adopted.shell } : {}),
        },
      });
      centerNode(adopted.nodeId);
      onChanged();
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : t("resources.adoptFailed"),
      );
    }
  };

  const terminate = (orphan: OrphanSession) => {
    setEnding(null);
    void runtimeApi
      .terminateOrphanSession(workspaceId, orphan.id)
      .then(onChanged)
      .catch(() => toast.error(t("resources.endFailed")));
  };

  if (orphans.length === 0) {
    return (
      <p className="px-1 py-2 text-[12px] text-muted-foreground">
        {t("resources.noOrphans")}
      </p>
    );
  }

  const label = (orphan: OrphanSession) =>
    orphan.cwd?.split("/").pop() ??
    orphan.backendRef ??
    orphan.sessionId?.slice(0, 8) ??
    orphan.id;

  return (
    <>
      <ul className="flex flex-col gap-0.5">
        {orphans.map((orphan) => (
          <li
            key={orphan.id}
            className="flex items-center gap-2 rounded-[var(--r-control)] px-1.5 py-1 hover:bg-accent"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[12px]">{label(orphan)}</span>
                <Badge variant="outline" className="text-[10px]">
                  {t(`resources.orphan.${orphan.reason}`)}
                </Badge>
              </div>
              {orphan.cwd && (
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {orphan.cwd}
                </div>
              )}
            </div>
            {orphan.adoptable && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 shrink-0 px-1.5 text-[11px]"
                onClick={() => void adopt(orphan)}
              >
                <CornerUpLeft />
                {t("resources.orphan.adopt")}
              </Button>
            )}
            <IconButton
              label={t("resources.orphan.terminate")}
              onClick={() => setEnding(orphan)}
            >
              <X />
            </IconButton>
          </li>
        ))}
      </ul>

      <AlertDialog
        open={ending !== null}
        onOpenChange={(open) => {
          if (!open) setEnding(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("resources.orphan.terminateTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("resources.orphan.terminateBody", {
                name: ending ? label(ending) : "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("resources.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => ending && terminate(ending)}
              className="bg-[var(--danger)] text-white hover:bg-[var(--danger)]/90"
            >
              {t("resources.orphan.terminate")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
