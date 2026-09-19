import * as React from "react";
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw, X } from "lucide-react";

import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { openExternal } from "@/platform";
import { useCanvasStore } from "@/store/canvas-store";
import { useReactFlow } from "@xyflow/react";
import { useT } from "@/app/preferences-store";
import { useKeybindings } from "@/keybindings";

import { NodeShell } from "../NodeShell";
import type { NodeBodyProps } from "../registry";
import { browserPartition } from "./desktop";
import { control, isDriven, useDrive } from "./drive";
import { LeaseBadge } from "./Lease";
import { useIsGhost } from "./pool";
import { GuestBoundary } from "./GuestBoundary";
import { WebviewGuest } from "./WebviewGuest";
import { WebviewTabs } from "./WebviewTabs";
import { searchOrUrl } from "./webview";
import type { WebviewElement } from "./webview";
import { useWebviewTabs } from "./webview-tabs";

/**
 * Electron 壳里的浏览器节点（W3.1 / W3.2）。
 *
 * 页面就在本窗口的一个 OOPIF 里：没有 Runtime 托管的 Chromium，也没有一条
 * HTTP 的浏览器端点可打——W3.5 把那一整条路删掉了。Runtime 仍然持有授权与
 * 租约，走的是 `browser:drive` 这条窄通道（`./drive`）。
 *
 * 标签：每个标签一个 `<webview>`，非活动的用 `display:none` 留在 DOM 里。卸
 * 载一个后台标签等于杀掉那个渲染进程，切回来就是整页重载（browser-node §1.2）。
 */
