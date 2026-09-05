import * as React from "react";
import {
  ArrowUpDown,
  Copy,
  Network,
  MessageSquare,
  MoreHorizontal,
  RotateCw,
  Search,
  Share2,
  Sparkles,
  Square,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/ui/badge";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { useT } from "@/app/preferences-store";
import { useAgentsQuery } from "@/app/use-agents";
import { useCanvasStore } from "@/store/canvas-store";
import { ContextUsageBadge } from "@/agent/context-usage/ContextUsageBadge";
import { useContextUsage } from "@/agent/context-usage/use-context-usage";
import { agentLabel } from "@/agent/launch";
import { PendingLaunchButton } from "@/agent/PendingLaunchButton";
import {
  agentHeaderState,
  useAgentStatus,
  useAgentStatusStore,
} from "@/agent/status-store";
import {
  BELL_FLASH_MS,
  TerminalSurface,
  type TerminalSurfaceHandle,
  type TerminalSurfaceStatus,
} from "@/terminal/TerminalSurface";
import {
  canSuggestTitle,
  openNodeAnnotation,
  suggestNodeTitle,
} from "@/meta/annotations";
import { HandoffBadge } from "@/agent/handoff/HandoffBadge";
import { openHandoff } from "@/agent/handoff/handoff-targets";
import { useSshHosts } from "@/panels/settings/ssh-hosts";
import { NodeShell } from "./NodeShell";
import type { NodeBodyProps } from "./registry";
import { answerApproval } from "./runtime-extras";
import { registerTerminalHandle } from "./terminal-registry";
// 副作用：注册 Agent 专属的右键菜单项（重启 / 权限模式 / 回收）
import "./terminal-menu";

/** 清未读（本地 + 回执）。已读时是空操作，可以随手调。 */
function markNodeRead(nodeId: string): void {
  const store = useAgentStatusStore.getState();
  if (store.statuses[nodeId]?.unread) store.markRead(nodeId);
}

/**
 * 终端节点（含 Agent，§5.1）。节点体就是 xterm；头部按 §3.4 排：
 * Agent chip → 退出码 → 状态胶囊 →（blocked 时）允许/拒绝 → 右侧图标钮。
 */
export function TerminalNode({ id, node, selected, collapsed }: NodeBodyProps) {
  const t = useT();
  const data = node.data.kind === "terminal" ? node.data : undefined;
  const agent = data?.agent;
  // SSH 终端（§21）：头部 chip 显示主机名；主机被删掉时退回 id，
  // 免得节点看起来像一个普通本地终端。
  const hosts = useSshHosts();
  const sshLabel = data?.ssh
    ? (hosts.find((host) => host.id === data.ssh?.hostId)?.name ??
      data.ssh.hostId)
    : null;
  const agentStatus = useAgentStatus(id);
  const surfaceRef = React.useRef<TerminalSurfaceHandle>(null);

  const [surface, setSurface] = React.useState<TerminalSurfaceStatus>({
    connection: "idle",
    exitCode: data?.lastExitCode ?? null,
    error: null,
  });
  const [findOpen, setFindOpen] = React.useState(false);
  const workspaceId=useCanvasStore(state=>state.workspace?.id??null);
  const agents=useAgentsQuery();
  const contextEnabled=Boolean(agent && !data?.ssh && agents.data?.find(entry=>entry.id===agent.id)?.capabilities.includes("contextUsage"));
  const context=useContextUsage({workspaceId,nodeId:id,sessionId:surface.binding?.sessionId??null,generation:surface.binding?.generation??null,modelSelection:agent?.model||null,enabled:contextEnabled});
  const [query, setQuery] = React.useState("");
  /** BEL：头部图标闪 600ms（§18.3 铃声行）。只换颜色，不改任何尺寸。 */
  const [bell, setBell] = React.useState(false);
  const bellTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const onStatusChange = React.useCallback((next: TerminalSurfaceStatus) => {
    setSurface(next);
  }, []);

  const onBell = React.useCallback(() => {
    setBell(true);
    if (bellTimerRef.current) clearTimeout(bellTimerRef.current);
    bellTimerRef.current = setTimeout(() => setBell(false), BELL_FLASH_MS);
  }, []);

  const onFind = React.useCallback(() => setFindOpen(true), []);

  React.useEffect(
    () => () => {
      if (bellTimerRef.current) clearTimeout(bellTimerRef.current);
    },
    [],
  );

  // 右键菜单和画布控制 API 拿不到组件 ref，句柄统一走 terminal-registry
  React.useEffect(() => {
    const handle = surfaceRef.current;
    if (!handle) return;
    return registerTerminalHandle(id, handle);
  }, [id]);

  // 胶囊 / 光晕的映射表在 status-store：会话侧栏与子代理卡片读同一张表。
  const header = agent ? agentHeaderState(agentStatus) : {};

  const approval =
    agent && agentStatus?.state === "blocked" && agentStatus.pendingId
      ? {
          pendingId: agentStatus.pendingId,
          onAnswer: (decision: "allow" | "deny") => {
            const pendingId = agentStatus.pendingId as string;
            // 先收起按钮：Runtime 的下一条 `agent.status` 未必立刻到，
            // 让用户对着一个已经答过的请求再点一次是最糟的。
            useAgentStatusStore.getState().resolveApproval(pendingId);
            void answerApproval(pendingId, decision);
          },
        }
      : undefined;

  const exited =
    surface.connection === "exited" || surface.connection === "failed";

  const headerChips = (
    <>
      {agent && <ContextUsageBadge nodeId={id} sessionId={surface.binding?.sessionId??null} generation={surface.binding?.generation??null} usage={context.usage} unavailableReason={exited?"session_ended":context.unavailableReason} />}
      {agent && <HandoffBadge nodeId={id} />}
      {sshLabel !== null && (
        <Badge
          variant="outline"
          className="h-[18px] px-1.5 text-[length:var(--text-caption)]"
        >
          <ArrowUpDown className="size-2.5" />
          <span className="truncate">{sshLabel}</span>
        </Badge>
      )}
      {agent && node.title !== agentLabel(agent.id) && (
        <span className="truncate text-[length:var(--text-caption)] text-muted-foreground">
          {agentLabel(agent.id)}
        </span>
      )}
      {exited && (
        <Badge
          variant="outline"
          className="h-[18px] px-1.5 text-[length:var(--text-caption)]"
        >
          {t("terminal.exited")}
          {surface.exitCode === null ? "" : ` ${surface.exitCode}`}
        </Badge>
      )}
    </>
  );

  const headerActions = (
    // `display:contents` 的包裹层：只为了给下面的图标挂一个铃声闪烁类，
    // 它自己不占布局，头部仍然是一行 34px（§18.2 规则 1）。
    <span
      style={{ display: "contents" }}
      {...(bell ? { "data-bell": "true" } : {})}
    >
      <PendingLaunchButton nodeId={id} />
      {exited && (
        <IconButton
          label={t("terminal.rerun")}
          onClick={() => surfaceRef.current?.restart()}
        >
          <RotateCw />
        </IconButton>
      )}
      {!exited && (
        <IconButton
          className="node-secondary-action terminal-secondary-action"
          label={t("terminal.interrupt")}
          onClick={() => surfaceRef.current?.terminate("interrupt")}
        >
          <Square />
        </IconButton>
      )}

      <Popover open={findOpen} onOpenChange={setFindOpen}>
        <PopoverTrigger asChild>
          <IconButton
            className="node-secondary-action terminal-secondary-action"
            label={t("terminal.find")}
          >
            <Search />
          </IconButton>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[220px] p-1.5">
          <Input
            autoFocus
            aria-label={t("terminal.find")}
            className="h-7 text-xs"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                surfaceRef.current?.find(
                  query,
                  event.shiftKey ? "previous" : "next",
                );
              }
              if (event.key === "Escape") {
                surfaceRef.current?.clearSearch();
                setFindOpen(false);
              }
            }}
          />
        </PopoverContent>
      </Popover>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton label={t("terminal.more")}>
            <MoreHorizontal />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          <DropdownMenuItem onSelect={() => setFindOpen(true)}>
            <Search />
            {t("terminal.find")}
          </DropdownMenuItem>
          {!exited && (
            <DropdownMenuItem
              onSelect={() => surfaceRef.current?.terminate("interrupt")}
            >
              <Square />
              {t("terminal.interrupt")}
            </DropdownMenuItem>
          )}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Network />
              {t("terminal.collaboration")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-64 max-w-[calc(100vw-24px)]">
              <p className="px-2 py-2 text-xs leading-relaxed text-muted-foreground">
                {t("terminal.collaborationHint")}
              </p>
              <code className="block select-text px-2 pb-2 text-xs">
                armadra-hook canvas help
              </code>
              <DropdownMenuItem
                onSelect={() => {
                  void navigator.clipboard
                    .writeText("armadra-hook canvas help")
                    .then(
                      () => toast.success(t("terminal.commandCopied")),
                      () => toast.error(t("terminal.copyFailed")),
                    );
                }}
              >
                <Copy />
                {t("terminal.copyHelpCommand")}
              </DropdownMenuItem>
              {/* 交接（design §7）：只有 Agent 终端、只有连上了这条 PTY 才
                  给得出会话身份，Runtime 按 generation 校验，所以断开时不给
                  入口，而不是让用户填完表再被拒。 */}
              {agent && surface.binding && (
                <DropdownMenuItem
                  onSelect={() =>
                    openHandoff({
                      nodeId: id,
                      sessionId: surface.binding!.sessionId,
                      generation: surface.binding!.generation,
                    })
                  }
                >
                  <Share2 />
                  {t("handoff.open")}
                </DropdownMenuItem>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          {/* AI 命名 / 评论（§17）。头部不再加按钮、也不加行：终端节点的头部
              永远是一行 34px，下面直接是 xterm，多一行就会触发 fit 抖动。 */}
          {canSuggestTitle(node) && (
            <DropdownMenuItem onSelect={() => void suggestNodeTitle(id)}>
              <Sparkles />
              {t("meta.suggestTitle")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => openNodeAnnotation(id, "note")}>
            <MessageSquare />
            {t("meta.note")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => surfaceRef.current?.terminate("process")}
          >
            {t("terminal.killProcess")}
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => surfaceRef.current?.terminate("session")}
          >
            {t("terminal.destroySession")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => surfaceRef.current?.recycle()}>
            {t("terminal.recycle")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => surfaceRef.current?.restart()}>
            {t("terminal.rerun")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );

  if (!data) return null;

  return (
    <div
      className="h-full w-full"
      // 摸一下终端就算读过了（`markRead` 顺手把回执 POST 给 Runtime）。
      // 指针与鼠标两条路都挂：合成点击（自动化、部分输入设备）只发其中一种。
      onPointerDownCapture={() => markNodeRead(id)}
      onMouseDownCapture={() => markNodeRead(id)}
      onKeyDown={(event) => {
        // ⌘F / Ctrl+F 在终端里打开头部的搜索框，而不是浏览器查找
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "f"
        ) {
          event.preventDefault();
          setFindOpen(true);
        }
      }}
    >
      <NodeShell
        node={node}
        selected={selected}
        {...(header.pill
          ? {
              status: {
                tone: header.pill.tone,
                label: t(header.pill.labelKey),
              },
            }
          : {})}
        {...(header.glow ? { glow: header.glow } : {})}
        {...(approval ? { approval } : {})}
        headerChips={headerChips}
        headerActions={headerActions}
      >
        <TerminalSurface
          ref={surfaceRef}
          nodeId={id}
          data={data}
          collapsed={collapsed}
          onStatusChange={onStatusChange}
          onBell={onBell}
          onFind={onFind}
        />
      </NodeShell>
    </div>
  );
}
