import * as React from "react";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ExternalLink,
  RotateCw,
} from "lucide-react";
import { toast } from "sonner";
import type {
  BrowserAvailability,
  BrowserInputEvent,
  BrowserSession,
  BrowserSessionState,
  BrowserVisibility,
} from "@armadra/shared";

import { Badge } from "@/ui/badge";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import type { StatusTone } from "@/ui/status-pill";
import { isConflict, runtimeApi } from "@/api/client";
import { onWorkspaceEvent } from "@/api/events";
import { openExternal } from "@/platform";
import { useCanvasStore } from "@/store/canvas-store";
import { useResolvedTheme, useT } from "@/app/preferences-store";
import { NodeShell } from "./NodeShell";
import type { NodeBodyProps } from "./registry";

/** 沿用 v2 的沙箱位；预览节点不允许顶层导航，也不给下载权限。 */
const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups";

/** 只有历史是本地状态：v3 的 browser 数据只存当前 URL。 */
const MAX_HISTORY = 50;

/**
 * 两种模式（B01，editor-browser-design.md §5）。
 *
 * `controlled` 是 Runtime 管理的真实 Chromium，画面按帧传过来、输入回传；
 * `compatibility` 是老的沙箱 iframe——它不计入「受控浏览器已完成」的验收，
 * 但仍然明确保留，因为没有可用 Chromium 的机器上它是唯一能看到页面的路径。
 */
export type BrowserMode = "controlled" | "compatibility";

/** 页面 viewport 的边界；节点可以拖得更小，页面不跟着缩到没法用。 */
const VIEWPORT_MIN = 200;
const VIEWPORT_MAX = 4000;
/** 拖动过程中每一帧都改 viewport 会让页面不停 reflow，所以攒一下再发。 */
const VIEWPORT_DEBOUNCE_MS = 200;

/** 输入合批窗口：一次拖动里的 move 事件合成一条请求。 */
const INPUT_FLUSH_MS = 8;
/** 与 `browserInputRequestSchema` 的上限一致。 */
const MAX_INPUT_BATCH = 64;

/** 订阅续约：提前量与失败重试间隔。 */
const RENEW_MARGIN_MS = 5_000;
const RENEW_MIN_MS = 1_000;
const RENEW_MAX_MS = 60_000;
const RENEW_RETRY_MS = 15_000;

/** CDP 的修饰键位（Alt / Ctrl / Meta / Shift）。 */
const MOD_ALT = 1;
const MOD_CTRL = 2;
const MOD_META = 4;
const MOD_SHIFT = 8;

const STATE_TONE: Record<BrowserSessionState, StatusTone> = {
  starting: "queued",
  ready: "idle",
  disconnected: "failed",
  terminated: "paused",
  unsupported: "failed",
};

/** 有本地化文案的不可用原因；其余一律走 `unknown` 那条，不显示裸 code。 */
const KNOWN_REASONS = ["chrome_not_found", "launch_failed", "cdp_closed"];

export function unavailableKey(reasonCode: string): string {
  return KNOWN_REASONS.includes(reasonCode)
    ? `browser.unavailable.${reasonCode}`
    : "browser.unavailable.unknown";
}

export function normalizeUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  return `https://${value}`;
}

/** 节点尺寸 → 页面 viewport：取整并夹在可用范围内。 */
export function clampViewport(value: number): number {
  if (!Number.isFinite(value)) return VIEWPORT_MIN;
  return Math.min(VIEWPORT_MAX, Math.max(VIEWPORT_MIN, Math.round(value)));
}

/** 续约时机：过期前 5 秒，夹在 1s–60s；时间戳读不出来就按 30s 重试。 */
export function renewDelay(expiresAt: string, now = Date.now()): number {
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return 30_000;
  return Math.min(
    RENEW_MAX_MS,
    Math.max(RENEW_MIN_MS, at - now - RENEW_MARGIN_MS),
  );
}

/**
 * 显示框坐标 → CSS viewport 坐标（设计 §8）。
 *
 * canvas 的位图尺寸就是页面 viewport，CSS 尺寸是画布上被缩放后的样子，
 * 所以除以两者的比即可；画布缩放永远不写进页面 viewport。
 */
