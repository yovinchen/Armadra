import * as React from "react";
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw, X } from "lucide-react";

import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { openExternal } from "@/platform";
import { useCanvasStore } from "@/store/canvas-store";
import { useT } from "@/app/preferences-store";
import { useKeybindings } from "@/keybindings";

import { NodeShell } from "../NodeShell";
import type { NodeBodyProps } from "../registry";
import { browserPartition } from "./desktop";
import { WebviewGuest } from "./WebviewGuest";
import { WebviewTabs } from "./WebviewTabs";
import { searchOrUrl } from "./webview";
import type { WebviewElement } from "./webview";
import { useWebviewTabs } from "./webview-tabs";

/**
 * Electron 壳里的浏览器节点（W3.1）。
 *
 * 和 screencast 那条路的区别不只是「画面从哪来」：这里没有会话、没有租约、
 * 没有 Runtime 里的那个 Chromium 进程，页面就在本窗口的一个 OOPIF 里。因此
 * 这个文件**不碰** `runtimeApi` 的任何一个浏览器端点——W3.5 之前两条路并存，
 * 互相不知道对方存在是它们能各自独立回退的前提。
 *
 * 标签：每个标签一个 `<webview>`，非活动的用 `display:none` 留在 DOM 里。卸
 * 载一个后台标签等于杀掉那个渲染进程，切回来就是整页重载（browser-node §1.2）。
 */
export function WebviewSurface({ id, node, selected }: NodeBodyProps) {
  const t = useT();
  const workspaceId = useCanvasStore((state) => state.workspace?.id);
  const url = node.data.kind === "browser" ? node.data.url : "";

  /**
   * **创建时定一次、永不变更**（探针 C：attach 之后改 partition 被静默忽略）。
   * `useState` 的惰性初值就是「一次」的最短写法；`workspaceId` 后来变了也不
   * 重算——那时候这个节点已经不属于原来那个工作空间了。
   *
   * `driver` 现在恒为 `"user"`。Agent 开的节点走另一个 jar，那条路是 W3.3。
   */
  const [partition] = React.useState(() =>
    browserPartition(workspaceId, "user"),
  );

  const tabs = useWebviewTabs(url);
  const [address, setAddress] = React.useState(url);
  const guestRefs = React.useRef(new Map<string, WebviewElement | null>());

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
      if (!next || next === "about:blank") return;
      const store = useCanvasStore.getState();
      const current = store.document?.nodes.find((each) => each.id === id);
      if (current?.data.kind === "browser" && current.data.url === next) return;
      store.updateNodeData(id, { url: next });
    },
    [id],
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

  const active = tabs.active;
  const headerActions = (
    <>
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
        <div className="flex shrink-0 items-center gap-1.5 p-1.5">
          <Input
            ref={addressRef}
            aria-label={t("browser.address")}
            className="h-6 min-w-0 flex-1 font-mono text-[11px]"
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
          data-no-drag="true"
        >
          {tabs.tabs.map((tab) => (
            <div
              key={tab.id}
              className="absolute inset-0"
              style={tab.id === tabs.activeId ? undefined : { display: "none" }}
            >
              <WebviewGuest
                tab={tab}
                partition={partition}
                hidden={tab.id !== tabs.activeId}
                onPatch={(change) => tabs.patch(tab.id, change)}
                onNavigate={(next) => {
                  if (tab.id === tabs.activeId) persist(next);
                }}
                onOpenTab={(next) => tabs.open(next)}
                onElement={(element) => guestRefs.current.set(tab.id, element)}
              />
            </div>
          ))}
        </div>
      </div>
    </NodeShell>
  );
}
