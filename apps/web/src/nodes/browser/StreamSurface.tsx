import * as React from "react";

import { Badge } from "@/ui/badge";
import { useT } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { browserStreamUrl } from "@/api/sockets";

import { NodeShell } from "../NodeShell";
import type { NodeBodyProps } from "../registry";
import {
  fitFrame,
  modifierBits,
  parseServerMessage,
  reconnectDelay,
  toPageCoordinates,
  viewportFor,
} from "./stream";

/**
 * 服务器壳上的浏览器节点（R6c）。
 *
 * 那边没有窗口，页面住在 core 自己起的 headless Chromium 里，这里画的是它的
 * 画面流：一条 JSON 元数据配一帧 JPEG，输入按帧的尺寸映射回页面坐标发回去。
 * 桌面壳仍然走 `WebviewSurface`——那边页面就在本窗口里，再开一条流只是把同
 * 一个页面画两遍。
 *
 * 一个节点一个观看者：服务端在升级之前就回 409，所以这里看到的「有人在看」
 * 是一个明确的状态，不是连不上。
 */

type Phase = "connecting" | "live" | "occupied" | "unavailable" | "closed";

export function StreamSurface({ id, node, selected }: NodeBodyProps) {
  const t = useT();
  const workspaceId = useCanvasStore((state) => state.workspace?.id);
  const url = node.data.kind === "browser" ? node.data.url : "";

  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const boxRef = React.useRef<HTMLDivElement | null>(null);
  const socketRef = React.useRef<WebSocket | null>(null);
  /** 最近一帧的尺寸，输入映射要用；放 ref 是因为每帧都变，不该重渲染。 */
  const frameRef = React.useRef({ width: 0, height: 0 });
  const [phase, setPhase] = React.useState<Phase>("connecting");
  const [reason, setReason] = React.useState("");

  /* ------------------------------ 连接与重连 ------------------------------ */
  React.useEffect(() => {
    if (workspaceId === undefined) return;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    /** 上一条 JSON 元数据，下一条二进制就是它描述的那一帧。 */
    let pending: { width: number; height: number } | undefined;

    const open = () => {
      if (stopped) return;
      const socket = new WebSocket(browserStreamUrl(workspaceId, id));
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;
      socket.onopen = () => {
        attempt = 0;
        setPhase("live");
        sendViewport(socket, boxRef.current);
      };
      socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          const message = parseServerMessage(event.data);
          if (message?.type === "frame") {
            pending = { width: message.width, height: message.height };
          } else if (message?.type === "error") {
            setPhase(
              message.code === "browser_viewer_present"
                ? "occupied"
                : "unavailable",
            );
            setReason(message.code);
          }
          return;
        }
        if (pending === undefined) return;
        draw(canvasRef.current, event.data as ArrayBuffer, pending);
        frameRef.current = pending;
        pending = undefined;
        setPhase("live");
      };
      socket.onclose = (event) => {
        socketRef.current = null;
        if (stopped) return;
        // 409 在升级之前就发生了，浏览器只给得到一个失败的连接，所以这里靠
        // 服务端先发的那条 error 消息定状态；没有就按断线重连。
        setPhase((current) =>
          current === "occupied" || current === "unavailable"
            ? current
            : "closed",
        );
        if (event.code === 1011) return;
        retry = setTimeout(open, reconnectDelay(attempt));
        attempt += 1;
      };
    };

    open();
    return () => {
      stopped = true;
      if (retry !== undefined) clearTimeout(retry);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [workspaceId, id]);

  /* -------------------------------- 尺寸 --------------------------------- */
  React.useEffect(() => {
    const box = boxRef.current;
    if (box === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const socket = socketRef.current;
      if (socket !== null) sendViewport(socket, boxRef.current);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  /* -------------------------------- 输入 ---------------------------------- */
  const send = React.useCallback((message: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  }, []);

  const pointer = React.useCallback(
    (action: "move" | "down" | "up", event: React.PointerEvent) => {
      const box = boxRef.current;
      if (box === null || frameRef.current.width === 0) return;
      const rect = box.getBoundingClientRect();
      const point = toPageCoordinates(event, rect, frameRef.current);
      send({
        type: "mouse",
        action,
        x: point.x,
        y: point.y,
        button:
          event.button === 2 ? "right" : event.button === 1 ? "middle" : "left",
        clickCount: action === "move" ? 0 : Math.min(event.detail || 1, 3),
        modifiers: modifierBits(event),
      });
    },
    [send],
  );

  const key = React.useCallback(
    (action: "down" | "up", event: React.KeyboardEvent) => {
      // 画布自己的快捷键在上层，所以这里只在节点获得焦点时收键；收到了就不再
      // 冒泡，否则一个 Delete 会同时删掉画布上的节点。
      event.preventDefault();
      event.stopPropagation();
      send({
        type: "key",
        action,
        key: event.key,
        code: event.code,
        keyCode: event.keyCode,
        modifiers: modifierBits(event),
      });
    },
    [send],
  );

  const label =
    phase === "live"
      ? t("browser.stream.live")
      : phase === "occupied"
        ? t("browser.stream.occupied")
        : phase === "unavailable"
          ? t("browser.state.unsupported")
          : t("browser.stream.connecting");

  return (
    <NodeShell
      node={node}
      selected={selected}
      status={{
        tone:
          phase === "live"
            ? "working"
            : phase === "unavailable"
              ? "failed"
              : phase === "occupied"
                ? "attention"
                : "queued",
        label,
      }}
      headerChips={<Badge variant="outline">{t("browser.preview")}</Badge>}
    >
      <div
        ref={boxRef}
        className="relative h-full w-full overflow-hidden bg-muted/30 outline-none"
        tabIndex={0}
        onPointerMove={(event) => pointer("move", event)}
        onPointerDown={(event) => {
          event.currentTarget.focus();
          pointer("down", event);
        }}
        onPointerUp={(event) => pointer("up", event)}
        onWheel={(event) => {
          const box = boxRef.current;
          if (box === null || frameRef.current.width === 0) return;
          const point = toPageCoordinates(
            event,
            box.getBoundingClientRect(),
            frameRef.current,
          );
          send({
            type: "wheel",
            x: point.x,
            y: point.y,
            deltaX: event.deltaX,
            deltaY: event.deltaY,
          });
        }}
        onKeyDown={(event) => key("down", event)}
        onKeyUp={(event) => key("up", event)}
        onPaste={(event) => {
          const text = event.clipboardData.getData("text/plain");
          if (text.length === 0) return;
          event.preventDefault();
          send({ type: "text", text: text.slice(0, 4_096) });
        }}
      >
        <canvas ref={canvasRef} className="h-full w-full" />
        {phase !== "live" && (
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <p className="max-w-[36ch] text-center text-[12px] text-muted-foreground">
              {phase === "occupied"
                ? t("browser.stream.occupiedHint")
                : phase === "unavailable"
                  ? t("browser.stream.unavailableHint")
                  : url.length > 0
                    ? url
                    : t("browser.stream.connecting")}
            </p>
          </div>
        )}
      </div>
    </NodeShell>
  );
}

/** 告诉服务端按多大渲染。节点的框就是视口，不另外留一套尺寸。 */
function sendViewport(socket: WebSocket, box: HTMLDivElement | null): void {
  if (box === null || socket.readyState !== WebSocket.OPEN) return;
  const rect = box.getBoundingClientRect();
  const viewport = viewportFor({ width: rect.width, height: rect.height });
  socket.send(JSON.stringify({ type: "viewport", ...viewport }));
}

/**
 * 画一帧。
 *
 * `createImageBitmap` 而不是 `Image` + `src`：后者要走一次 blob URL，而且解码
 * 在主线程上；前者拿到的就是一张可以直接 `drawImage` 的位图。画布的像素尺寸
 * 跟着帧走，CSS 尺寸跟着节点走，缩放交给 `fitFrame` 算出来的那一个数。
 */
function draw(
  canvas: HTMLCanvasElement | null,
  bytes: ArrayBuffer,
  frame: { width: number; height: number },
): void {
  if (canvas === null || typeof createImageBitmap !== "function") return;
  const blob = new Blob([bytes], { type: "image/jpeg" });
  void createImageBitmap(blob)
    .then((bitmap) => {
      const context = canvas.getContext("2d");
      if (context === null) {
        bitmap.close();
        return;
      }
      const box = { width: canvas.clientWidth, height: canvas.clientHeight };
      const fit = fitFrame(frame, box);
      canvas.width = Math.max(1, Math.round(box.width));
      canvas.height = Math.max(1, Math.round(box.height));
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(
        bitmap,
        fit.offsetX,
        fit.offsetY,
        fit.drawWidth,
        fit.drawHeight,
      );
      bitmap.close();
    })
    .catch(() => undefined);
}
