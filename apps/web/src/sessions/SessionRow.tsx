/**
 * 会话行（§3.5）。
 *
 * 左侧状态标记 → 标题（双击改名）→ Agent 标签 → `×` 结束；
 * 第二行是目录名与「处于该状态多久」。点击行选中并把画布居中到该节点。
 */
import { useEffect, useRef, useState } from "react";
import { Bell, Check, X } from "lucide-react";
import { toast } from "sonner";

import { agentLabel } from "../agent/launch";
import { basename, type SessionRow as SessionRowData } from "../agent/sessions";
import { isAttention, useAgentStatusStore } from "../agent/status-store";
import { runtimeApi } from "../api/client";
import { sessionGateway } from "../session";
import {
  CENTER_NODE_EVENT,
  requestCenterOnNode,
} from "../canvas/flow/flow-context";
import { formatDuration } from "../lib/format";
import { useT } from "../app/preferences-store";
import { useCanvasStore } from "../store/canvas-store";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { ColorDot } from "../ui/color-dot";
import { IconButton } from "../ui/icon-button";
import { Input } from "../ui/input";

/**
 * 居中事件的定义搬到了 `canvas/flow/flow-context.ts`，这里只转出去，
 * 免得侧栏与画布各存一份事件名。画布还没挂载时事件没人接，也不会报错。
 */
export { CENTER_NODE_EVENT };
export const centerNode = requestCenterOnNode;

function markerColor(row: SessionRowData): string {
  if (row.state === "working") return "var(--status-working)";
  if (row.state === "done") return "var(--success)";
  return "var(--status-idle)";
}

export function SessionRow({ row }: { row: SessionRowData }) {
  const t = useT();
  const selectNodes = useCanvasStore((state) => state.selectNodes);
  const updateNode = useCanvasStore((state) => state.updateNode);
  const markRead = useAgentStatusStore((state) => state.markRead);
  const selected = useCanvasStore((state) =>
    state.selectedNodeIds.includes(row.nodeId),
  );

  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(row.title);
  const [confirming, setConfirming] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) input.current?.select();
  }, [renaming]);

  // 名字与颜色都走 `agent/launch`：自定义 Agent 不在内置注册表里，
  // 得靠 `GET /api/agents` 那份快照才认得（§24.1）。
  const agentId = row.agentId;

  const activate = () => {
    markRead(row.nodeId);
    selectNodes([row.nodeId]);
    centerNode(row.nodeId);
  };

  const commitRename = () => {
    const title = draft.trim();
    setRenaming(false);
    if (!title || title === row.title) {
      setDraft(row.title);
      return;
    }
    updateNode(row.nodeId, { title });
  };

  const terminate = () => {
    setConfirming(false);
    void sessionGateway
      .terminate(
        useCanvasStore.getState().workspace?.id ?? "",
        row.sessionId,
        "session",
      )
      .catch(() => toast.error(t("sessions.terminateFailed")));
  };

  return (
    <div
      className="group flex items-start gap-0.5 rounded-[var(--r-control)] pr-1"
      data-selected={selected ? "true" : undefined}
      onAuxClick={(event) => {
        // 中键 = `×`：先问一句再结束。
        if (event.button !== 1) return;
        event.preventDefault();
        setConfirming(true);
      }}
    >
      {renaming ? (
        <Input
          ref={input}
          value={draft}
          autoFocus
          className="h-8 flex-1 text-[length:var(--text-body)]"
          aria-label={t("sessions.rename")}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitRename();
            if (event.key === "Escape") {
              setDraft(row.title);
              setRenaming(false);
            }
          }}
        />
      ) : (
        <Button
          variant="ghost"
          className="motion-hover h-auto min-h-[40px] flex-1 flex-col items-stretch gap-px rounded-[var(--r-control)] px-2 py-1 font-normal hover:bg-[var(--hover)] data-[selected=true]:bg-[color-mix(in_srgb,var(--brand)_15%,transparent)] data-[selected=true]:text-[var(--brand)]"
          data-selected={selected ? "true" : undefined}
          title={row.cwd}
          onClick={activate}
          onDoubleClick={() => {
            setDraft(row.title);
            setRenaming(true);
          }}
        >
          <span className="flex w-full items-center gap-1.5">
            {isAttention(row) ? (
              <Bell
                className="anim-dot-pulse size-3.5 shrink-0"
                style={{ color: "var(--danger)" }}
              />
            ) : row.unread ? (
              <Check
                className="size-3.5 shrink-0"
                style={{ color: "var(--brand)" }}
              />
            ) : (
              <ColorDot size={8} color={markerColor(row)} />
            )}
            <span className="flex-1 truncate text-left text-[length:var(--text-body)]">
              {row.title}
            </span>
            {agentId && (
              <span className="shrink-0 text-[length:var(--text-caption)] text-muted-foreground">
                {agentLabel(agentId)}
              </span>
            )}
          </span>
          <span className="flex w-full items-center gap-1.5 text-[length:var(--text-caption)] font-normal text-muted-foreground">
            <span className="truncate">{basename(row.cwd)}</span>
            <span className="ml-auto shrink-0 tabular-nums">
              {formatDuration(row.sinceMs)}
            </span>
          </span>
        </Button>
      )}

      <IconButton
        label={t("sessions.terminate")}
        className="mt-1.5 opacity-0 transition-opacity duration-[var(--dur-base)] group-focus-within:opacity-100 group-hover:opacity-100"
        onClick={() => setConfirming(true)}
      >
        <X />
      </IconButton>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("sessions.terminateTitle", { title: row.title })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("sessions.terminateDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("sessions.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={terminate}>
              {t("sessions.terminateConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
