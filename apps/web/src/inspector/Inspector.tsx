import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { NODE_ZOOMS } from "@ai-coding-canvas/shared";
import type {
  CanvasNode,
  CanvasNodeData,
  NodeZoom,
} from "@ai-coding-canvas/shared";
import { runtimeApi } from "../api/client";
import { collectContextItems } from "../canvas/context";
import { useCanvasStore } from "../store/canvas-store";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { usePreferences } from "../preferences/Preferences";
import { useGatewayState } from "../shell/gateway";
import {
  EDGE_META,
  NODE_ACTIONS,
  NODE_META,
  SPINNING_STATUSES,
  STATUS_META,
} from "../nodes";

const ZOOM_GLYPH: Record<NodeZoom, string> = {
  mini: "−",
  normal: "▢",
  focus: "⤢",
};

/** 272px inspector — plan §1.2, prototype "Inspector" block. */
export function Inspector() {
  const { t } = usePreferences();
  const document = useCanvasStore((state) => state.document);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const node = document?.nodes.find(
    (candidate) => candidate.id === selectedNodeId,
  );

  return (
    <aside className="inspector" aria-label={t("inspector.label")}>
      <div className="inspector-title">
        INSPECTOR
        <span className="hint">
          {node ? t("inspector.selected") : t("inspector.unselected")}
        </span>
      </div>
      {node ? <NodeInspector key={node.id} node={node} /> : <BoardOverview />}
    </aside>
  );
}

function BoardOverview() {
  const { t, summaryThreshold } = usePreferences();
  const document = useCanvasStore((state) => state.document);
  const boards = useCanvasStore((state) => state.boards);
  const boardId = useCanvasStore((state) => state.boardId);
  const workspace = useCanvasStore((state) => state.workspace);
  const selectNode = useCanvasStore((state) => state.selectNode);
  const gateway = useGatewayState(workspace?.id);

  const boardName =
    boards.find((board) => board.id === boardId)?.name ??
    document?.board.name ??
    "";
  const zoom = document?.board.viewport.zoom ?? 1;
  const overview = document?.nodes ?? [];

  return (
    <div className="inspector-body">
      <div className="inspector-card">
        <div className="row">
          <span>{t("inspector.board")}</span>
          <span>{boardName}</span>
        </div>
        <div className="row">
          <span>{t("inspector.counts")}</span>
          <span>
            {document?.nodes.length ?? 0} / {document?.edges.length ?? 0}
          </span>
        </div>
        <div className="row">
          <span>{t("inspector.scale")}</span>
          <span className="mono">{Math.round(zoom * 100)}%</span>
        </div>
        <div className="row">
          <span>{t("inspector.gateway")}</span>
          <span
            style={{ color: gateway.enabled ? "var(--info)" : "var(--muted)" }}
          >
            {gateway.glyph}{" "}
            {gateway.enabled
              ? t("inspector.gatewayReserved")
              : t("inspector.gatewayOff")}
          </span>
        </div>
      </div>

      <div>
        <div className="inspector-group-label">{t("inspector.overview")}</div>
        <div className="inspector-list">
          {overview.length === 0 && (
            <p className="inspector-hint">{t("inspector.overviewEmpty")}</p>
          )}
          {overview.map((node) => {
            const meta = NODE_META[node.type];
            return (
              <button
                key={node.id}
                type="button"
                className="inspector-list-row"
                onClick={() => selectNode(node.id)}
              >
                <span
                  className="row-glyph"
                  style={{ background: meta.softColor, color: meta.color }}
                  aria-hidden="true"
                >
                  {meta.glyph}
                </span>
                <span className="row-title">{node.data.title}</span>
                <StatusText status={node.data.status} />
              </button>
            );
          })}
        </div>
      </div>

      <p className="inspector-hint">
        {t("inspector.emptyHint", {
          threshold: `${Math.round(summaryThreshold * 100)}%`,
        })}
      </p>
    </div>
  );
}

function StatusText({ status }: { status: CanvasNodeData["status"] }) {
  const { t } = usePreferences();
  const meta = STATUS_META[status];
  return (
    <span className={`inspector-status node-status--${status}`}>
      <span
        aria-hidden="true"
        className={SPINNING_STATUSES.includes(status) ? "is-spinning" : ""}
      >
        {meta.glyph}
      </span>
      {t(meta.label)}
    </span>
  );
}

