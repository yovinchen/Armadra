import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { runtimeApi, terminalWebSocketUrl } from "../api/client";
import { useCanvasStore } from "../store/canvas-store";
import { usePreferences } from "../preferences/Preferences";
import { isolateTerminalInput } from "./ime";
import { NODE_COMMANDS } from "../nodes/actions";
import { useNodeCommand } from "../nodes/useNodeCommand";
import type { OfKind } from "../nodes/types";

type Connection = "connecting" | "connected" | "disconnected";

/**
 * The whole Terminal node body: cwd/PID header, the xterm viewport and the
 * summary footer with 清屏 / 重连 / 停止 / 重新运行 (SPEC §8).
 */
export function TerminalSurface({
  id,
  data,
  focused,
}: {
  id: string;
  data: OfKind<"terminal">;
  focused: boolean;
}) {
  const { locale, resolvedTheme, t } = usePreferences();
  const workspace = useCanvasStore((state) => state.workspace);
  const updateNode = useCanvasStore((state) => state.updateNode);

  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [connection, setConnection] = useState<Connection>(
    data.sessionId ? "connecting" : "disconnected",
  );
  const [attempt, setAttempt] = useState(0);
  const [lines, setLines] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const health = useQuery({
    queryKey: ["health"],
    queryFn: runtimeApi.health,
    retry: false,
  });
  const session = useQuery({
    queryKey: ["terminal", data.sessionId],
    queryFn: () => runtimeApi.getTerminal(data.sessionId!),
    enabled: Boolean(data.sessionId) && connection === "connected",
    retry: false,
  });

  const effectiveCwd =
    data.cwd === "." || data.cwd === ""
      ? (workspace?.rootPath ?? data.cwd)
      : data.cwd;
  const sessionId = data.sessionId;
  const fontSize = focused ? 13 : 11.5;

  /* ------------------------------ xterm + ws ------------------------------ */

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !sessionId) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      scrollback: 5_000,
      fontFamily: "ui-monospace, Menlo, 'SFMono-Regular', Consolas, monospace",
      fontSize,
      lineHeight: 1.35,
      theme: terminalTheme(resolvedTheme),
    });
    terminalRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    terminal.attachCustomKeyEventHandler(
      (event) => !(event.isComposing || event.keyCode === 229),
    );
    const releaseIme = terminal.textarea
      ? isolateTerminalInput(terminal.textarea, locale)
      : () => undefined;

    setLines(0);
    const socket = new WebSocket(terminalWebSocketUrl(sessionId));
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      setConnection("connected");
      fit.fit();
      socket.send(
        JSON.stringify({
          type: "resize",
          cols: terminal.cols,
          rows: terminal.rows,
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as {
          type: string;
          data?: string;
          message?: string;
          status?: string;
          exitCode?: number;
        };
        if (message.type === "output" && message.data) {
          terminal.write(message.data);
          const breaks = message.data.split("\n").length - 1;
          if (breaks > 0) setLines((count) => count + breaks);
        }
        if (
          message.type === "status" &&
          (message.status === "exited" ||
            message.status === "terminated" ||
            message.status === "failed")
        ) {
          terminal.writeln(
            `\r\n[canvas] ${message.status}${
              typeof message.exitCode === "number"
                ? ` (${message.exitCode})`
                : ""
            }`,
          );
          updateNode(id, {
            status: message.status === "failed" ? "error" : "done",
            lastExitCode:
              typeof message.exitCode === "number" ? message.exitCode : null,
          });
        }
        if (message.type === "warning" && message.message)
          terminal.writeln(`\r\n[canvas] ${message.message}`);
      } catch {
        terminal.write(String(event.data));
      }
    });
    socket.addEventListener("close", () => setConnection("disconnected"));
    socket.addEventListener("error", () => setConnection("disconnected"));

    const input = terminal.onData((data_) => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "input", data: data_ }));
    });
    const resize = new ResizeObserver(() => {
      fit.fit();
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: "resize",
            cols: terminal.cols,
            rows: terminal.rows,
          }),
        );
      }
    });
    resize.observe(container);

    return () => {
      resize.disconnect();
      releaseIme();
      input.dispose();
      socket.close();
      socketRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
    };
    // `updateNode` is a stable store action; re-running here would drop the PTY.
  }, [attempt, fontSize, id, locale, resolvedTheme, sessionId]);

  /* -------------------------------- actions ------------------------------- */

  const start = useCallback(async () => {
    const ws = useCanvasStore.getState().workspace;
    if (!ws) return;
    try {
      setError("");
      setBusy(true);
      const created = await runtimeApi.createTerminal({
        workspaceId: ws.id,
        cwd: effectiveCwd,
        shell: data.shell,
        ...(data.command ? { command: data.command } : {}),
      });
      setConnection("connecting");
      updateNode(id, {
        sessionId: created.id,
        cwd: created.cwd,
        status: "running",
        lastExitCode: null,
      });
    } catch (cause) {
      updateNode(id, { status: "error" });
      setError(cause instanceof Error ? cause.message : t("terminal.failed"));
    } finally {
      setBusy(false);
    }
  }, [data.command, data.shell, effectiveCwd, id, t, updateNode]);

  const reconnect = useCallback(async () => {
    if (!sessionId) {
      await start();
      return;
    }
    try {
      setError("");
      setBusy(true);
      const existing = await runtimeApi.getTerminal(sessionId);
      if (existing.status === "running") {
        setConnection("connecting");
        setAttempt((value) => value + 1);
        return;
      }
      updateNode(id, { sessionId: undefined });
      await start();
    } catch {
      // The session is gone from the runtime: open a fresh one with same cwd.
      updateNode(id, { sessionId: undefined });
      await start();
    } finally {
      setBusy(false);
    }
  }, [id, sessionId, start, updateNode]);

  const stop = useCallback(async () => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "terminate" }));
      return;
    }
    if (!sessionId) return;
    try {
      await runtimeApi.terminateTerminal(sessionId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("terminal.failed"));
    }
  }, [sessionId, t]);

  const rerun = useCallback(async () => {
    if (sessionId) updateNode(id, { sessionId: undefined });
    await start();
  }, [id, sessionId, start, updateNode]);

  useNodeCommand(NODE_COMMANDS.terminalRerun, id, () => void rerun());
  useNodeCommand(NODE_COMMANDS.terminalReconnect, id, () => void reconnect());

  const running = connection === "connected" && data.status === "running";
  const summary = running
    ? t("terminal.summaryRunning", { count: lines })
    : typeof data.lastExitCode === "number"
      ? t("terminal.summaryExit", { code: data.lastExitCode })
      : connection === "disconnected" && sessionId
        ? t("terminal.summaryOffline")
        : t("terminal.summaryIdle");

  const connectionMeta =
    connection === "connected"
      ? { glyph: "✓", text: t("terminal.live"), tone: "ok", spin: false }
      : connection === "connecting"
        ? { glyph: "◌", text: t("terminal.linking"), tone: "warn", spin: true }
        : { glyph: "⊘", text: t("terminal.offline"), tone: "err", spin: false };

  return (
    <div
      className={`terminal-surface nodrag nopan ${focused ? "is-focused" : ""}`}
    >
      <div className="terminal-strip">
        <span className="terminal-cwd" title={effectiveCwd}>
          {effectiveCwd}
        </span>
        <span className={`terminal-conn tone-${connectionMeta.tone}`}>
          <span
            aria-hidden="true"
            className={connectionMeta.spin ? "is-spinning" : ""}
          >
            {connectionMeta.glyph}
          </span>
          {connectionMeta.text}
        </span>
        {connection === "connected" &&
          typeof session.data?.pid === "number" && (
            <span className="terminal-pid">PID {session.data.pid}</span>
          )}
      </div>

      <div className="terminal-screen nowheel">
        {sessionId ? (
          <div
            ref={containerRef}
            className="terminal-mount"
            aria-label={t("terminal.label")}
            onPointerDown={() =>
              containerRef.current
                ?.querySelector<HTMLTextAreaElement>("textarea")
                ?.focus()
            }
          />
        ) : (
          <p className="terminal-idle">
            {t("terminal.starting", {
              cwd: effectiveCwd,
              shell: data.shell,
            })}
          </p>
        )}
      </div>

      <div className="terminal-footer">
        <span className="terminal-summary">{summary}</span>
        {error && (
          <span className="terminal-error" role="alert">
            {error}
          </span>
        )}
        <button
          type="button"
          className="terminal-button nodrag"
          onClick={() => {
            terminalRef.current?.clear();
            setLines(0);
          }}
        >
          {t("terminal.clear")}
        </button>
        <button
          type="button"
          className="terminal-button nodrag"
          disabled={busy || !health.isSuccess}
          onClick={() => void reconnect()}
        >
          ↻ {t("terminal.reconnect")}
        </button>
        {running ? (
          <button
            type="button"
            className="terminal-stop nodrag"
            onClick={() => void stop()}
          >
            ■ {t("terminal.stop")}
          </button>
        ) : (
          <button
            type="button"
            className="terminal-rerun nodrag"
            disabled={busy || !health.isSuccess}
            onClick={() => void rerun()}
          >
            ▶ {sessionId ? t("terminal.rerun") : t("terminal.start")}
          </button>
        )}
      </div>
    </div>
  );
}

function terminalTheme(theme: "light" | "dark") {
  // Palette follows docs/redesign-plan.md §6 (--term-bg and the accent family).
  return theme === "dark"
    ? {
        background: "#0A0B0D",
        foreground: "#EDEEF2",
        cursor: "#7C7CF0",
        selectionBackground: "#7C7CF044",
        black: "#15161A",
        red: "#F0605D",
        green: "#3FBF7F",
        yellow: "#E3B341",
        blue: "#5B9BF0",
        magenta: "#C792EA",
        cyan: "#4FC3CE",
        white: "#EDEEF2",
      }
    : {
        background: "#1B1D26",
        foreground: "#EDEEF2",
        cursor: "#7C7CF0",
        selectionBackground: "#5B5BD644",
        black: "#1B1D26",
        red: "#F0605D",
        green: "#3FBF7F",
        yellow: "#E3B341",
        blue: "#5B9BF0",
        magenta: "#C792EA",
        cyan: "#4FC3CE",
        white: "#F5F6FA",
      };
}
