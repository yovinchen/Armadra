import * as React from "react";
import {
  ArrowUpDown,
  Boxes,
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
import { modelSuggestions } from "@armadra/shared";
import { useT } from "@/app/preferences-store";
import { useAgentsQuery } from "@/app/use-agents";
import { useCanvasStore } from "@/store/canvas-store";
import { AccountBindingBadge } from "@/agent/account/AccountBindingBadge";
import { ContextUsageBadge } from "@/agent/context-usage/ContextUsageBadge";
import { useContextUsage } from "@/agent/context-usage/use-context-usage";
import { agentLabel } from "@/agent/launch";
import { useNodeCapabilities } from "@/agent/capabilities";
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
  autoNameNode,
  canSuggestTitle,
  openNodeAnnotation,
  suggestNodeTitle,
} from "@/meta/annotations";
import { HandoffBadge } from "@/agent/handoff/HandoffBadge";
import { MemoryBadge } from "@/panels/resources/MemoryBadge";
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
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? null);
  const agents = useAgentsQuery();
  const contextEnabled = Boolean(
    agent &&
      !data?.ssh &&
      agents.data
        ?.find((entry) => entry.id === agent.id)
        ?.capabilities.includes("contextUsage"),
  );
  const context = useContextUsage({
    workspaceId,
    nodeId: id,
    sessionId: surface.binding?.sessionId ?? null,
    generation: surface.binding?.generation ?? null,
    modelSelection: agent?.model || null,
    enabled: contextEnabled,
  });
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

  /*
   * 模型选择（Agent 自动化设计 §1）。
   *
   * 能不能选由求交集的结果说了算：基础适配器声明 → 自定义配置 → CLI 版本
   * 探测 → 执行主机。探测答不上来就是 unknown，unknown 不出现菜单——设计
   * §10「版本降级后隐藏不可用动作」的另一半是：探测失败时也不要画伪按钮。
   */
  const executionHost = data?.ssh ? "ssh" : "local";
  const capabilities = useNodeCapabilities(agent?.id, executionHost);
  const modelSelectable = capabilities.includes("supportsModelSelection");
  const models = React.useMemo(
    () =>
      modelSuggestions(
        agents.data?.find((entry) => entry.id === agent?.id)?.baseAgent ??
          agent?.id ??
          "",
      ),
    [agents.data, agent?.id],
  );
  const selectModel = React.useCallback(
    (model: string | undefined) => {
      if (!agent) return;
      const { model: _previous, ...rest } = agent;
      useCanvasStore.getState().updateNodeData(id, {
        agent: model ? { ...rest, model } : rest,
      });
      // 不重启：那会杀掉用户正在进行的对话。说清楚它什么时候生效。
      toast.info(
        t("agent.modelQueued", { model: model ?? t("agent.modelDefault") }),
      );
    },
    [agent, id, t],
  );

  /*
   * 自动命名（Agent 自动化设计 §8）。
   *
   * 触发点是「第一个 Hook 回合」而不是「第一段输出」：`suggest-title` 读的是
   * 转录，而转录要等 CLI 真的应答过一轮才有内容——早于这一刻问，拿回来的只会
   * 是 Agent 的品牌名，把占位标题换成另一个占位标题。
   *
   * 判「已经有回合」用的是 `sessionPhase`/`lastEventAt` 而不是 `state`：
   * 一个刚建好的节点也会有 `state`，但没有 `lastEventAt`。
   *
   * 规则（占位标题才应用、人工改名即锁定、每代次一次）全在 `autoNameNode`
   * 里；这里只负责在合适的时刻叫它一次。
   */
  const reported = Boolean(agentStatus?.lastEventAt);
  const sessionId = surface.binding?.sessionId ?? null;
  const generation = surface.binding?.generation ?? null;
  React.useEffect(() => {
    if (!agent || !reported) return;
    void autoNameNode(id, { sessionId, generation });
  }, [agent, id, reported, sessionId, generation]);

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
      {agent && (
        <ContextUsageBadge
          nodeId={id}
          sessionId={sessionId}
          generation={generation}
          usage={context.usage}
          unavailableReason={
            exited ? "session_ended" : context.unavailableReason
          }
        />
      )}
      {/*
        内存徽标（路线图 §4.3）。Agent 和普通 shell 都有：一个跑 `cargo build`
        的普通终端和一个 Agent 一样会吃掉几个 GB。SSH 会话的进程树在别的机器
        上，本机测不到，所以不显示——那里的数字只可能是假的（设计 §8）。
      */}
      {!data?.ssh && !exited && (
        <MemoryBadge
          nodeId={id}
          workspaceId={workspaceId}
          sessionId={sessionId}
          generation={generation}
          visible={!collapsed}
        />
      )}
      {agent && <AccountBindingBadge agent={agent} />}
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
          {/* 模型选择（Agent 自动化设计 §1、§2.1）。
              只在 CLI 真的支持、版本探测答得上来、执行主机也允许时出现——
              `supportsModelSelection` 是求交集之后的结果，探测失败是 unknown，
              unknown 不画按钮，免得点开一个用不了的菜单。
              改模型不重启已经在跑的会话：那会杀掉用户正在进行的对话。写进
              节点数据，下一次启动的启动行带上它，并如实说明这一点。 */}
          {agent && modelSelectable && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Boxes />
                {t("agent.model")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-60 max-w-[calc(100vw-24px)]">
                <p className="px-2 py-2 text-xs leading-relaxed text-muted-foreground">
                  {t("agent.modelHint")}
                </p>
                <DropdownMenuItem
                  disabled={!agent.model}
                  onSelect={() => selectModel(undefined)}
                >
                  {t("agent.modelDefault")}
                </DropdownMenuItem>
                {models.map((model) => (
                  <DropdownMenuItem
                    key={model}
                    disabled={agent.model === model}
                    onSelect={() => selectModel(model)}
                  >
                    {model}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
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
