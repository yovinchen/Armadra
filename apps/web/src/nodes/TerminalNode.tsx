import * as React from "react";
import {
  ArrowUpDown,
  Ban,
  Boxes,
  Moon,
  RotateCw,
  Search,
  Share2,
  Square,
  Unplug,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/ui/badge";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/ui/popover";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/ui/dropdown-menu";
import { useT } from "@/app/preferences-store";
import { useAgentsQuery } from "@/app/use-agents";
import { useCanvasStore } from "@/store/canvas-store";
import { AccountBindingBadge } from "@/agent/account/AccountBindingBadge";
import { ContextUsageMenu } from "@/agent/context-usage/ContextUsageMenu";
import { useContextUsage } from "@/agent/context-usage/use-context-usage";
import { agentLabel } from "@/agent/launch";
import { useAgentModels } from "../agent/models";
import { useNodeCapabilities } from "@/agent/capabilities";
import { PendingLaunchButton } from "@/agent/PendingLaunchButton";
import { StateSourceBadge } from "@/agent/StateSourceBadge";
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
import { autoNameNode } from "@/meta/annotations";
import { HandoffBadge } from "@/agent/handoff/HandoffBadge";
import { DriveBadge } from "./DriveBadge";
import { MemoryBadge } from "@/panels/resources/MemoryBadge";
import { openHandoff } from "@/agent/handoff/handoff-targets";
import { useSshHosts } from "@/panels/settings/ssh-hosts";
import { GithubReferenceBadge } from "@/panels/github/GithubReferenceBadge";
import { NodeShell } from "./NodeShell";
import type { NodeBodyProps } from "./registry";
import { answerApproval } from "./runtime-extras";
import { registerTerminalHandle } from "./terminal-registry";
// 副作用：注册 Agent 专属的右键菜单项（重启 / 权限模式 / 回收）
import "./terminal-menu";

/** 「打断这一轮」写进 PTY 的全部内容。没有正文，也不补回车。 */
const ESCAPE = "\x1b";

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
    // 表面还没挂上，谈不上在渲染；第一次 `onStatusChange` 就会覆盖它。
    render: "offscreen",
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
  // 列表由 Runtime 拼（CLI 自己报的 → models.dev 目录 → 离线写死表），
  // 用户实测过写死表里只有两个过时的 Codex 模型。
  const { models } = useAgentModels(agent?.id);
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
            void answerApproval(workspaceId ?? "", pendingId, decision);
          },
        }
      : undefined;

  const exited =
    surface.connection === "exited" || surface.connection === "failed";

  /**
   * 头部只留「一眼就要看到」的那几样（F5）。
   *
   * 内存常驻；账号 / 交接 / GitHub 三个徽标只在真的有绑定、有进行中的交接、
   * 有关联条目时才出现，所以它们不算常驻噪音；退出码与掉线是异常，必须说。
   * 上下文占用、Agent 名、SSH 主机名都挪进了 `···`：用户的原话是「只想看
   * 内存」，而那三样在多数时刻要么是「未知」，要么是一句重复的品牌名。
   */
  const headerChips = (
    <>
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
      {/*
        谁在驱动（`agent-delivery.md` §6）。只有真的有人或有 Agent 在驱动时
        才出现：空闲是常态，画出来只是噪音。
      */}
      {!exited && <DriveBadge nodeId={id} />}
      <GithubReferenceBadge nodeId={id} />
      {exited && (
        <Badge
          variant="outline"
          className="h-[18px] px-1.5 text-[length:var(--text-caption)]"
        >
          {t("terminal.exited")}
          {surface.exitCode === null ? "" : ` ${surface.exitCode}`}
        </Badge>
      )}
      {/*
        视图状态（终端宿主设计 §7.1）。只有两个状态值得占头部的位置：
        `disconnected` 是「socket 意外没了，正在退避重连」——必须说出来，
        否则用户会把一个静止的画面当成还活着；`detached` 是我们自己为了省
        资源关掉的，进程照跑，所以给一个安静得多的胶囊。
        `visible` / `focused` / `offscreen` 一律不显示：那是正常状态，
        把它画出来只是噪音。
        已退出的会话不再报掉线：那时 socket 关掉本来就是收尾。
      */}
      {!exited && surface.render === "disconnected" && (
        <Badge
          variant="outline"
          className="h-[18px] px-1.5 text-[length:var(--text-caption)] text-[var(--danger)]"
        >
          <Unplug className="size-2.5" />
          {t("terminal.render.disconnected")}
        </Badge>
      )}
      {!exited && surface.render === "detached" && (
        <Badge
          variant="outline"
          className="h-[18px] px-1.5 text-[length:var(--text-caption)] text-muted-foreground"
        >
          <Moon className="size-2.5" />
          {t("terminal.render.detached")}
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

      {/*
        搜索框进了 `···`，但它仍然要挂在头部右端：`PopoverAnchor` 是一个
        零尺寸的锚点，⌘F 与菜单里的「搜索」都只是把 `findOpen` 打开。
      */}
      <Popover open={findOpen} onOpenChange={setFindOpen}>
        <PopoverAnchor asChild>
          <span aria-hidden className="block size-0" />
        </PopoverAnchor>
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
    </span>
  );

  /** 收进 `···` 的那些：这个终端自己能做的事，排在通用的视图项之前。 */
  const menuItems = (
    <>
      {/* 「这是什么」先说：Agent 名与 SSH 主机名以前常驻头部，现在是菜单里
          一行静态说明——它们从来不需要每秒看一眼。 */}
      {(agent || sshLabel !== null) && (
        <DropdownMenuLabel className="flex items-center gap-1.5 font-normal text-muted-foreground">
          {agent && <span className="truncate">{agentLabel(agent.id)}</span>}
          {sshLabel !== null && (
            <>
              <ArrowUpDown className="size-3 shrink-0" />
              <span className="truncate">{sshLabel}</span>
            </>
          )}
        </DropdownMenuLabel>
      )}
      {/* 上下文占用（F5）：有来源时这一行直接写百分比，展开才是诊断表。 */}
      {agent && (
        <ContextUsageMenu
          nodeId={id}
          sessionId={sessionId}
          generation={generation}
          usage={context.usage}
          unavailableReason={
            exited ? "session_ended" : context.unavailableReason
          }
        />
      )}
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
      {/* Escape，不是 Ctrl+C。上一项把 SIGINT 发给前台进程组，对一个 Agent
          CLI 来说往往是把它整个打断掉；这一项只发一个 Escape——各家 CLI 用
          它停下当前这一轮，会话和上下文都还在。走的是用户自己按键的那条
          socket，不经 hook 路由：这就是用户按了一下 Esc。 */}
      {!exited && agent && (
        <DropdownMenuItem onSelect={() => surfaceRef.current?.sendKeys(ESCAPE)}>
          <Ban />
          {t("terminal.stopTurn")}
        </DropdownMenuItem>
      )}
      {/* 协作只剩「交接给…」（用户实测反馈 F8）：发消息、读上下文这些动词
          归 CLI 自己的技能，画布这边再摆一份入口只会多一处坏掉的路。
          「引用到 Agent」不在这里重复——它的来源必须是一个白板对象或 Frame，
          入口在那些对象自己的右键菜单里（`menus/reference-menu.tsx`）。
          交接（design §7）：只有 Agent 终端、只有连上了这条 PTY 才给得出会话
          身份，Runtime 按 generation 校验，所以断开时不给入口，而不是让用户
          填完表再被拒。 */}
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
                key={model.id}
                disabled={agent.model === model.id}
                onSelect={() => selectModel(model.id)}
              >
                {model.label}
                {model.source === "cli" && (
                  <span className="ml-auto pl-3 text-[11px] text-muted-foreground">
                    CLI
                  </span>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}
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
    </>
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
        {...(agent && !exited
          ? {
              headerMark: (
                <StateSourceBadge source={agentStatus?.stateSource} />
              ),
            }
          : {})}
        headerChips={headerChips}
        headerActions={headerActions}
        menuItems={menuItems}
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
