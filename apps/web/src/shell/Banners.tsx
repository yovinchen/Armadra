import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  PlugZap,
  Recycle,
  Repeat2,
  TerminalSquare,
  X,
} from "lucide-react";
import { runtimeApi } from "../api/client";
import { useDeliveryStore } from "../agent/delivery-store";
import { requestCenterOnNode } from "../canvas/flow/flow-context";
import { usePresenceBarVisible } from "../canvas/PresenceBar";
import { usePreferencesStore, useT } from "../app/preferences-store";
import { useAccess } from "../app/use-access";
import { useEnabledAgents } from "../app/use-agents";
import { useCanvasStore, type PanelState } from "../store/canvas-store";
import { cn } from "@/lib/cn";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { noDragProps, trafficLightInset } from "./window-region";
import { useCompactLayout } from "../platform/layout";
import { WORK_PANEL_WIDTH, openRightDrawer } from "../panels/WorkPanelSheet";

/** 保存失败时 Dock 的重试钮与通知条走同一个事件（App 监听后重新入队）。 */
export const SAVE_RETRY_EVENT = "armadra:save-retry";

/**
 * 通知条堆栈（§3.1，顶部居中）。
 *
 * 第一条（高 36px，离顶 4px）坐在窗口顶部 44px 那条标题带里（`--tabbar-h`，
 * 桌面壳里它本来就是拖窗口的区域，右上工具簇也在这一带），而不是标题带下面：
 * 以前的 `top:46` 正好压在视口顶部节点的标题栏中段，按在那里拖不动节点
 * （§49.3 → §58）。
 *
 * 堆栈挂在画布面里（`App` 把它放在 `.workspace-surface` 下，与工具簇同一层），
 * 左右各让出侧栏开关与工具簇（见 {@link bannerBounds}），在剩下那一段里居中；
 * 放不下就截断，完整的一句在悬停提示与读屏名里。外框不接指针，只有每一条
 * 本体接；本体在标题带里要写回 `no-drag`，否则桌面壳里按它的按钮是在拖窗口。
 *
 * 只放“需要用户知道且会持续存在”的四件事：保存失败、Runtime 断开、
 * 终端后端降级、CLI 配置里的旧版接入残留。一次性的信息用 sonner toast，
 * 不占画布。
 */
export function Banners() {
  const t = useT();
  const saveState = useCanvasStore((state) => state.saveState);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const setSettingsSection = usePreferencesStore(
    (state) => state.setLastSettingsSection,
  );
  const agents = useEnabledAgents();
  const member = useAccess().member;
  const [dismissed, setDismissed] = useState<string[]>([]);
  const notices = useDeliveryStore((state) => state.notices);
  const dismissNotice = useDeliveryStore((state) => state.dismissNotice);
  const selectNodes = useCanvasStore((state) => state.selectNodes);
  const nodes = useCanvasStore((state) => state.document?.nodes);
  const compact = useCompactLayout();
  const panels = useCanvasStore((state) => state.panels);
  const { left, right } = bannerBounds(panels, compact);
  // 多设备时右上多一条设备条（`canvas/PresenceBar`），宽度随设备与租约变，
  // 标题带里放不下两样：这时通知条退到设备条下面那一行。
  const belowPresence = usePresenceBarVisible();
  const nodeTitle = (nodeId: string) =>
    nodes?.find((node) => node.id === nodeId)?.title ?? nodeId;

  const health = useQuery({
    queryKey: ["health"],
    queryFn: runtimeApi.health,
    retry: false,
    // 断开时 5 秒一次，正常时 30 秒一次
    refetchInterval: (query) => (query.state.error ? 5_000 : 30_000),
  });

  const backend = useQuery({
    queryKey: ["terminal-backend"],
    queryFn: runtimeApi.terminalBackend,
    retry: false,
    staleTime: 60_000,
  });

  /**
   * 旧版接入残留（agent-integration.md §4）。Runtime 启动时只扫描不改，
   * 设置页又不是每天都开；用户实测过两次「Codex 的 hook 整份不跑、模型去跑
   * 旧脚本」都没意识到是残留在作怪，所以这里点名哪些 CLI 有，指向修复。
   * 只问一次：残留不会自己出现，修复之后由设置页那边刷新。
   */
  const residue = useQuery({
    queryKey: ["integration-residue", agents.map((agent) => agent.id)],
    queryFn: async () => {
      const names = await Promise.all(
        agents.map(async (agent) => {
          try {
            const state = await runtimeApi.agentIntegration(agent.id);
            return state.legacy.found.length > 0 ? agent.label : null;
          } catch {
            return null;
          }
        }),
      );
      return names.filter((name): name is string => name !== null);
    },
    // 修复在「集成」页，那是本机管理：服务器壳上的成员既读不到（403）也修不了。
    enabled: agents.length > 0 && !member,
    retry: false,
    staleTime: Infinity,
  });

  const items: ReactNode[] = [];

  if (saveState === "error" && !dismissed.includes("save")) {
    items.push(
      <Banner
        key="save"
        tone="danger"
        icon={<AlertTriangle />}
        text={t("banner.saveFailed")}
        actionLabel={t("banner.saveRetry")}
        onAction={() => window.dispatchEvent(new CustomEvent(SAVE_RETRY_EVENT))}
        onDismiss={() => setDismissed((list) => [...list, "save"])}
      />,
    );
  }

  if (health.isError && !dismissed.includes("runtime")) {
    items.push(
      <Banner
        key="runtime"
        tone="danger"
        icon={<PlugZap />}
        text={t("banner.runtimeDown")}
        actionLabel={t("banner.runtimeRetry")}
        onAction={() => void health.refetch()}
        onDismiss={() => setDismissed((list) => [...list, "runtime"])}
      />,
    );
  }

  if (backend.data?.reason && !dismissed.includes("backend")) {
    items.push(
      <Banner
        key="backend"
        tone="warn"
        icon={<TerminalSquare />}
        text={t("banner.tmuxFallback")}
        actionLabel={t("banner.backendSettings")}
        onAction={() => setPanel("settings", true)}
        onDismiss={() => setDismissed((list) => [...list, "backend"])}
      />,
    );
  }

  if (
    residue.data &&
    residue.data.length > 0 &&
    !dismissed.includes("residue")
  ) {
    items.push(
      <Banner
        key="residue"
        tone="warn"
        icon={<Recycle />}
        text={t("banner.legacyResidue", { agents: residue.data.join(" · ") })}
        actionLabel={t("banner.legacyRepair")}
        onAction={() => {
          setSettingsSection("integration");
          setPanel("settings", true);
        }}
        onDismiss={() => setDismissed((list) => [...list, "residue"])}
      />,
    );
  }

  /*
   * 被拦下的投递（设计 `agent-delivery.md` §10）。
   *
   * 这是通知条里唯一一条**由一次事件**而不是由一个持续状态驱动的：环与速率
   * 闸拦下的那一次不会留下任何一个「还在错着」的状态，所以它只能由发生过的
   * 那件事自己说一次。去重、计数与「关掉之后多久不再来」都在 store 里
   * （`agent/delivery-store.ts`），这里只画。
   */
  for (const notice of notices) {
    items.push(
      <Banner
        key={notice.id}
        tone="warn"
        icon={<Repeat2 />}
        text={t("delivery.notice", {
          source: nodeTitle(notice.sourceNodeId),
          target: nodeTitle(notice.targetNodeId),
          reason: t(`error.delivery.${notice.code}`),
        })}
        actionLabel={t("delivery.notice.open")}
        onAction={() => {
          selectNodes([notice.sourceNodeId, notice.targetNodeId]);
          requestCenterOnNode(notice.targetNodeId);
        }}
        onDismiss={() => dismissNotice(notice.id)}
      />,
    );
  }

  if (items.length === 0) return null;

  return (
    <div
      data-slot="banners"
      style={{ left, right }}
      data-below-presence={belowPresence ? "true" : undefined}
      className={cn(
        "pointer-events-none absolute z-[var(--z-banners)] flex flex-col items-center gap-2",
        belowPresence ? "top-[60px]" : "top-[4px]",
      )}
    >
      {items}
    </div>
  );
}

