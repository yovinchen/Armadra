import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useQuery } from "@tanstack/react-query";
import type { AdapterId, ContextItem } from "@ai-coding-canvas/shared";
import { agentWebSocketUrl, runtimeApi } from "../api/client";
import { collectContextItems } from "../canvas/context";
import { useCanvasStore } from "../store/canvas-store";
import { usePreferences } from "../preferences/Preferences";
import { formatElapsed, formatTokens } from "../nodes/helpers";
import type { OfKind } from "../nodes/types";
import {
  hasPendingPermission,
  parsePermissionCommand,
  parsePermissionOptions,
  parsePermissionTitle,
  parseUpdate,
  reduceTimeline,
  type PermissionOption,
  type TimelineItem,
  type ToolStatus,
} from "./timeline";

type AcpEvent =
  | { type: "status"; status: string; message?: string }
  | { type: "update"; update: unknown }
  | { type: "permission"; requestId: string; request: unknown }
  | { type: "permission_resolved"; requestId: string; resolution: string };

type Connection = "connecting" | "connected" | "offline";

const CHIP_GLYPH: Record<string, string> = {
  file: "▤",
  context: "◫",
  note: "▢",
  browser: "◍",
  text: "¶",
  task: "☰",
  log: "≡",
};

const TOOL_STATUS: Record<
  ToolStatus,
  { glyph: string; label: string; tone: string; spin: boolean }
> = {
  pending: {
    glyph: "◐",
    label: "acp.tool.running",
    tone: "accent",
    spin: true,
  },
  in_progress: {
    glyph: "◐",
    label: "acp.tool.running",
    tone: "accent",
    spin: true,
  },
  completed: { glyph: "✓", label: "acp.tool.done", tone: "ok", spin: false },
  failed: { glyph: "✕", label: "acp.tool.failed", tone: "err", spin: false },
};

/**
 * The whole Agent node body: ACP header strip, message timeline and the
 * composer footer (SPEC §7). The runtime has no "prompt on an existing
 * session" message — `AcpClientMessage` is only `cancel` /
 * `permission_response` — so every send starts a fresh ACP session through
 * `POST /api/agents/run` with the draft appended as a `text` context item.
 */
