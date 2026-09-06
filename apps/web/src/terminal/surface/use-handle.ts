import * as React from "react";

import { sessionGateway } from "@/session";
import { useCanvasStore } from "@/store/canvas-store";
import { pasteIntoTerminal, writeClipboard } from "./clipboard";
import { ensureSearch } from "./search";
import type { SurfaceRefs } from "./refs";
import type { ConnectionStatus, TerminalSurfaceHandle } from "./types";

/** 头部按钮、快捷键与移动端工具条通过这个句柄操作终端。 */
export function useSurfaceHandle(
  refs: SurfaceRefs,
  options: {
    ref: React.Ref<TerminalSurfaceHandle> | undefined;
    sessionId: string | undefined;
    ensureSession: (forceNew: boolean) => Promise<void>;
    patch: (next: Partial<ConnectionStatus>) => void;
    setAttempt: React.Dispatch<React.SetStateAction<number>>;
  },
): void {
  const { ref, sessionId, ensureSession, patch, setAttempt } = options;

  React.useImperativeHandle(
    ref,
    () => ({
      find: (query, direction = "next") => {
        if (!query) return;
        // 搜索 addon 到第一次搜索才装（代码分割）；装完立刻执行本次搜索。
        void ensureSearch(refs.terminalRef, refs.searchRef).then((search) => {
          if (!search) return;
          if (direction === "next") search.findNext(query);
          else search.findPrevious(query);
        });
      },
      clearSearch: () => refs.searchRef.current?.clearDecorations(),
      focus: () => refs.terminalRef.current?.focus(),
      terminate: (mode) => {
        const transport = refs.transportRef.current;
        if (transport) {
          transport.terminate(mode);
          return;
        }
        if (sessionId) {
          // Nothing is attached, so the request goes through the gateway
          // rather than down a socket: ending a session is a lifecycle
          // decision and follows whichever side owns the record.
          void sessionGateway.terminate(
            useCanvasStore.getState().workspace?.id ?? "",
            sessionId,
            mode,
          );
        }
      },
      restart: () => {
        refs.freshSessionRef.current = false;
        refs.launchPhaseRef.current = "idle";
        void ensureSession(true);
      },
      recycle: () => {
        if (!sessionId) return;
        void sessionGateway
          .recycle(useCanvasStore.getState().workspace?.id ?? "", sessionId)
          .then(() => setAttempt((value) => value + 1))
          .catch((cause: unknown) => {
            patch({
              error: cause instanceof Error ? cause.message : String(cause),
            });
          });
      },
      writeLine: (line) => refs.transportRef.current?.input(`${line}\r`),
      sendKeys: (data) => {
        if (!data) return;
        refs.transportRef.current?.input(data);
        refs.terminalRef.current?.focus();
      },
      copySelection: () =>
        writeClipboard(refs.terminalRef.current?.getSelection()),
      paste: () => void pasteIntoTerminal(refs.terminalRef.current),
    }),
    [refs, ensureSession, patch, sessionId, setAttempt],
  );
}
