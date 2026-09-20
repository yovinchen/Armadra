import * as React from "react";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  RotateCw,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { openExternal, revealPath } from "@/platform";
import { useCanvasStore } from "@/store/canvas-store";
import { useReactFlow } from "@xyflow/react";
import { useT } from "@/app/preferences-store";
import { useKeybindings } from "@/keybindings";

import { NodeShell } from "../NodeShell";
import type { NodeBodyProps } from "../registry";
import { useBrowserAlerts } from "./alerts";
import { control, isDriven, useDrive } from "./drive";
import { ActivityStatus, LeaseBadge } from "./Lease";
import { useIsGhost } from "./pool";
import { GuestBoundary } from "./GuestBoundary";
import { WebviewGuest } from "./WebviewGuest";
import { WebviewTabs } from "./WebviewTabs";
import {
  downloadToastKind,
  humanBytes,
  parseDownloadNotice,
} from "./downloads";
import { parseForwardedChord, replayChord } from "./keys";
import { browserPartition, searchOrUrl } from "./webview";
import type { WebviewElement } from "./webview";
import { MAX_TABS, useWebviewTabs } from "./webview-tabs";

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
   */
  const [partition] = React.useState(() => browserPartition(workspaceId));

  const tabs = useWebviewTabs(url);
  const [address, setAddress] = React.useState(url);
  /**
   * 重放那一下按键要派在这棵子树上（`./keys`）。用 ref 而不是那个
   * `useState` 的值：`useDrive` 的回调在订阅那一刻被捕获，而这个根是在第一
   * 次渲染之后才挂上的。
   */
  const keyboardRootRef = React.useRef<HTMLElement | null>(null);
  const guestRefs = React.useRef(new Map<string, WebviewElement | null>());

  /* ------------------------------ 驱动通道 ------------------------------- */
  /**
   * 主进程能做的到不了标签，所以标签这三件事是被**请求**的，不是被执行的。
   * 动词回的是自己重测的标签表，所以请求落没落地看得出来，不需要回执。
   */
  /**
   * 请求落不了地就说一声。
   *
   * 三条请求都可能什么也不做——标签数到顶、只剩最后一个、id 指向一个已经关
   * 掉的标签。发请求的人在另一个进程里，看不到这一侧的模型，所以静默在这里
   * 等于「按了没反应」。
   */
  function refuseTab(): void {
    toast.error(t("browser.tabs.failed"));
  }

  /**
   * 一条下载通知 → 一句话（+「在文件夹里显示」）。
   *
   * 只有人自己点下来的下载会到这里；Agent 引起的进暂存目录，出口是
   * `download --accept`（`./downloads` 的注释写了为什么不能混）。
   */
  function announceDownload(raw: unknown): void {
    const notice = parseDownloadNotice(raw);
    if (!notice) return;
    const kind = downloadToastKind(notice);
    if (kind === null) return;
    const size = humanBytes(notice.bytes);
    const name = notice.filename || t("browser.download.unnamed");
    if (kind === "failed") {
      toast.error(t("browser.download.failed", { name }));
      return;
    }
    toast.success(
      size
        ? t("browser.download.doneWithSize", { name, size })
        : t("browser.download.done", { name }),
      notice.path
        ? {
            action: {
              label: t("browser.download.reveal"),
              onClick: () => void revealPath(notice.path),
            },
          }
        : undefined,
    );
  }

  const lease = useDrive(id, {
    onSwitchTab: (tabId) => {
      if (!tabs.tabs.some((tab) => tab.id === tabId)) return refuseTab();
      tabs.select(tabId);
    },
    onOpenTab: (next) => {
      if (tabs.tabs.length >= MAX_TABS) return refuseTab();
      tabs.open(next);
    },
    onCloseTab: (tabId) => {
      if (tabs.tabs.length <= 1 || !tabs.tabs.some((tab) => tab.id === tabId)) {
        return refuseTab();
      }
      tabs.close(tabId);
    },
    /*
      guest 里按下的一个属于 Armadra 的和弦。重放在**节点自己的键盘根**上，
      于是 `when` 上下文就是「焦点在一个浏览器节点里」——那本来就是事实
      （`./keys`）。
    */
    onKey: (raw) => {
      const chord = parseForwardedChord(raw);
      if (chord) replayChord(keyboardRootRef.current, chord);
    },
    /*
      人自己点下来的一个下载，主进程已经存好了。这里只负责说一声，并给出
      「在文件夹里显示」——一个存在了却没人提过的文件，和没存下来差不多。
    */
    onDownload: (raw) => announceDownload(raw),
  });
  const driven = isDriven(lease);
  /**
   * Agent 驱动期间页面弹的对话框与文件请求。人不参与答复（那在主进程），
   * 但必须看得见：一个停在对话框上的页面在画布上和一个正常页面一模一样。
   */
  const alerts = useBrowserAlerts(id, lease);
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

  /** 正在加载就停，否则不做。Esc 的那一半。 */
  function stopLoading() {
    if (!tabs.active.loading) return;
    guestOf(tabs.activeId)?.stop();
  }

  const [keyboardRoot, setKeyboardRoot] = React.useState<HTMLElement | null>(
    null,
  );
  useKeybindings(
    {
      "browser.reload": () => reloadOrStop(),
      "browser.back": () => step(-1),
      "browser.forward": () => step(1),
      /*
        三步，一步都不能少。真机上 ⌘L 从 guest 转发回来时：

        1. `blur()` 那个 `<webview>`。宿主文档的 `activeElement` 就是这个元
           素——焦点在另一个渲染进程的页面里——不先交出来，接下来的 `focus()`
           会被它立刻夺回去（实测：地址栏拿不到焦点，`activeElement` 仍是
           `WEBVIEW`）。
        2. `focus()`，因为 `select()` 在一个没有焦点的 input 上只选中文字。
        3. `select()`，这样直接打字就是换地址，而不是在旧地址中间插字。
      */
      "browser.focusAddress": () => {
        guestOf(tabs.activeId)?.blur();
        addressRef.current?.focus();
        addressRef.current?.select();
      },
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
      // 拒绝与抛出是同一件事的两种形状：租约没换手。两者都要说出来，
      // 否则按钮看起来生效了，而页面仍然在别人手里。
      if (!(await control(id, action))) toast.error(t("browser.lease.failed"));
    } catch (cause) {
      console.error("browser lease request failed", cause);
      toast.error(t("browser.lease.failed"));
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
      <ActivityStatus
        activity={alerts.activity}
        dialog={alerts.dialog}
        chooser={alerts.chooser}
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
        ref={(element) => {
          keyboardRootRef.current = element;
          setKeyboardRoot(element);
        }}
        data-keybinding-scope="browser"
        className="flex h-full w-full flex-col"
        /*
          Esc = 停止加载。不走命令表：`keybindings/commands.ts` 里一条裸 Esc
          会和每一个「按 Esc 关掉」的浮层抢同一个键，而这里只在这棵子树上、
          且只在真的在加载时才吃掉它。guest 里按的 Esc 不会到这儿——那一下
          属于网页（`shell-core/browser/guest-keys.ts` 不转发无修饰键）。
        */
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !tabs.active.loading) return;
          event.preventDefault();
          stopLoading();
        }}
      >
        {/* 工具栏 28px：地址栏 20px + 上下 4px。页面本身才是内容，这条边不该
            比一个真浏览器的还厚（契约 §3.4，2026-09-19）。 */}
        <div className="flex h-[28px] shrink-0 items-center gap-1 px-1">
          {/*
            站点图标。只有一个标签时标签条整条不渲染，于是在这之前 favicon
            在界面上没有任何位置——而「这是哪个站点」是导航期间最先变、也最
            该看见的一条。
          */}
          <span
            aria-hidden="true"
            data-slot="browser-favicon"
            className="grid size-4 shrink-0 place-items-center"
          >
            {active.favicon ? (
              <img
                src={active.favicon}
                alt=""
                className="size-3.5 rounded-[2px] object-contain"
              />
            ) : (
              <Globe className="size-3 text-muted-foreground" />
            )}
          </span>
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
        {/*
          加载条。**不定值**，不是百分比：`<webview>` 给不出已加载字节数，画
          一条会走到 70% 然后停住的假进度条比没有更糟。它只回答「还在加载
          吗」——而那正是 Esc 与刷新/停止按钮此刻是什么意思的依据。
        */}
        <div
          aria-hidden="true"
          data-slot="browser-progress"
          className="h-px shrink-0 overflow-hidden"
        >
          {active.loading && (
            <div className="h-px w-full animate-pulse bg-primary" />
          )}
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