export function AcpSurface({
  id,
  data,
  focused,
}: {
  id: string;
  data: OfKind<"agent">;
  focused: boolean;
}) {
  const { t } = usePreferences();
  const workspace = useCanvasStore((state) => state.workspace);
  const document = useCanvasStore((state) => state.document);
  const updateNode = useCanvasStore((state) => state.updateNode);

  const socketRef = useRef<WebSocket | null>(null);
  const sequenceRef = useRef(0);
  const bufferRef = useRef<{ kind: "message" | "thinking"; text: string }[]>(
    [],
  );
  const frameRef = useRef<number | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  const [connection, setConnection] = useState<Connection>(
    data.sessionId ? "connecting" : "offline",
  );
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [usage, setUsage] = useState<{ input: number; output: number } | null>(
    null,
  );
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [draft, setDraft] = useState("");
  const [openThinking, setOpenThinking] = useState<Record<number, boolean>>({});
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);

  const health = useQuery({
    queryKey: ["health"],
    queryFn: runtimeApi.health,
    retry: false,
  });
  const adapters = useQuery({
    queryKey: ["adapters"],
    queryFn: runtimeApi.listAdapters,
    retry: false,
  });

  const nextId = useCallback(() => ++sequenceRef.current, []);
  const push = useCallback(
    (event: Parameters<typeof reduceTimeline>[1]) =>
      setTimeline((items) => reduceTimeline(items, event, nextId)),
    [nextId],
  );

  /* ------------------------------- websocket ------------------------------ */

  const sessionId = data.sessionId;
  useEffect(() => {
    if (!sessionId) {
      setConnection("offline");
      return;
    }
    let finished = false;
    setConnection("connecting");
    const socket = new WebSocket(agentWebSocketUrl(sessionId));
    socketRef.current = socket;

    const flush = () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      const chunks = bufferRef.current;
      bufferRef.current = [];
      if (chunks.length === 0) return;
      setTimeline((items) =>
        chunks.reduce(
          (acc, chunk) =>
            reduceTimeline(
              acc,
              {
                type: "update",
                update: { kind: chunk.kind, text: chunk.text },
              },
              nextId,
            ),
          items,
        ),
      );
    };
    const queue = (kind: "message" | "thinking", text: string) => {
      const last = bufferRef.current.at(-1);
      if (last && last.kind === kind) last.text += text;
      else bufferRef.current.push({ kind, text });
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(flush);
    };

    socket.addEventListener("open", () => setConnection("connected"));
    socket.addEventListener("message", (raw) => {
      let event: AcpEvent;
      try {
        event = JSON.parse(String(raw.data)) as AcpEvent;
      } catch {
        return;
      }
      if (event.type === "update") {
        const update = parseUpdate(event.update);
        if (!update) return;
        if (update.kind === "usage") {
          setUsage({ input: update.inputTokens, output: update.outputTokens });
          return;
        }
        if (update.kind === "message" || update.kind === "thinking") {
          queue(update.kind, update.text);
          return;
        }
        flush();
        push({ type: "update", update });
      } else if (event.type === "permission") {
        flush();
        push({
          type: "permission",
          requestId: event.requestId,
          title:
            parsePermissionTitle(event.request) || t("acp.permissionTitle"),
          command: parsePermissionCommand(event.request),
          options: parsePermissionOptions(event.request),
        });
      } else if (event.type === "permission_resolved") {
        push({
          type: "permission_resolved",
          requestId: event.requestId,
          resolution: event.resolution,
        });
      } else if (event.type === "status") {
        flush();
        if (event.message) push({ type: "status", text: event.message });
        if (["exited", "terminated", "failed"].includes(event.status)) {
          finished = true;
          setConnection("offline");
          setStartedAt(null);
          updateNode(id, {
            status: event.status === "failed" ? "error" : "done",
          });
        }
      }
    });
    const drop = () => {
      setConnection("offline");
      setStartedAt(null);
      if (!finished) {
        finished = true;
        updateNode(id, { status: "idle" });
      }
    };
    socket.addEventListener("close", drop);
    socket.addEventListener("error", drop);

    return () => {
      finished = true;
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      bufferRef.current = [];
      socket.close();
      socketRef.current = null;
    };
    // Deliberately keyed on the session alone: `t` / `updateNode` are stable
    // for the lifetime of the node and must not tear down a live socket.
  }, [id, nextId, push, sessionId]);

  /* -------------------------------- timers -------------------------------- */

  useEffect(() => {
    if (startedAt === null) return;
    setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    const timer = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, [startedAt]);

  useEffect(() => {
    const node = timelineRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [timeline]);

  const pendingPermission = hasPendingPermission(timeline);
  useEffect(() => {
    if (connection !== "connected") return;
    updateNode(id, { status: pendingPermission ? "waiting" : "running" });
  }, [connection, id, pendingPermission, updateNode]);

  /* ---------------------------------- run --------------------------------- */

  const effectiveCwd =
    data.projectPath === "." || data.projectPath === ""
      ? (workspace?.rootPath ?? data.projectPath)
      : data.projectPath;
  const missingCommand = data.adapter === "custom" && !data.command.trim();
  const runnable = Boolean(workspace) && health.isSuccess && !missingCommand;
  const running = connection !== "offline";

  const run = useCallback(
    async (prompt?: string) => {
      const state = useCanvasStore.getState();
      const board = state.document;
      const ws = state.workspace;
      if (!ws || !board) return;
      const items: ContextItem[] = collectContextItems(board, id);
      const text = prompt?.trim();
      if (text)
        items.push({
          nodeId: id,
          kind: "text",
          title: t("acp.prompt"),
          value: text,
        });
      try {
        setError("");
        setStarting(true);
        updateNode(id, { status: "running" });
        const result = await runtimeApi.runAgent({
          workspaceId: ws.id,
          agentNodeId: id,
          adapter: data.adapter,
          ...(data.adapter === "custom" ? { command: data.command } : {}),
          args: data.args,
          cwd: effectiveCwd,
          items,
        });
        setTimeline([]);
        setUsage(null);
        setOpenThinking({});
        setStartedAt(Date.now());
        if (text) push({ type: "update", update: { kind: "user", text } });
        updateNode(id, {
          sessionId: result.session.id,
          projectPath: result.session.cwd,
          status: "running",
        });
      } catch (cause) {
        updateNode(id, { status: "error" });
        setError(cause instanceof Error ? cause.message : t("agent.failed"));
      } finally {
        setStarting(false);
      }
    },
    [
      data.adapter,
      data.args,
      data.command,
      effectiveCwd,
      id,
      push,
      t,
      updateNode,
    ],
  );

  // ⌘⏎ on the canvas (dispatched by B1's shortcut hook).
  useEffect(() => {
    const onRun = (event: Event) => {
      const detail = (event as CustomEvent<{ nodeId?: string }>).detail;
      if (detail?.nodeId !== id) return;
      if (!runnable || running) return;
      void run(draft);
      setDraft("");
    };
    window.addEventListener("canvas:run-agent", onRun);
    return () => window.removeEventListener("canvas:run-agent", onRun);
  }, [draft, id, run, runnable, running]);

  const stop = useCallback(async () => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "cancel" }));
      return;
    }
    if (!data.sessionId) return;
    try {
      await runtimeApi.terminateTerminal(data.sessionId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("agent.stopFailed"));
    }
  }, [data.sessionId, t]);

  const decide = useCallback((requestId: string, optionId: string) => {
    socketRef.current?.send(
      JSON.stringify({ type: "permission_response", requestId, optionId }),
    );
    setTimeline((items) =>
      items.map((item) =>
        item.kind === "permission" && item.requestId === requestId
          ? { ...item, decision: `selected:${optionId}` }
          : item,
      ),
    );
  }, []);

  /* --------------------------------- chips -------------------------------- */

  const derivedChips = useMemo(() => {
    if (!document) return [];
    return collectContextItems(document, id)
      .filter((item) => item.nodeId !== id)
      .map((item) => ({
        key: `${item.nodeId}:${item.kind}`,
        glyph: CHIP_GLYPH[item.kind] ?? "▤",
        label: item.title,
      }));
  }, [document, id]);

  const acpState =
    connection === "connected"
      ? { glyph: "✓", text: t("acp.connected"), tone: "ok", spin: false }
      : connection === "connecting"
        ? { glyph: "◌", text: t("acp.connecting"), tone: "warn", spin: true }
        : { glyph: "⊘", text: t("acp.offline"), tone: "err", spin: false };

  const adapterOptions =
    adapters.data ??
    ([{ id: data.adapter, name: data.adapter, available: true }] as {
      id: AdapterId;
      name: string;
      available: boolean;
      command?: string;
      args?: string[];
    }[]);

  return (
    <div
      className={`agent-surface nodrag nopan ${focused ? "is-focused" : ""}`}
    >
      <div className="agent-strip">
        <span className={`agent-acp tone-${acpState.tone}`} aria-live="polite">
          <span
            aria-hidden="true"
            className={acpState.spin ? "is-spinning" : ""}
          >
            {acpState.glyph}
          </span>
          {acpState.text}
        </span>
        <select
          className="agent-provider nodrag"
          aria-label={t("agent.provider")}
          value={data.adapter}
          disabled={running}
          onChange={(event) => {
            const next = adapterOptions.find(
              (adapter) => adapter.id === event.target.value,
            );
            updateNode(id, {
              adapter: event.target.value as AdapterId,
              command: next?.command ?? "",
              args: next?.args ?? [],
            });
          }}
        >
          {adapterOptions.map((adapter) => (
            <option
              key={adapter.id}
              value={adapter.id}
              disabled={!adapter.available && adapter.id !== data.adapter}
            >
              {adapter.name}
              {adapter.available ? "" : ` · ${t("agent.notInstalled")}`}
            </option>
          ))}
        </select>
        <span className="agent-meters">
          {usage && (
            <span className="agent-meter" title={t("agent.tokens")}>
              ⇅ {formatTokens(usage.input + usage.output)}
            </span>
          )}
          {startedAt !== null && (
            <span className="agent-meter" title={t("agent.elapsed")}>
              ◷ {formatElapsed(elapsed)}
            </span>
          )}
        </span>
      </div>

      <div className="agent-timeline nowheel" ref={timelineRef} role="log">
        {timeline.length === 0 && (
          <p className="agent-empty">
            {data.sessionId ? t("acp.negotiating") : t("agent.ready")}
          </p>
        )}
        {timeline.map((item) => {
          if (item.kind === "user")
            return (
              <div className="agent-bubble agent-bubble--user" key={item.id}>
                {item.text}
              </div>
            );
          if (item.kind === "assistant")
            return (
              <div className="agent-row-assistant" key={item.id}>
                <span className="agent-avatar" aria-hidden="true">
                  ✦
                </span>
                <div className="agent-bubble agent-bubble--assistant">
                  {item.text}
                </div>
              </div>
            );
          if (item.kind === "status")
            return (
              <p className="agent-status-line" key={item.id}>
                {item.text}
              </p>
            );
          if (item.kind === "thinking") {
            const open = openThinking[item.id] ?? false;
            return (
              <div className="agent-thinking" key={item.id}>
                <button
                  type="button"
                  className="nodrag"
                  aria-expanded={open}
                  onClick={() =>
                    setOpenThinking((current) => ({
                      ...current,
                      [item.id]: !open,
                    }))
                  }
                >
                  <span aria-hidden="true">{open ? "▾" : "▸"}</span>
                  {t("acp.thinking")}
                  <span className="agent-thinking-hint">
                    {open ? t("acp.collapse") : t("acp.expand")}
                  </span>
                </button>
                {open && <div className="agent-thinking-body">{item.text}</div>}
              </div>
            );
          }
          if (item.kind === "tool") {
            const status = TOOL_STATUS[item.status];
            return (
              <div className="agent-tool" key={item.id}>
                <span className="agent-tool-glyph" aria-hidden="true">
                  ⚙
                </span>
                <span className="agent-tool-title">{item.title}</span>
                <span className="agent-tool-detail">{item.detail ?? ""}</span>
                <span className={`agent-tool-status tone-${status.tone}`}>
                  <span
                    aria-hidden="true"
                    className={status.spin ? "is-spinning" : ""}
                  >
                    {status.glyph}
                  </span>
                  {t(status.label)}
                </span>
              </div>
            );
          }
          if (item.kind === "plan")
            return (
              <div className="agent-plan" key={item.id}>
                <div className="agent-plan-title">{t("acp.plan")}</div>
                {item.entries.map((entry, index) => (
                  <div
                    className={`agent-plan-row${
                      entry.status === "completed" ? " is-done" : ""
                    }`}
                    key={`${index}-${entry.content}`}
                  >
                    <span aria-hidden="true">
                      {entry.status === "completed"
                        ? "☑"
                        : entry.status === "in_progress"
                          ? "▶"
                          : "☐"}
                    </span>
                    {entry.content}
                  </div>
                ))}
              </div>
            );
          return (
            <PermissionCard
              key={item.id}
              command={item.command}
              decision={item.decision}
              options={item.options}
              onDecide={(optionId) => decide(item.requestId, optionId)}
              title={item.title}
            />
          );
        })}
      </div>

      <div className="agent-footer">
        {(data.contextChips.length > 0 || derivedChips.length > 0) && (
          <div className="agent-chips">
            {derivedChips.map((chip) => (
              <span className="agent-chip" key={chip.key}>
                <span aria-hidden="true">{chip.glyph}</span>
                {chip.label}
              </span>
            ))}
            {data.contextChips.map((chip) => (
              <span className="agent-chip" key={chip.id}>
                <span aria-hidden="true">{CHIP_GLYPH[chip.kind] ?? "▤"}</span>
                {chip.label}
                <button
                  type="button"
                  className="nodrag"
                  aria-label={t("agent.removeChip", { label: chip.label })}
                  onClick={() =>
                    updateNode(id, {
                      contextChips: data.contextChips.filter(
                        (candidate) => candidate.id !== chip.id,
                      ),
                    })
                  }
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          className="agent-draft nodrag nowheel"
          aria-label={t("agent.draft")}
          placeholder={t("agent.draftPlaceholder")}
          rows={2}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            if (!runnable || running) return;
            void run(draft);
            setDraft("");
          }}
        />
        {error && (
          <p className="agent-error" role="alert">
            {error}
          </p>
        )}
        <div className="agent-actions">
          {running && (
            <button
              type="button"
              className="agent-stop nodrag"
              onClick={() => void stop()}
            >
              ■ {t("agent.stop")}
            </button>
          )}
          <button
            type="button"
            className="agent-run nodrag"
            disabled={!runnable || running || starting}
            title={missingCommand ? t("agent.configure") : undefined}
            onClick={() => {
              void run(draft);
              setDraft("");
            }}
          >
            ▶ {draft.trim() ? t("agent.send") : t("agent.run")}
          </button>
        </div>
      </div>
    </div>
  );
}

function PermissionCard({
  title,
  command,
  options,
  decision,
  onDecide,
}: {
  title: string;
  command: string;
  options: PermissionOption[];
  decision: string | null;
  onDecide: (optionId: string) => void;
}) {
  const { t } = usePreferences();
  const decided = decision !== null;
  const chosen = decision?.startsWith("selected:")
    ? options.find(
        (option) => option.optionId === decision.slice("selected:".length),
      )
    : undefined;
  const rejected =
    decision === "cancelled" || (chosen?.kind ?? "").startsWith("reject");
  const outcome = rejected
    ? { glyph: "✕", tone: "err", text: t("acp.decisionRejected") }
    : chosen?.kind === "allow_always"
      ? { glyph: "✓✓", tone: "ok", text: t("acp.decisionAlways") }
      : { glyph: "✓", tone: "ok", text: t("acp.decisionOnce") };

  return (
    <div className="agent-permission" role="alertdialog" aria-label={title}>
      <div className="agent-permission-head">
        <span aria-hidden="true">⏸</span>
        {t("acp.permissionNeeded")}
      </div>
      {command && <div className="agent-permission-command">{command}</div>}
      {!decided && (
        <div className="agent-permission-actions">
          {options.map((option) => (
            <button
              type="button"
              key={option.optionId}
              className={`nodrag ${permissionButtonClass(option.kind)}`}
              onClick={() => onDecide(option.optionId)}
            >
              {permissionGlyph(option.kind)}{" "}
              {permissionLabelKey(option.kind)
                ? t(permissionLabelKey(option.kind)!)
                : option.name}
            </button>
          ))}
        </div>
      )}
      {decided && (
        <div className={`agent-permission-outcome tone-${outcome.tone}`}>
          <span aria-hidden="true">{outcome.glyph}</span>
          {outcome.text}
        </div>
      )}
    </div>
  );
}

function permissionButtonClass(kind: string | undefined): string {
  if (kind === "allow_once") return "agent-permission-allow";
  if (kind === "allow_always") return "agent-permission-always";
  if (kind && kind.startsWith("reject")) return "agent-permission-reject";
  return "agent-permission-always";
}

function permissionLabelKey(kind: string | undefined): string | null {
  if (kind === "allow_once") return "acp.allowOnce";
  if (kind === "allow_always") return "acp.allowAlways";
  if (kind === "reject_once" || kind === "reject_always") return "acp.reject";
  return null;
}

function permissionGlyph(kind: string | undefined): string {
  if (kind === "allow_once") return "✓";
  if (kind === "allow_always") return "✓✓";
  if (kind && kind.startsWith("reject")) return "✕";
  return "•";
}