export function surfacePoint(
  rect: { left: number; top: number; width: number; height: number },
  bitmap: { width: number; height: number },
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const scaleX = rect.width > 0 ? bitmap.width / rect.width : 1;
  const scaleY = rect.height > 0 ? bitmap.height / rect.height : 1;
  return {
    x: Math.round((clientX - rect.left) * scaleX),
    y: Math.round((clientY - rect.top) * scaleY),
  };
}

export function modifierMask(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (
    (event.altKey ? MOD_ALT : 0) |
    (event.ctrlKey ? MOD_CTRL : 0) |
    (event.metaKey ? MOD_META : 0) |
    (event.shiftKey ? MOD_SHIFT : 0)
  );
}

const MOUSE_BUTTONS = ["left", "middle", "right"] as const;

function mouseButton(button: number): BrowserInputEvent["button"] {
  return MOUSE_BUTTONS[button] ?? "none";
}

/** 补齐一条输入事件的默认值，调用方只写它关心的字段。 */
function inputEvent(
  partial: Partial<BrowserInputEvent> & Pick<BrowserInputEvent, "kind">,
): BrowserInputEvent {
  return {
    x: 0,
    y: 0,
    deltaX: 0,
    deltaY: 0,
    button: "none",
    clickCount: 0,
    modifiers: 0,
    key: "",
    code: "",
    text: "",
    ...partial,
  };
}

/* -------------------------------------------------------------------------- */
/* 浏览器节点                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 浏览器节点（§3.4 / B01）。
 *
 * 受控模式下节点只是一个「显示 + 输入」的终端：会话由 Runtime 持有，节点
 * 卸载只退订画面，不结束会话（设计 §9），Agent 可以继续操作同一个页面。
 */
