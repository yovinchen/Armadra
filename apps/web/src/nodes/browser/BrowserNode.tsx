import * as React from "react";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ExternalLink,
  RotateCw,
} from "lucide-react";
import { toast } from "sonner";
import type { BrowserSessionState, BrowserVisibility } from "@armadra/shared";

import { Badge } from "@/ui/badge";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import type { StatusTone } from "@/ui/status-pill";
import { runtimeApi } from "@/api/client";
import { openExternal } from "@/platform";
import { useCanvasStore } from "@/store/canvas-store";
import { useResolvedTheme, useT } from "@/app/preferences-store";
import { useKeybindings } from "@/keybindings";

import { NodeShell } from "../NodeShell";
import type { NodeBodyProps } from "../registry";
import { Frame } from "./Frame";
import { ActivityLine, LeaseBadge } from "./Lease";
import { UnsupportedPanel } from "./Managed";
import { DialogPrompt, FileChooserPrompt } from "./Prompts";
import { TabStrip, useTabs } from "./TabStrip";
import {
  MAX_HISTORY,
  VIEWPORT_DEBOUNCE_MS,
  clampViewport,
  normalizeUrl,
} from "./geometry";
import {
  useAvailability,
  useLease,
  usePrompts,
  useSession,
  useStream,
} from "./session";

/** 沿用 v2 的沙箱位；预览节点不允许顶层导航，也不给下载权限。 */
const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups";

/**
 * 两种模式（B01，editor-browser-design.md §5）。
 *
 * `controlled` 是 Runtime 管理的真实 Chromium，画面按帧传过来、输入回传；
 * `compatibility` 是老的沙箱 iframe——它不计入「受控浏览器已完成」的验收，
 * 但仍然明确保留，因为没有可用 Chromium 的机器上它是唯一能看到页面的路径。
 */
export type BrowserMode = "controlled" | "compatibility";

const STATE_TONE: Record<BrowserSessionState, StatusTone> = {
  starting: "queued",
  ready: "idle",
  disconnected: "failed",
  terminated: "paused",
  unsupported: "failed",
};

/**
 * 浏览器节点（§3.4 / B01）。
 *
 * 受控模式下节点只是一个「显示 + 输入」的终端：会话由 Runtime 持有，节点
 * 卸载只退订画面，不结束会话（设计 §9），Agent 可以继续操作同一个页面。
 * 这个文件只做外壳——画面在 `Frame`，租约在 `Lease`，帧流在 `stream.ts`。
 */