/**
 * 堆栈在画布面（`.workspace-surface`）里左右各让到哪儿。
 *
 * 标题带里左上角是侧栏开关（侧栏收起或窄屏时它落在画布上，`shell/LeftSidebar`），
 * 右上角是工具簇，开着右侧抽屉时工具簇还会往左让一个抽屉宽
 * （`shell/ControlsCluster`）。提示条在剩下那一段里居中，放不下就截断，
 * 不会盖住这两样。
 */
export function bannerBounds(
  panels: PanelState,
  compact: boolean,
): { left: string; right: string } {
  const toggleOnCanvas = compact || panels.sidebar === "collapsed";
  // 侧栏开关：信号灯占位 + 8px 边距 + 28px 钮 + 8px 间距。
  const left = toggleOnCanvas ? `${trafficLightInset() + 44}px` : "14px";
  // 工具簇：14px 边距 + 38px 宽 + 8px 间距；开着抽屉时再加抽屉宽。
  const drawer = compact ? null : openRightDrawer(panels);
  const right = drawer
    ? `calc(60px + min(100vw, ${WORK_PANEL_WIDTH[drawer]}))`
    : "60px";
  return { left, right };
}

function Banner({
  tone,
  icon,
  text,
  actionLabel,
  onAction,
  onDismiss,
}: {
  tone: "danger" | "warn";
  icon: ReactNode;
  text: string;
  actionLabel?: string;
  onAction?: () => void;
  /** 省略即不可关闭：状态自己会消失的横幅关掉只会让界面自相矛盾。 */
  onDismiss?: () => void;
}) {
  const t = useT();
  return (
    <div
      role="status"
      data-tone={tone}
      data-slot="banner"
      {...noDragProps()}
      className="pointer-events-auto motion-fade-in flex h-9 max-w-full min-w-0 items-center gap-2 rounded-[var(--r-card)] border border-border bg-[var(--panel)]/90 pr-1.5 pl-3 shadow-[var(--shadow-pill)] backdrop-blur-[12px] data-[tone=danger]:text-danger data-[tone=warn]:text-warn"
    >
      <span className="shrink-0 [&_svg]:size-4 [&_svg]:[stroke-width:1.5]">
        {icon}
      </span>
      <span className="min-w-0 truncate text-foreground" title={text}>
        {text}
      </span>
      {actionLabel && onAction && (
        <Button variant="outline" size="xs" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
      {onDismiss && (
        <IconButton label={t("banner.dismiss")} onClick={onDismiss}>
          <X />
        </IconButton>
      )}
    </div>
  );
}