export function BrowserNode({ id, node, selected }: NodeBodyProps) {
  const t = useT();
  /**
   * 跨域 iframe 的 `prefers-color-scheme` 取自 iframe 元素自己的 `color-scheme`
   * （HTML 规范，Chrome 98+ / WebKit 均已实现），所以把应用主题写上去，
   * Google 这类跟随系统深浅色的页面就会和画布一个色（2026-09-04 用户要求
   * 浏览器默认黑色）。页面自己固定亮色的没法管。
   */
  const theme = useResolvedTheme();
  const workspaceId = useCanvasStore((state) => state.workspace?.id);
  const url = node.data.kind === "browser" ? node.data.url : "";

  const [address, setAddress] = React.useState(url);
  const [history, setHistory] = React.useState<string[]>(url ? [url] : []);
  const [index, setIndex] = React.useState(url ? 0 : -1);
  const [reloads, setReloads] = React.useState(0);

  const [availability, setAvailability] =
    React.useState<BrowserAvailability | null>(null);
  /** 用户显式选过的模式；没选过就跟着可用性走。 */
  const [chosenMode, setChosenMode] = React.useState<BrowserMode | null>(null);
  const [session, setSession] = React.useState<BrowserSession | null>(null);

  React.useEffect(() => setAddress(url), [url]);

  /* ------------------------------- 可用性 ------------------------------- */
  React.useEffect(() => {
    let cancelled = false;
    // 取不到可用性（没有工作空间、Runtime 不在）就当作没有浏览器：
    // 兼容模式至少还能把页面显示出来。
    const unavailable = () => {
      if (!cancelled)
        setAvailability({
          available: false,
          executable: "",
          source: "none",
          reasonCode: "unavailable",
          searched: [],
        });
    };
    if (!workspaceId) {
      unavailable();
      return () => {
        cancelled = true;
      };
    }
    const controller = new AbortController();
    runtimeApi
      .browserAvailability(workspaceId, controller.signal)
      .then((result) => {
        if (!cancelled) setAvailability(result);
      })
      .catch(unavailable);
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [workspaceId]);

  const mode: BrowserMode | null =
    chosenMode ??
    (availability === null
      ? null
      : availability.available
        ? "controlled"
        : "compatibility");
  const controlled = mode === "controlled";
  const supported = availability?.available === true;

  /* ------------------------------ 会话生命周期 --------------------------- */
  const sessionRef = React.useRef<BrowserSession | null>(null);
  sessionRef.current = session;
  /** 最新一帧；输入要带上它的 epoch 与序号。 */
  const frameRef = React.useRef<{
    frameSeq: number;
    navigationEpoch: number;
  } | null>(null);
  /** 被 409 拒过的 epoch：在收到新 epoch 的帧之前不再发输入。 */
  const staleEpochRef = React.useRef<number | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const surfaceRef = React.useRef<HTMLDivElement>(null);
  const keyboardRef = React.useRef<HTMLTextAreaElement>(null);
  const viewportRef = React.useRef({
    width: clampViewport(node.size?.width ?? 640),
    height: clampViewport(node.size?.height ?? 440),
  });
  const urlRef = React.useRef(url);
  urlRef.current = url;

  React.useEffect(() => {
    if (!controlled || !supported || !workspaceId) {
      setSession(null);
      return;
    }
    let cancelled = false;
    runtimeApi
      .createBrowserSession(workspaceId, {
        nodeId: id,
        ...(urlRef.current ? { url: urlRef.current } : {}),
        viewport: { ...viewportRef.current, deviceScaleFactor: 1 },
      })
      .then((created) => {
        if (!cancelled) setSession(created);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        toast.error(
          cause instanceof Error ? cause.message : t("browser.sessionFailed"),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [controlled, supported, workspaceId, id, t]);

  /* 会话状态推送：导航、标题、可前进/后退、崩溃都从这里回来。 */
  React.useEffect(
    () =>
      onWorkspaceEvent("browser.session", (event) => {
        if (event.session.sessionId !== sessionRef.current?.sessionId) return;
        setSession(event.session);
      }),
    [],
  );

  /* --------------------------------- 画面 -------------------------------- */
  React.useEffect(
    () =>
      onWorkspaceEvent("browser.frame", (event) => {
        if (event.sessionId !== sessionRef.current?.sessionId) return;
        frameRef.current = {
          frameSeq: event.frameSeq,
          navigationEpoch: event.navigationEpoch,
        };
        if (
          staleEpochRef.current !== null &&
          event.navigationEpoch !== staleEpochRef.current
        ) {
          staleEpochRef.current = null;
        }
        const canvas = canvasRef.current;
        if (!canvas) return;
        // 位图尺寸就是 CSS viewport；显示尺寸交给 CSS，画布缩放不参与。
        if (canvas.width !== event.viewportWidth)
          canvas.width = event.viewportWidth;
        if (canvas.height !== event.viewportHeight)
          canvas.height = event.viewportHeight;
        const image = new Image();
        image.onload = () => {
          const context = canvas.getContext("2d");
          if (!context) return;
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
        };
        image.src = `data:image/jpeg;base64,${event.data}`;
      }),
    [],
  );

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
    : selected
      ? "focused"
      : "visible";
  const visibilityRef = React.useRef(visibility);
  visibilityRef.current = visibility;

  const sessionId = controlled ? (session?.sessionId ?? null) : null;
  const subscriptionRef = React.useRef<string | null>(null);
  const renewRef = React.useRef<(() => void) | null>(null);

  React.useEffect(() => {
    if (!workspaceId || !sessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const renew = async () => {
      if (cancelled) return;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      try {
        const held = subscriptionRef.current;
        const subscription = await runtimeApi.browserSubscribe(
          workspaceId,
          sessionId,
          {
            ...(held ? { subscriptionId: held } : {}),
            visibility: visibilityRef.current,
          },
        );
        if (cancelled) {
          // 已经卸载：把刚拿到的订阅还回去，别让 Runtime 白推帧。
          void runtimeApi
            .browserUnsubscribe(
              workspaceId,
              sessionId,
              subscription.subscriptionId,
            )
            .catch(() => {});
          return;
        }
        subscriptionRef.current = subscription.subscriptionId;
        timer = setTimeout(
          () => void renew(),
          renewDelay(subscription.expiresAt),
        );
      } catch {
        if (!cancelled) timer = setTimeout(() => void renew(), RENEW_RETRY_MS);
      }
    };

    renewRef.current = () => void renew();
    void renew();

    return () => {
      cancelled = true;
      renewRef.current = null;
      if (timer) clearTimeout(timer);
      const held = subscriptionRef.current;
      subscriptionRef.current = null;
      // 只退订，不结束会话：关掉节点不该杀掉页面（设计 §9）。
      if (held)
        void runtimeApi
          .browserUnsubscribe(workspaceId, sessionId, held)
          .catch(() => {});
    };
  }, [workspaceId, sessionId]);

  /* 可见性变了立刻续一次约，让 Runtime 换帧率——挂载那次由上面的效果发。 */
  const mountedRef = React.useRef(false);
  React.useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    renewRef.current?.();
  }, [visibility]);

  /* -------------------------------- 输入转发 ----------------------------- */
  const queueRef = React.useRef<BrowserInputEvent[]>([]);
  const flushTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const flush = React.useCallback(() => {
    flushTimerRef.current = null;
    const events = queueRef.current;
    queueRef.current = [];
    const current = sessionRef.current;
    if (!workspaceId || !current || events.length === 0) return;
    const frame = frameRef.current;
    const navigationEpoch = frame?.navigationEpoch ?? current.navigationEpoch;
    for (let start = 0; start < events.length; start += MAX_INPUT_BATCH) {
      void runtimeApi
        .browserInput(workspaceId, current.sessionId, {
          navigationEpoch,
          ...(frame ? { frameSeq: frame.frameSeq } : {}),
          events: events.slice(start, start + MAX_INPUT_BATCH),
        })
        .catch((cause: unknown) => {
          // 409 = 这批输入属于上一页。丢掉并等新帧，重发只会点到别处。
          if (isConflict(cause)) {
            staleEpochRef.current = navigationEpoch;
            queueRef.current = [];
          }
        });
    }
  }, [workspaceId]);

  const send = React.useCallback(
    (partial: Partial<BrowserInputEvent> & Pick<BrowserInputEvent, "kind">) => {
      if (!sessionRef.current) return;
      if (
        staleEpochRef.current !== null &&
        (frameRef.current?.navigationEpoch ?? null) === staleEpochRef.current
      ) {
        return;
      }
      queueRef.current.push(inputEvent(partial));
      if (flushTimerRef.current === null) {
        flushTimerRef.current = setTimeout(flush, INPUT_FLUSH_MS);
      }
    },
    [flush],
  );

  React.useEffect(
    () => () => {
      if (flushTimerRef.current !== null) clearTimeout(flushTimerRef.current);
    },
    [],
  );

  const pointFor = React.useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    return surfacePoint(
      canvas.getBoundingClientRect(),
      { width: canvas.width, height: canvas.height },
      clientX,
      clientY,
    );
  }, []);

  /**
   * 滚轮必须走原生监听：NodeShell 在节点体上用原生监听挡掉了滚轮
   * （否则画布会跟着滚），React 的合成事件根本收不到。
   */
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !controlled) return;
    const onWheel = (event: WheelEvent) => {
      const point = pointFor(event.clientX, event.clientY);
      send({
        kind: "wheel",
        ...point,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        modifiers: modifierMask(event),
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: true });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [controlled, pointFor, send, sessionId]);

  /* ------------------------------ 尺寸 → viewport ------------------------ */
  React.useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || !controlled || !workspaceId || !sessionId) return;
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
  }, [controlled, workspaceId, sessionId]);

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

  /* --------------------------------- 渲染 -------------------------------- */
  const unsupportedPanel =
    controlled && availability && !availability.available;
  const canNavigate = controlled ? Boolean(session) : true;

  const modeToggle = (
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
  );

  /**
   * 不可用时**一个受控按钮都不给**：按不动的占位按钮只会让人反复去点，
   * 该做的是把原因和找过的路径说清楚（设计 §5）。
   */
  const headerActions = (
    <>
      {modeToggle}
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
        controlled ? null : (
          <Badge variant="outline">{t("browser.preview")}</Badge>
        )
      }
      headerActions={headerActions}
    >
      <div className="flex h-full w-full flex-col">
        {!unsupportedPanel && (
          <div className="shrink-0 p-1.5">
            <Input
              aria-label={t("browser.address")}
              className="h-6 font-mono text-[11px]"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") commit(address);
              }}
            />
          </div>
        )}
        <div
          ref={surfaceRef}
          className="relative min-h-0 flex-1 bg-[var(--browser-bg)]"
        >
          {unsupportedPanel && availability && (
            <UnsupportedPanel availability={availability} />
          )}

          {controlled && !unsupportedPanel && (
            <>
              <canvas
                ref={canvasRef}
                data-slot="browser-surface"
                aria-label={t("browser.surface")}
                role="img"
                className="h-full w-full"
                onPointerDown={(event) => {
                  keyboardRef.current?.focus();
                  send({
                    kind: "mousePressed",
                    ...pointFor(event.clientX, event.clientY),
                    button: mouseButton(event.button),
                    clickCount: 1,
                    modifiers: modifierMask(event),
                  });
                }}
                onPointerMove={(event) => {
                  send({
                    kind: "mouseMoved",
                    ...pointFor(event.clientX, event.clientY),
                    button:
                      event.buttons === 0 ? "none" : mouseButton(event.button),
                    modifiers: modifierMask(event),
                  });
                }}
                onPointerUp={(event) => {
                  send({
                    kind: "mouseReleased",
                    ...pointFor(event.clientX, event.clientY),
                    button: mouseButton(event.button),
                    clickCount: 1,
                    modifiers: modifierMask(event),
                  });
                }}
              />
              {/*
                键盘与输入法落在这块透明的文本域上：canvas 不可编辑，
                `beforeinput` / composition 根本不会在它身上触发。它不吃指针
                事件，焦点由 canvas 的 pointerdown 转过来（设计 §8）。
              */}
              <textarea
                ref={keyboardRef}
                aria-label={t("browser.keyboard")}
                className="absolute inset-0 h-full w-full resize-none opacity-0 outline-none"
                style={{ pointerEvents: "none" }}
                value=""
                onChange={() => {}}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  // 可打印字符走 `beforeinput`（中文、组合键都在那条路上），
                  // 这里只发功能键与带修饰键的组合，免得同一个字符发两次。
                  if (
                    event.key.length === 1 &&
                    !event.ctrlKey &&
                    !event.metaKey
                  )
                    return;
                  event.preventDefault();
                  send({
                    kind: "keyDown",
                    key: event.key,
                    code: event.code,
                    modifiers: modifierMask(event),
                  });
                }}
                onKeyUp={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (
                    event.key.length === 1 &&
                    !event.ctrlKey &&
                    !event.metaKey
                  )
                    return;
                  send({
                    kind: "keyUp",
                    key: event.key,
                    code: event.code,
                    modifiers: modifierMask(event),
                  });
                }}
                onBeforeInput={(event) => {
                  const data = (event.nativeEvent as InputEvent).data;
                  if (!data) return;
                  event.preventDefault();
                  send({ kind: "text", text: data });
                }}
                onCompositionEnd={(event) => {
                  if (!event.data) return;
                  send({ kind: "text", text: event.data });
                }}
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

/**
 * 没有可用 Chromium 时的说明面板（设计 §5）。
 *
 * 只说两件事：为什么不能用，以及找过哪些路径——后者是用户自己去装或者
 * 指一个可执行文件时唯一有用的信息。这里不放任何按钮。
 */
function UnsupportedPanel({
  availability,
}: {
  availability: BrowserAvailability;
}) {
  const t = useT();
  return (
    <div className="flex h-full w-full flex-col gap-2 overflow-auto p-3 text-xs">
      <p className="text-foreground">
        {t(unavailableKey(availability.reasonCode))}
      </p>
      <p className="text-muted-foreground">{t("browser.searched")}</p>
      {availability.searched.length > 0 ? (
        <ul className="font-mono text-[11px] text-muted-foreground">
          {availability.searched.map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">{t("browser.searchedNone")}</p>
      )}
    </div>
  );
}
