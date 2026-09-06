import * as React from "react";
import type { BrowserInputEvent } from "@armadra/shared";

import { useT } from "@/app/preferences-store";

import { modifierMask, surfacePoint } from "./geometry";
import { mouseButton } from "./input";

type Send = (
  partial: Partial<BrowserInputEvent> & Pick<BrowserInputEvent, "kind">,
) => void;

/**
 * 位图画面加输入映射（设计 §8）。
 *
 * canvas 的位图尺寸就是页面 viewport，显示尺寸交给 CSS——画布缩放不参与，
 * 页面也就不会因为有人放大画布而 reflow。
 */
export function Frame({
  canvasRef,
  send,
  touch,
}: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  send: Send;
  /** 手机上把指针事件也当触摸发一份：页面的 `touchstart` 才会触发。 */
  touch: boolean;
}) {
  const t = useT();
  const keyboardRef = React.useRef<HTMLTextAreaElement>(null);

  const pointFor = React.useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      return surfacePoint(
        canvas.getBoundingClientRect(),
        { width: canvas.width, height: canvas.height },
        clientX,
        clientY,
      );
    },
    [canvasRef],
  );

  /**
   * 滚轮必须走原生监听：`NodeShell` 在节点体上用原生监听挡掉了滚轮
   * （否则画布会跟着滚），React 的合成事件根本收不到。
   */
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
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
  }, [canvasRef, pointFor, send]);

  return (
    <>
      <canvas
        ref={canvasRef}
        data-slot="browser-surface"
        aria-label={t("browser.surface")}
        role="img"
        className="h-full w-full touch-none"
        onPointerDown={(event) => {
          keyboardRef.current?.focus();
          const point = pointFor(event.clientX, event.clientY);
          if (touch) send({ kind: "touchStart", ...point });
          send({
            kind: "mousePressed",
            ...point,
            button: mouseButton(event.button),
            clickCount: 1,
            modifiers: modifierMask(event),
          });
        }}
        onPointerMove={(event) => {
          const point = pointFor(event.clientX, event.clientY);
          if (touch && event.buttons !== 0)
            send({ kind: "touchMove", ...point });
          send({
            kind: "mouseMoved",
            ...point,
            button: event.buttons === 0 ? "none" : mouseButton(event.button),
            modifiers: modifierMask(event),
          });
        }}
        onPointerUp={(event) => {
          const point = pointFor(event.clientX, event.clientY);
          if (touch) send({ kind: "touchEnd", ...point });
          send({
            kind: "mouseReleased",
            ...point,
            button: mouseButton(event.button),
            clickCount: 1,
            modifiers: modifierMask(event),
          });
        }}
      />
      {/*
        键盘与输入法落在这块透明的文本域上：canvas 不可编辑，`beforeinput` /
        composition 根本不会在它身上触发。它不吃指针事件，焦点由 canvas 的
        pointerdown 转过来（设计 §8）。
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
          // 可打印字符走 `beforeinput`（中文、组合键都在那条路上），这里只发
          // 功能键与带修饰键的组合，免得同一个字符发两次。
          if (event.key.length === 1 && !event.ctrlKey && !event.metaKey)
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
          if (event.key.length === 1 && !event.ctrlKey && !event.metaKey)
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
  );
}