function NodeInspector({ node }: { node: CanvasNode }) {
  const { t } = usePreferences();
  const document = useCanvasStore((state) => state.document);
  const workspace = useCanvasStore((state) => state.workspace);
  const setNodeZoom = useCanvasStore((state) => state.setNodeZoom);
  const removeNodes = useCanvasStore((state) => state.removeNodes);
  const removeEdges = useCanvasStore((state) => state.removeEdges);
  const duplicateNode = useCanvasStore((state) => state.duplicateNode);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const meta = NODE_META[node.type];

  const connections = useMemo(
    () =>
      document?.edges.filter(
        (edge) =>
          edge.sourceNodeId === node.id || edge.targetNodeId === node.id,
      ) ?? [],
    [document, node.id],
  );
  const actions = NODE_ACTIONS[node.type]({
    nodeId: node.id,
    workspaceId: workspace?.id ?? null,
  });

  return (
    <div className="inspector-body">
      <div className="inspector-node-head">
        <span
          className="inspector-glyph"
          style={{ background: meta.softColor, color: meta.color }}
          aria-hidden="true"
        >
          {meta.glyph}
        </span>
        <div className="inspector-node-head-text">
          <NodeTitleField node={node} />
          <div className="inspector-hint">
            {t(meta.labelKey)} · {node.id.slice(0, 8)}
          </div>
        </div>
      </div>

      <div className="inspector-card">
        <div className="row">
          <span>{t("inspector.status")}</span>
          <StatusText status={node.data.status} />
        </div>
        <div className="row">
          <span>{t("inspector.position")}</span>
          <span className="mono">
            {Math.round(node.position.x)}, {Math.round(node.position.y)}
          </span>
        </div>
        <div className="row">
          <span>{t("inspector.size")}</span>
          <span className="mono">
            {Math.round(node.size?.width ?? meta.defaultSize.width)} ×{" "}
            {Math.round(node.size?.height ?? meta.defaultSize.height)}
          </span>
        </div>
      </div>

      <div>
        <div className="inspector-group-label">{t("inspector.zoom")}</div>
        <div className="zoom-segment">
          {NODE_ZOOMS.map((zoom) => (
            <button
              key={zoom}
              type="button"
              className={node.zoom === zoom ? "is-active" : ""}
              onClick={() => setNodeZoom(node.id, zoom as NodeZoom)}
            >
              <span aria-hidden="true">{ZOOM_GLYPH[zoom as NodeZoom]}</span>{" "}
              {t(`zoom.${zoom}`)}
            </button>
          ))}
        </div>
      </div>

      {node.data.kind === "agent" && document && (
        <AgentSettings nodeId={node.id} data={node.data} />
      )}
      {node.data.kind === "terminal" && (
        <TerminalSettings nodeId={node.id} data={node.data} />
      )}
      {node.data.kind === "agent" && document && (
        <ContextBundle nodeId={node.id} />
      )}

      <div>
        <div className="inspector-group-label">
          {t("inspector.links", { count: connections.length })}
        </div>
        <div className="inspector-list">
          {connections.length === 0 && (
            <p className="inspector-hint">{t("inspector.noLinks")}</p>
          )}
          {connections.map((edge) => {
            const outgoing = edge.sourceNodeId === node.id;
            const otherId = outgoing ? edge.targetNodeId : edge.sourceNodeId;
            const other = document?.nodes.find((item) => item.id === otherId);
            return (
              <div className="inspector-list-row" key={edge.id}>
                <span aria-hidden="true" className="muted">
                  {outgoing ? t("inspector.outgoing") : t("inspector.incoming")}
                </span>
                <span className="row-title">
                  {other?.data.title ?? otherId.slice(0, 8)}
                </span>
                <span className="edge-tag">
                  {t(EDGE_META[edge.type].label)}
                </span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t("inspector.removeLink")}
                  onClick={() => removeEdges([edge.id])}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <div className="inspector-group-label">{t("inspector.actions")}</div>
        <div className="inspector-list">
          {actions.length === 0 && (
            <p className="inspector-hint">{t("inspector.noActions")}</p>
          )}
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className="inspector-list-row"
              disabled={action.disabled}
              title={action.tooltip ? t(action.tooltip) : undefined}
              onClick={action.run}
            >
              <span aria-hidden="true" className="muted">
                {action.glyph}
              </span>
              <span className="row-title">{t(action.label)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="inspector-footer-actions">
        <button
          type="button"
          className="secondary-action"
          onClick={() => duplicateNode(node.id)}
        >
          ⧉ {t("inspector.duplicate")}
        </button>
        <button
          type="button"
          className="danger-action"
          onClick={() => setConfirmDelete(true)}
        >
          ✕ {t("inspector.delete")}
        </button>
      </div>

      {node.data.kind === "agent" && (
        <p className="inspector-hint">{t("inspector.safety")}</p>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title={t("inspector.deleteTitle", { title: node.data.title })}
        description={t("inspector.deleteDescription")}
        confirmLabel={t("inspector.delete")}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          removeNodes([node.id]);
        }}
      />
    </div>
  );
}

function ContextBundle({ nodeId }: { nodeId: string }) {
  const { t } = usePreferences();
  const document = useCanvasStore((state) => state.document);
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  if (!document) return null;
  const items = collectContextItems(document, nodeId);
  return (
    <div>
      <div className="inspector-group-label">{t("inspector.context")}</div>
      <p className="inspector-hint">
        {t("inspector.contextCount", { count: items.length })}
      </p>
      <button
        type="button"
        className="secondary-action"
        onClick={async () => {
          try {
            setError("");
            const result = await runtimeApi.previewContext(nodeId, items);
            setPreview(result.prompt);
          } catch (cause) {
            setError(
              cause instanceof Error
                ? cause.message
                : t("inspector.previewFailed"),
            );
          }
        }}
      >
        {t("inspector.preview")}
      </button>
      {preview && <pre className="context-preview">{preview}</pre>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function NodeTitleField({ node }: { node: CanvasNode }) {
  const { t } = usePreferences();
  const updateNode = useCanvasStore((state) => state.updateNode);
  const [value, setValue] = useState(node.data.title);
  const [error, setError] = useState("");

  useEffect(() => {
    setValue(node.data.title);
    setError("");
  }, [node.data.title, node.id]);

  const commit = () => {
    const title = value.trim();
    if (!title) {
      setError(t("inspector.titleRequired"));
      return;
    }
    setError("");
    if (title !== node.data.title) updateNode(node.id, { title });
  };

  return (
    <>
      <input
        className="inspector-title-input"
        name="node-title"
        autoComplete="off"
        maxLength={160}
        aria-label={t("inspector.title")}
        value={value}
        aria-invalid={Boolean(error)}
        onChange={(event) => setValue(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

function AgentSettings({
  nodeId,
  data,
}: {
  nodeId: string;
  data: Extract<CanvasNodeData, { kind: "agent" }>;
}) {
  const { t } = usePreferences();
  const updateNode = useCanvasStore((state) => state.updateNode);
  const adapters = useQuery({
    queryKey: ["adapters"],
    queryFn: runtimeApi.listAdapters,
    retry: false,
  });
  const disabled = data.status === "running";
  const selected = adapters.data?.find(
    (adapter) => adapter.id === data.adapter,
  );

  return (
    <div>
      <div className="inspector-group-label">
        {t("inspector.agentSettings")}
      </div>
      <p className="inspector-hint">{t("inspector.acpHint")}</p>
      <label className="inspector-field">
        {t("inspector.adapter")}
        <select
          name="agent-adapter"
          value={data.adapter}
          disabled={disabled}
          onChange={(event) => {
            const adapter = adapters.data?.find(
              (candidate) => candidate.id === event.target.value,
            );
            updateNode(nodeId, {
              adapter: event.target.value as typeof data.adapter,
              command: adapter?.command ?? "",
              args: adapter?.args ?? [],
            });
          }}
        >
          {(adapters.data ?? [{ id: data.adapter, name: data.adapter }]).map(
            (adapter) => (
              <option
                key={adapter.id}
                value={adapter.id}
                disabled={"available" in adapter && !adapter.available}
              >
                {"available" in adapter && !adapter.available ? "○ " : ""}
                {adapter.name}
              </option>
            ),
          )}
        </select>
      </label>
      {adapters.isError && (
        <p className="form-error" role="alert">
          {t("inspector.agentDetectFailed")}
        </p>
      )}
      <label className="inspector-field">
        {t("inspector.cwd")}
        <input
          name="agent-project-path"
          autoComplete="off"
          spellCheck={false}
          value={data.projectPath}
          disabled={disabled}
          onChange={(event) =>
            updateNode(nodeId, { projectPath: event.target.value })
          }
        />
      </label>
      <label className="inspector-field">
        {t("inspector.command")}
        <input
          name="agent-command"
          autoComplete="off"
          spellCheck={false}
          value={data.command}
          disabled={disabled || data.adapter !== "custom"}
          onChange={(event) =>
            updateNode(nodeId, { command: event.target.value })
          }
        />
      </label>
      {selected && (
        <p className="inspector-hint" role="status">
          {t(
            selected.available
              ? "inspector.protocolReady"
              : "inspector.protocolMissing",
            { protocol: selected.protocol.toUpperCase() },
          )}
        </p>
      )}
      <label className="inspector-field">
        {t("inspector.args")}
        <textarea
          name="agent-args"
          spellCheck={false}
          value={data.args.join("\n")}
          disabled={disabled}
          onChange={(event) =>
            updateNode(nodeId, {
              args: event.target.value
                .split("\n")
                .map((argument) => argument.trim())
                .filter(Boolean),
            })
          }
        />
      </label>
      {disabled && <p className="inspector-hint">{t("inspector.readonly")}</p>}
    </div>
  );
}

function TerminalSettings({
  nodeId,
  data,
}: {
  nodeId: string;
  data: Extract<CanvasNodeData, { kind: "terminal" }>;
}) {
  const { t } = usePreferences();
  const updateNode = useCanvasStore((state) => state.updateNode);
  const disabled = data.status === "running";
  return (
    <div>
      <div className="inspector-group-label">
        {t("inspector.terminalSettings")}
      </div>
      <label className="inspector-field">
        {t("inspector.cwd")}
        <input
          name="terminal-cwd"
          autoComplete="off"
          spellCheck={false}
          value={data.cwd}
          disabled={disabled}
          onChange={(event) => updateNode(nodeId, { cwd: event.target.value })}
        />
      </label>
      <label className="inspector-field">
        Shell
        <input
          name="terminal-shell"
          autoComplete="off"
          spellCheck={false}
          value={data.shell}
          disabled={disabled}
          onChange={(event) =>
            updateNode(nodeId, { shell: event.target.value })
          }
        />
      </label>
    </div>
  );
}