export function WebviewSurface({ id, node, selected }: NodeBodyProps) {
  const t = useT();
  const workspaceId = useCanvasStore((state) => state.workspace?.id);
  const url = node.data.kind === "browser" ? node.data.url : "";
  const ghost = useIsGhost(id);

  /**
   * **创建时定一次、永不变更**（探针 C：attach 之后改 partition 被静默忽略）。
   * `useState` 的惰性初值就是「一次」的最短写法；`workspaceId` 后来变了也不
   * 重算——那时候这个节点已经属于另一个工作空间的 pool ghost 了。
   *
   * `driver` 现在恒为 `"user"`。Agent 开的节点走另一个 jar，那条路是 W3.3。
   */
  const [partition] = React.useState(() =>
    browserPartition(workspaceId, "user"),
  );

  const tabs = useWebviewTabs(url);
  const [address, setAddress] = React.useState(url);
  const guestRefs = React.useRef(new Map<string, WebviewElement | null>());

  /* ------------------------------ 驱动通道 ------------------------------- */
  /**
   * 主进程能做的到不了标签，所以标签这三件事是被**请求**的，不是被执行的。
   * 动词回的是自己重测的标签表，所以请求落没落地看得出来，不需要回执。
   */
  const lease = useDrive(id, {
    onSwitchTab: (tabId) => tabs.select(tabId),
    onOpenTab: (next) => tabs.open(next),
    onCloseTab: (tabId) => tabs.close(tabId),
  });
  const driven = isDriven(lease);
  const [leaseBusy, setLeaseBusy] = React.useState(false);
  const flow = useReactFlow();
  // 画布缩放，只服务右键菜单的坐标换算。跟着渲染走就够——缩放变化必然重渲。
  const zoom = flow.getZoom();

  // 地址栏跟着活动标签走；人正在里面打字时不抢（焦点在 input 上就不动）。
  const addressRef = React.useRef<HTMLInputElement | null>(null);
  const activeAddress = tabs.active.address;
  React.useEffect(() => {
    if (document.activeElement === addressRef.current) return;
    setAddress(activeAddress);
  }, [activeAddress]);

  /* ------------------------------- 持久化 -------------------------------- */
  /**
   * 活动标签停在哪一页，就把哪一页写回节点。关掉节点再开回到这里。
   *
   * 写的是画布文档而不是 `browser_sessions.active_tab_url`：那一列由 Runtime
   * 的会话在导航时写，而这条路上**没有会话**。W3.3 接通 `browser:drive` 之后
   * Runtime 才重新知道 guest 停在哪；在那之前节点自己的 `url` 是唯一真相，
   * 它本来就走同一套持久化（`whiteboard_json` → 工作空间）。
   */
  const persist = React.useCallback(
    (next: string) => {
      if (ghost || !next || next === "about:blank") return;
      const store = useCanvasStore.getState();
      const current = store.document?.nodes.find((each) => each.id === id);
      if (current?.data.kind === "browser" && current.data.url === next) return;
      store.updateNodeData(id, { url: next });
    },
    [id, ghost],
  );

  /* -------------------------------- 导航 --------------------------------- */
  const guestOf = (tabId: string) => guestRefs.current.get(tabId) ?? null;

  function commit(input: string) {
    const target = searchOrUrl(input);
    if (!target) return;
    setAddress(target);
    tabs.patch(tabs.activeId, { src: target, address: target, loading: true });
    persist(target);
  }

  function step(delta: number) {
    const guest = guestOf(tabs.activeId);
    if (!guest) return;
    if (delta < 0) guest.goBack();
    else guest.goForward();
  }

  /** Reload / Stop 合一：正在加载时是 Stop。 */
  function reloadOrStop() {
    const guest = guestOf(tabs.activeId);
    if (!guest) return;
    if (tabs.active.loading) guest.stop();
    else guest.reload();
  }

  const [keyboardRoot, setKeyboardRoot] = React.useState<HTMLElement | null>(
    null,
  );
  useKeybindings(
    {
      "browser.reload": () => reloadOrStop(),
      "browser.back": () => step(-1),
      "browser.forward": () => step(1),
      "browser.focusAddress": () => addressRef.current?.select(),
    },
    { scopes: ["browser"], target: keyboardRoot },
  );

  /**
   * Stop 一路走到 Runtime 的租约状态机，不在这里停。
   *
   * 只隐藏徽标是 Critical 级 bug：那会留下一个仍然 attach 着的 debugger 和一
   * 个用户以为已经收回的页面。撤销的两件事（丢所有权 + detach）都在远端，这
   * 里只是按钮。
   */
  async function handControl(action: "takeover" | "release") {
    setLeaseBusy(true);
    try {
      await control(id, action);
    } finally {
      setLeaseBusy(false);
    }
  }

  const active = tabs.active;
  const headerActions = (
    <>
      {/*
        徽标**无条件显示**，没有关掉它的设置，也不打算加：用户不能凭偏好变成
        驱动盲。租约空闲时它说的是「没有人在操作」。
      */}
      <LeaseBadge
        lease={lease}
        deviceId="local"
        busy={leaseBusy}
        onTakeover={() => void handControl("takeover")}
        onHandback={() => void handControl("release")}
      />
      <IconButton
        label={t("browser.back")}
        disabled={!active.canGoBack}
        onClick={() => step(-1)}
      >
        <ArrowLeft />
      </IconButton>
      <IconButton
        label={t("browser.forward")}
        disabled={!active.canGoForward}
        onClick={() => step(1)}
      >
        <ArrowRight />
      </IconButton>
      <IconButton
        label={active.loading ? t("browser.stop") : t("browser.reload")}
        onClick={reloadOrStop}
      >
        {active.loading ? <X /> : <RotateCw />}
      </IconButton>
      <IconButton
        label={t("browser.openExternal")}
        disabled={!active.address}
        onClick={() => void openExternal(active.address)}
      >
        <ExternalLink />
      </IconButton>
    </>
  );

  return (
    <NodeShell node={node} selected={selected} headerActions={headerActions}>
      <div
        ref={setKeyboardRoot}
        data-keybinding-scope="browser"
        className="flex h-full w-full flex-col"
      >
        {/* 工具栏 28px：地址栏 20px + 上下 4px。页面本身才是内容，这条边不该
            比一个真浏览器的还厚（契约 §3.4，2026-09-19）。 */}
        <div className="flex h-[28px] shrink-0 items-center gap-1 px-1">
          <Input
            ref={addressRef}
            aria-label={t("browser.address")}
            className="h-5 min-w-0 flex-1 font-mono text-[12px]"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit(address);
            }}
          />
        </div>
        <WebviewTabs control={tabs} />
        {/*
          `nodrag nowheel`，**没有 hover-guard**（browser-node §2.2 的有意取舍）：
          网页要立刻拿到指针，代价是不能从页面上起手框选或平移画布。
          `nowheel` 在这里其实无事可做——guest 的滚轮根本不跨进程边界——留着是
          因为工具栏与标签条也在这棵子树里。
        */}
        <div
          className="nodrag nowheel relative min-h-0 flex-1 bg-[var(--browser-bg)]"
          data-slot="browser-stage"
          data-no-drag="true"
        >
          {tabs.tabs.map((tab) => (
            <div
              key={tab.id}
              className="absolute inset-0"
              style={tab.id === tabs.activeId ? undefined : { display: "none" }}
            >
              <GuestBoundary
                fallback={
                  <div
                    className="grid h-full w-full place-items-center px-6 text-center text-[11px] text-muted-foreground"
                    data-slot="browser-guest-failed"
                  >
                    {t("browser.guestFailed")}
                  </div>
                }
              >
                <WebviewGuest
                  nodeId={id}
                  zoom={zoom}
                  tab={tab}
                  partition={partition}
                  hidden={ghost || tab.id !== tabs.activeId}
                  ghost={ghost}
                  driven={driven}
                  onPatch={(change) => tabs.patch(tab.id, change)}
                  onNavigate={(next) => {
                    if (tab.id === tabs.activeId) persist(next);
                  }}
                  onOpenTab={(next) => tabs.open(next)}
                  onElement={(element) =>
                    guestRefs.current.set(tab.id, element)
                  }
                />
              </GuestBoundary>
            </div>
          ))}
        </div>
      </div>
    </NodeShell>
  );
}
