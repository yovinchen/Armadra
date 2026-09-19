import * as React from "react";

import { terminalWebSocketUrl } from "@/api/client";
import { useCanvasStore } from "@/store/canvas-store";
import { bufferOffscreenChunk, drainOffscreenBuffer } from "../render-state";
import { createTerminalTransport } from "../transport";
import type { SurfaceRefs } from "./refs";
import type { ConnectionStatus } from "./types";

/**
 * 传输的生命周期：连接前清屏，`hello` 之后对齐尺寸并决定要不要敲启动行，
 * `stale` / 意外断线按退避重连。节点数据只经 `dataRef` 读最新值，不进依赖数组。
 */
export function useTerminalTransport(
  refs: SurfaceRefs,
  options: {
    nodeId: string;
    sessionId: string | undefined;
    detached: boolean;
    attempt: number;
    setAttempt: React.Dispatch<React.SetStateAction<number>>;
    patch: (next: Partial<ConnectionStatus>) => void;
    refit: () => void;
    flushOutput: () => void;
    armLaunch: () => void;
    noteOutput: () => void;
    clearLaunchTimers: () => void;
  },
): void {
  const {
    nodeId,
    sessionId,
    detached,
    attempt,
    setAttempt,
    patch,
    refit,
    flushOutput,
    armLaunch,
    noteOutput,
    clearLaunchTimers,
  } = options;

  React.useEffect(() => {
    if (!sessionId || detached) return;
    const terminal = refs.terminalRef.current;
    if (!terminal) return;

    let disposed = false;
    // 清屏发生在**连接之前**：tmux 后端不发 snapshot，attach 后的第一波重绘
    // （?1049h、鼠标追踪、DA/OSC 查询）必须原样落到一块干净的屏上；
    // 在 hello 之后再清会把这波重绘抹掉。
    // 上一条连接攒下、还没灌完的字节属于被清掉的那块屏，一起丢。
    drainOffscreenBuffer(refs.bufferRef.current);
    terminal.reset();

    /**
     * 写一段输出。
     *
     * 全速渲染时走原来的直写路径，一个字符都不多绕。离屏时攒起来（设计 §7.1：
     * 「不能因 `display:none` 仍让几十个终端每帧 fit 和重绘」）。缓冲非空时
     * 即使已经回到全速也要先入队再整体灌——PTY 的字节流里半个转义序列都不能
     * 错位，插队会把画面弄坏。
     */
    const writeChunk = (chunk: string) => {
      if (
        refs.writeThroughRef.current &&
        refs.bufferRef.current.chunks.length === 0
      ) {
        terminal.write(chunk);
        return;
      }
      bufferOffscreenChunk(refs.bufferRef.current, chunk);
      if (refs.writeThroughRef.current) flushOutput();
    };
    const log = refs.inputLogRef.current!;
    const transport = createTerminalTransport(
      terminalWebSocketUrl(sessionId, log.writerId),
      {
        onHello: (hello) => {
          if (disposed) return;
          refs.backendRef.current = hello.backend;
          refs.sessionIdRef.current = hello.sessionId;
          refs.reconnectDelayRef.current = 1000;
          patch({
            connection: hello.alive ? "live" : "exited",
            error: null,
            binding: hello.alive
              ? { sessionId: hello.sessionId, generation: hello.generation }
              : null,
          });
          // attach 后必须至少发一次 resize：后端按 80×24 建的 pty，
          // 之后 `refit()` 只在真的变了才发（§18.2 规则 2）。
          refit();
          transport.resize(terminal.cols, terminal.rows);

          const store = useCanvasStore.getState();
          const node = store.document?.nodes.find((item) => item.id === nodeId);
          const nodeData =
            node && node.data.kind === "terminal"
              ? node.data
              : refs.dataRef.current;
          // 只有本次挂载新建的会话、带 agent、且 CLI 还没自报 sessionId 时才敲启动行。
          // 待启动节点是例外：它的启动行本来就还没发过，重连之后仍然要接着等
          // 依赖（否则关掉再打开应用，这条绳子就永远悬着了）。
          if (
            hello.alive &&
            (refs.freshSessionRef.current ||
              Boolean(nodeData.agent?.pendingLaunch)) &&
            nodeData.agent &&
            !nodeData.agent.sessionId
          ) {
            armLaunch();
          }
        },
        onSnapshot: (chunk) => {
          if (!disposed) writeChunk(chunk);
        },
        onOutput: (chunk) => {
          if (disposed) return;
          writeChunk(chunk);
          // 启动行的静默判定看的是「后端有没有在输出」，和渲染快慢无关：
          // 离屏的终端一样要在提示符安静下来之后把启动行敲出去。
          noteOutput();
        },
        onStatus: (state, exitCode) => {
          if (disposed) return;
          if (state === "running") {
            patch({ connection: "live", exitCode: null });
            return;
          }
          patch({
            connection: state === "failed" ? "failed" : "exited",
            exitCode,
            binding: null,
          });
          // 与会话 id 同理（`use-session.ts`）：退出码要存盘，但它是进程报上来
          // 的，不是用户改的，不进撤销栈。
          useCanvasStore
            .getState()
            .updateNodeData(
              nodeId,
              { lastExitCode: exitCode },
              { history: "ignore" },
            );
        },
        onWarning: (message) => {
          if (!disposed) patch({ error: message });
        },
        onStale: () => {
          if (disposed) return;
          patch({ binding: null });
          // 同一个 URL、同一个 session id，只是 generation 变了：
          // 重新走一遍连接分支（它会在连接前清屏）。
          setAttempt((value) => value + 1);
        },
        onClose: () => {
          if (disposed) return;
          const connection = refs.statusRef.current.connection;
          // 进程已退出/失败时的关闭是正常收尾；其余情况（Runtime 重启、网络抖动）
          // 都按意外断线处理：标记 detached 并按退避自动重连，重连会先清屏再 attach。
          if (connection === "exited" || connection === "failed") return;
          patch({ connection: "detached", binding: null });
          const delay = refs.reconnectDelayRef.current;
          refs.reconnectDelayRef.current = Math.min(delay * 2, 10_000);
          refs.reconnectTimerRef.current = setTimeout(() => {
            refs.reconnectTimerRef.current = null;
            if (!disposed) setAttempt((value) => value + 1);
          }, delay);
        },
      },
      undefined,
      log,
    );
    refs.transportRef.current = transport;
    patch({ connection: "connecting", binding: null });

    return () => {
      disposed = true;
      clearLaunchTimers();
      if (refs.reconnectTimerRef.current) {
        clearTimeout(refs.reconnectTimerRef.current);
        refs.reconnectTimerRef.current = null;
      }
      transport.close();
      if (refs.transportRef.current === transport)
        refs.transportRef.current = null;
    };
    // 节点数据只经 `refs.dataRef` 读最新值，不进依赖数组：否则改个标题都要重连
  }, [
    refs,
    nodeId,
    sessionId,
    detached,
    attempt,
    setAttempt,
    patch,
    refit,
    flushOutput,
    armLaunch,
    noteOutput,
    clearLaunchTimers,
  ]);
}