export function BrowserNode({ id, node, selected, focused }: NodeBodyProps) {
  const t = useT();
  /**
   * 跨域 iframe 的 `prefers-color-scheme` 取自 iframe 元素自己的
   * `color-scheme`，所以把应用主题写上去，跟随系统深浅色的页面就会和画布
   * 一个色。页面自己固定亮色的没法管。
   */
  const theme = useResolvedTheme();
  const workspaceId = useCanvasStore((state) => state.workspace?.id);
  // 文件选择器要把绝对路径换算成工作空间相对路径，所以它需要根目录；远端
  // 工作空间的根在**那台**主机上，本机选择器选不到，界面据此换一条路。
  const workspaceRoot = useCanvasStore((state) => state.workspace?.rootPath);
  const remoteWorkspace = useCanvasStore(
    (state) => (state.workspace?.executionHostId ?? "") !== "",
  );
  const url = node.data.kind === "browser" ? node.data.url : "";

  const [address, setAddress] = React.useState(url);
  const [history, setHistory] = React.useState<string[]>(url ? [url] : []);
  const [index, setIndex] = React.useState(url ? 0 : -1);
  const [reloads, setReloads] = React.useState(0);
  /** 用户显式选过的模式；没选过就跟着可用性走。 */
  const [chosenMode, setChosenMode] = React.useState<BrowserMode | null>(null);

  React.useEffect(() => setAddress(url), [url]);

  const [availability, recheck] = useAvailability(workspaceId);
  const mode: BrowserMode | null =
    chosenMode ??
    (availability === null
      ? null
      : availability.available
        ? "controlled"
        : "compatibility");
  const controlled = mode === "controlled";
  const supported = availability?.available === true;

  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const surfaceRef = React.useRef<HTMLDivElement>(null);
  const viewportRef = React.useRef({
    width: clampViewport(node.size?.width ?? 640),
    height: clampViewport(node.size?.height ?? 440),
  });

  const [session, setSession] = useSession(
    workspaceId,
    id,
    controlled && supported,
    url,
    viewportRef.current,
  );
  const lease = useLease(workspaceId, session);

  /* ------------------------------- 订阅画面 ------------------------------ */
  const [documentHidden, setDocumentHidden] = React.useState(
    typeof document !== "undefined" && document.visibilityState === "hidden",
  );
  React.useEffect(() => {
    if (typeof document === "undefined") return;
    const sync = () => setDocumentHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  const visibility: BrowserVisibility = documentHidden
    ? "hidden"
    : selected || focused
      ? "focused"
      : "visible";

  const stream = useStream(
    workspaceId,
    controlled ? session : null,
    visibility,
    canvasRef,
    lease.lease?.generation,
  );

  /* --------------------- 标签条、对话框与文件选择器 --------------------- */
  const tabs = useTabs(
    workspaceId,
    controlled ? (session?.sessionId ?? null) : null,
  );
  const prompts = usePrompts(
    controlled ? (session?.sessionId ?? null) : null,
    session?.pendingDialog,
    session?.pendingFileChooser,
  );

  /* ------------------------------ 尺寸 → viewport ------------------------ */
  const sessionId = controlled ? (session?.sessionId ?? null) : null;
  React.useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || !workspaceId || !sessionId) return;
    if (typeof ResizeObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      const next = {
        width: clampViewport(box.width),
        height: clampViewport(box.height),
      };
      if (
        next.width === viewportRef.current.width &&
        next.height === viewportRef.current.height
      )
        return;
      viewportRef.current = next;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void runtimeApi
          .browserViewport(workspaceId, sessionId, {
            ...next,
            deviceScaleFactor: 1,
          })
          .then((updated) => setSession(updated))
          .catch(() => {});
      }, VIEWPORT_DEBOUNCE_MS);
    });
    observer.observe(surface);
    return () => {
      if (timer) clearTimeout(timer);
      observer.disconnect();
    };
  }, [workspaceId, sessionId, setSession]);

  /* -------------------------------- 导航 --------------------------------- */
  function commit(next: string) {
    const target = normalizeUrl(next);
    if (!target) return;
    if (controlled && workspaceId && session) {
      void runtimeApi
        .browserNavigate(workspaceId, session.sessionId, {
          action: "goto",
          url: target,
        })
        .then((updated) => setSession(updated))
        .catch(() => {});
      useCanvasStore.getState().updateNodeData(id, { url: target });
      return;
    }
    setHistory((current) => {
      const kept = current.slice(0, index + 1);
      const merged = [...kept, target].slice(-MAX_HISTORY);
      setIndex(merged.length - 1);
      return merged;
    });
    useCanvasStore.getState().updateNodeData(id, { url: target });
  }

  function step(delta: number) {
    if (controlled && workspaceId && session) {
      void runtimeApi
        .browserNavigate(workspaceId, session.sessionId, {
          action: delta < 0 ? "back" : "forward",
        })
        .then((updated) => setSession(updated))
        .catch(() => {});
      return;
    }
    const next = index + delta;
    const target = history[next];
    if (!target) return;
    setIndex(next);
    useCanvasStore.getState().updateNodeData(id, { url: target });
  }

  function reload() {
    if (controlled && workspaceId && session) {
      void runtimeApi
        .browserNavigate(workspaceId, session.sessionId, { action: "reload" })
        .then((updated) => setSession(updated))
        .catch(() => {});
      return;
    }
    setReloads((value) => value + 1);
  }

  function capture() {
    if (!workspaceId || !session) return;
    void runtimeApi
      .browserCapture(workspaceId, session.sessionId, {})
      .then((shot) => toast(t("browser.captureSaved", { path: shot.path })))
      .catch((cause: unknown) =>
        toast.error(
          cause instanceof Error ? cause.message : t("browser.captureFailed"),
        ),
      );
  }

  /* ------------------------------- 节点内键位 ------------------------------ */

  // `browser` 作用域的四条。监听器装在这个节点自己的根元素上，`when` 再挡
  // 一道，所以同时开着的几个浏览器节点里只有键盘所在的那个会响应。
  const [keyboardRoot, setKeyboardRoot] = React.useState<HTMLElement | null>(
    null,
  );
  const addressRef = React.useRef<HTMLInputElement | null>(null);
  useKeybindings(
    {
      "browser.reload": () => reload(),
      "browser.back": () => step(-1),
      "browser.forward": () => step(1),
      "browser.focusAddress": () => addressRef.current?.select(),
    },
    { scopes: ["browser"], target: keyboardRoot },
  );

  /* --------------------------------- 渲染 -------------------------------- */
  const unsupportedPanel =
    controlled && availability && !availability.available;
  const canNavigate = controlled ? Boolean(session) : true;

  /**
   * 不可用时**一个受控按钮都不给**：按不动的占位按钮只会让人反复去点，
   * 该做的是把原因和找过的路径说清楚（设计 §5）。
   */
  const headerActions = (
    <>
      <ToggleGroup
        type="single"
        size="sm"
        spacing={0}
        variant="outline"
        value={mode ?? ""}
        onValueChange={(value) => {
          if (value === "controlled" || value === "compatibility")
            setChosenMode(value);
        }}
        aria-label={t("browser.mode")}
        data-no-drag="true"
      >
        <ToggleGroupItem value="controlled" className="h-[22px] text-[11px]">
          {t("browser.modeControlled")}
        </ToggleGroupItem>
        <ToggleGroupItem value="compatibility" className="h-[22px] text-[11px]">
          {t("browser.modeCompatibility")}
        </ToggleGroupItem>
      </ToggleGroup>
      {!unsupportedPanel && (
        <>
          <IconButton
            label={t("browser.back")}
            disabled={
              controlled ? !canNavigate || !session?.canGoBack : index <= 0
            }
            onClick={() => step(-1)}
          >
            <ArrowLeft />
          </IconButton>
          <IconButton
            label={t("browser.forward")}
            disabled={
              controlled
                ? !canNavigate || !session?.canGoForward
                : index < 0 || index >= history.length - 1
            }
            onClick={() => step(1)}
          >
            <ArrowRight />
          </IconButton>
          <IconButton
            label={t("browser.reload")}
            disabled={!canNavigate}
            onClick={reload}
          >
            <RotateCw />
          </IconButton>
          {controlled && (
            <IconButton
              label={t("browser.screenshot")}
              disabled={!session}
              onClick={capture}
            >
              <Camera />
            </IconButton>
          )}
          <IconButton
            label={t("browser.openExternal")}
            disabled={!url}
            onClick={() => void openExternal(url)}
          >
            <ExternalLink />
          </IconButton>
        </>
      )}
    </>
  );

  const status = controlled
    ? unsupportedPanel
      ? { tone: STATE_TONE.unsupported, label: t("browser.state.unsupported") }
      : session
        ? {
            tone: STATE_TONE[session.state],
            label: t(`browser.state.${session.state}`),
          }
        : { tone: STATE_TONE.starting, label: t("browser.state.starting") }
    : undefined;

  return (
    <NodeShell
      node={node}
      selected={selected}
      {...(status ? { status } : {})}
      headerChips={
        controlled ? (
          session && !unsupportedPanel ? (
            <LeaseBadge
              lease={lease.lease}
              deviceId={lease.deviceId}
              busy={lease.busy}
              onTakeover={lease.takeover}
              onHandback={lease.handback}
            />
          ) : null
        ) : (
          <Badge variant="outline">{t("browser.preview")}</Badge>
        )
      }
      headerActions={headerActions}
    >
      {/*
       * `data-keybinding-scope` 是 `when: "browserFocus"` 的依据：节点的画面
       * 是一个把按键原样转发给远端会话的 textarea，所以这几条键必须限死在这
       * 棵子树里——在别处截走 ⌘R / ⌘L 就是把浏览器的键从整个应用里偷走。
       */}
      <div
        ref={setKeyboardRoot}
        data-keybinding-scope="browser"
        className="flex h-full w-full flex-col"
      >
        {!unsupportedPanel && (
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
            {controlled && session && (
              <>
                <ActivityLine activity={lease.activity} />
                {!stream.connected && (
                  <Badge variant="outline" data-slot="browser-stream-state">
                    {t("browser.stream.reconnecting")}
                  </Badge>
                )}
              </>
            )}
          </div>
        )}
        {controlled && !unsupportedPanel && (
          <TabStrip
            workspaceId={workspaceId}
            sessionId={session?.sessionId ?? null}
            tabs={tabs}
            newTabUrl={url}
          />
        )}
        <div
          ref={surfaceRef}
          className="relative min-h-0 flex-1 bg-[var(--browser-bg)]"
        >
          {unsupportedPanel && availability && (
            <UnsupportedPanel
              availability={availability}
              onInstalled={recheck}
            />
          )}

          {controlled && !unsupportedPanel && (
            <Frame
              canvasRef={canvasRef}
              send={stream.send}
              touch={Boolean(focused)}
            />
          )}

          {/*
            页面停在那里等一个人的两种情况。它们是弹层而不是节点里的一条
            横幅：对话框没答复之前这个标签上的输入全被拒，一条容易被忽略
            的横幅换来的是「我的点击没反应」（§2.3 / §2.4）。
          */}
          {controlled && (
            <>
              <DialogPrompt
                workspaceId={workspaceId}
                sessionId={session?.sessionId ?? null}
                dialog={prompts.dialog}
                onAnswered={prompts.clearDialog}
              />
              <FileChooserPrompt
                workspaceId={workspaceId}
                workspaceRoot={workspaceRoot ?? ""}
                remote={remoteWorkspace}
                sessionId={session?.sessionId ?? null}
                chooser={prompts.chooser}
                onAnswered={prompts.clearChooser}
              />
            </>
          )}

          {mode === "compatibility" && url && (
            <iframe
              key={`${url}#${reloads}`}
              src={url}
              title={node.title}
              sandbox={SANDBOX}
              referrerPolicy="no-referrer"
              className="h-full w-full border-0"
              style={{ colorScheme: theme }}
            />
          )}
        </div>
      </div>
    </NodeShell>
  );
}
