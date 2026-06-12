import type {
  CanvasNode,
  CanvasNodeData,
  CanvasNodeType,
  ContextChip,
} from "@ai-coding-canvas/shared";
import { isTauri, openExternal } from "../platform";
import { DEFAULT_NODE_SIZES, useCanvasStore } from "../store/canvas-store";
import { createNodeData } from "./defaults";
import { hasHunks, hostnameTitle } from "./helpers";
import { NODE_META } from "./meta";

export interface NodeAction {
  id: string;
  /** i18n key — the Inspector renders `t(label)`. */
  label: string;
  glyph: string;
  disabled?: boolean;
  /** i18n key explaining why the action is disabled. */
  tooltip?: string;
  run: () => void;
}

export interface NodeActionContext {
  nodeId: string;
  workspaceId: string | null;
}

/**
 * Window events that let the Inspector trigger behaviour which only the node
 * body can perform (a live WebSocket, an open ConfirmDialog, an xterm handle).
 * Node components listen with `useNodeCommand`.
 */
export const NODE_COMMANDS = {
  runAgent: "canvas:run-agent",
  agentRenegotiate: "canvas:agent-renegotiate",
  terminalRerun: "canvas:terminal-rerun",
  terminalReconnect: "canvas:terminal-reconnect",
  diffAcceptAll: "canvas:diff-accept-all",
  diffRevertAll: "canvas:diff-revert-all",
  contextRefresh: "canvas:context-refresh",
} as const;

export type NodeCommand = (typeof NODE_COMMANDS)[keyof typeof NODE_COMMANDS];

export function emitNodeCommand(command: NodeCommand, nodeId: string): void {
  window.dispatchEvent(new CustomEvent(command, { detail: { nodeId } }));
}

/* -------------------------------------------------------------------------- */
/* Shared behaviours (also used directly by the node bodies)                   */
/* -------------------------------------------------------------------------- */

function board() {
  return useCanvasStore.getState();
}

function findNode(nodeId: string): CanvasNode | undefined {
  return board().document?.nodes.find((node) => node.id === nodeId);
}

/** The Agent a "@ 发送给 Agent" action should target. */
function resolveAgent(nodeId: string): CanvasNode | null {
  const state = board();
  const nodes = state.document?.nodes ?? [];
  const agents = nodes.filter((node) => node.type === "agent");
  if (agents.length === 0) return null;
  if (agents.length === 1) return agents[0]!;
  const selected = agents.find((node) => node.id === state.selectedNodeId);
  if (selected) return selected;
  const linked = state.document?.edges.find(
    (edge) =>
      edge.sourceNodeId === nodeId &&
      agents.some((agent) => agent.id === edge.targetNodeId),
  );
  return (
    agents.find((agent) => agent.id === linked?.targetNodeId) ?? agents[0]!
  );
}

/** Creates an Agent node to the right of `source` and returns it. */
export function createAgentBeside(source: CanvasNode): CanvasNode | null {
  const state = board();
  const rootPath = state.workspace?.rootPath ?? ".";
  const width = source.size?.width ?? DEFAULT_NODE_SIZES[source.type].width;
  return state.addNode(
    createNodeData("agent", { rootPath, label: NODE_META.agent.label }),
    { x: source.position.x + width + 120, y: source.position.y },
    { select: false },
  );
}

/** "➤ 派发": link the Task to the single Agent on the board, or create one. */
export function dispatchTask(taskNodeId: string): void {
  const state = board();
  const task = findNode(taskNodeId);
  if (!task) return;
  const agents = (state.document?.nodes ?? []).filter(
    (node) => node.type === "agent",
  );
  const agent = agents.length === 1 ? agents[0]! : createAgentBeside(task);
  if (!agent) return;
  state.addEdge(task.id, agent.id, "dispatch");
  state.selectNode(agent.id);
}

/**
 * "@ 发送给 Agent": adds a `ref` edge plus a context chip on the Agent so the
 * value travels even when the source node is later detached.
 */
export function sendToAgent(nodeId: string): void {
  const state = board();
  const source = findNode(nodeId);
  if (!source) return;
  const agent = resolveAgent(nodeId) ?? createAgentBeside(source);
  if (!agent || agent.data.kind !== "agent") return;
  state.addEdge(source.id, agent.id, "ref");
  const chip = chipFor(source);
  if (chip) {
    const chips = agent.data.contextChips;
    if (!chips.some((existing) => existing.value === chip.value)) {
      state.updateNode(agent.id, { contextChips: [...chips, chip] });
    }
  }
  state.selectNode(agent.id);
}

function chipFor(node: CanvasNode): ContextChip | null {
  const id = crypto.randomUUID().slice(0, 32);
  switch (node.data.kind) {
    case "file":
      return { id, kind: "file", label: node.data.path, value: node.data.path };
    case "context":
      return {
        id,
        kind: "context",
        label: node.data.path,
        value: node.data.path,
      };
    case "note":
      return {
        id,
        kind: "note",
        label: node.data.title,
        value: node.data.content,
      };
    case "browser":
      return {
        id,
        kind: "browser",
        label: hostnameTitle(node.data.url, node.data.title),
        value: node.data.url,
      };
    case "image":
      return {
        id,
        kind: "text",
        label: node.data.title,
        value: node.data.sourcePath ?? node.data.title,
      };
    case "log":
      return {
        id,
        kind: "text",
        label: node.data.title,
        value: node.data.content.slice(0, 20_000),
      };
    default:
      return null;
  }
}

/** "☰ 转为任务": replaces a Note with a Task that keeps position and edges. */
export function convertNoteToTask(nodeId: string): void {
  const state = board();
  const note = findNode(nodeId);
  if (!note || note.data.kind !== "note") return;
  const content = note.data.content;
  const created = state.addNode(
    {
      kind: "task",
      title: note.data.title,
      subtitle: note.data.subtitle,
      status: "idle",
      description: content,
      checklist: [],
    } satisfies CanvasNodeData,
    note.position,
  );
  if (!created) return;
  for (const edge of state.document?.edges ?? []) {
    if (edge.sourceNodeId === nodeId)
      state.addEdge(created.id, edge.targetNodeId, edge.type);
    else if (edge.targetNodeId === nodeId)
      state.addEdge(edge.sourceNodeId, created.id, edge.type);
  }
  state.removeNodes([nodeId]);
  state.selectNode(created.id);
}

function download(filename: string, contents: string, mime: string): void {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** "⤓ 导出 patch": one `.patch` file containing every hunk of the Diff node. */
export function exportPatch(nodeId: string): void {
  const node = findNode(nodeId);
  if (!node || node.data.kind !== "diff") return;
  // Files the runtime could not preview carry a human-readable placeholder
  // instead of a unified diff; `git apply` would choke on it.
  const contents = node.data.files
    .filter((file) => file.previewable !== false && hasHunks(file.patch))
    .map((file) => file.patch.trimEnd())
    .join("\n");
  if (!contents) return;
  download(`${safeName(node.data.title)}.patch`, contents, "text/x-patch");
}

/** "⤓ 导出日志". */
export function exportLog(nodeId: string): void {
  const node = findNode(nodeId);
  if (!node || node.data.kind !== "log") return;
  const contents = node.data.entries?.length
    ? node.data.entries
        .map((entry) => `${entry.at} [${entry.source}] ${entry.text}`)
        .join("\n")
    : node.data.content;
  download(`${safeName(node.data.title)}.log`, contents, "text/plain");
}

function safeName(title: string): string {
  return title.replace(/[^\w一-龥.-]+/g, "-").slice(0, 60) || "export";
}

/* -------------------------------------------------------------------------- */
/* Inspector action table (design prototype `sel.actions`)                     */
/* -------------------------------------------------------------------------- */

const reserved = (id: string, label: string, glyph: string): NodeAction => ({
  id,
  label,
  glyph,
  disabled: true,
  tooltip: "action.reserved",
  run: () => undefined,
});

export const NODE_ACTIONS: Record<
  CanvasNodeType,
  (context: NodeActionContext) => NodeAction[]
> = {
  task: ({ nodeId }) => [
    {
      id: "task.dispatch",
      label: "action.task.dispatch",
      glyph: "➤",
      run: () => dispatchTask(nodeId),
    },
    {
      id: "task.edit",
      label: "action.task.edit",
      glyph: "✎",
      run: () => useCanvasStore.getState().setNodeZoom(nodeId, "focus"),
    },
  ],

  agent: ({ nodeId }) => {
    const node = findNode(nodeId);
    const agent = node?.data.kind === "agent" ? node.data : null;
    const running = agent?.status === "running" || agent?.status === "waiting";
    return [
      {
        id: "agent.run",
        label: "action.agent.run",
        glyph: "▶",
        disabled: running,
        ...(running ? { tooltip: "action.agent.busy" } : {}),
        run: () => emitNodeCommand(NODE_COMMANDS.runAgent, nodeId),
      },
      {
        id: "agent.renegotiate",
        label: "action.agent.renegotiate",
        glyph: "↻",
        run: () => emitNodeCommand(NODE_COMMANDS.agentRenegotiate, nodeId),
      },
      reserved("agent.push", "action.agent.push", "⇄"),
    ];
  },

  terminal: ({ nodeId }) => [
    {
      id: "terminal.rerun",
      label: "action.terminal.rerun",
      glyph: "▶",
      run: () => emitNodeCommand(NODE_COMMANDS.terminalRerun, nodeId),
    },
    {
      id: "terminal.reconnect",
      label: "action.terminal.reconnect",
      glyph: "↻",
      run: () => emitNodeCommand(NODE_COMMANDS.terminalReconnect, nodeId),
    },
  ],

  diff: ({ nodeId }) => {
    const node = findNode(nodeId);
    const empty = node?.data.kind === "diff" && node.data.files.length === 0;
    return [
      {
        id: "diff.acceptAll",
        label: "action.diff.acceptAll",
        glyph: "✓",
        disabled: empty,
        run: () => emitNodeCommand(NODE_COMMANDS.diffAcceptAll, nodeId),
      },
      {
        id: "diff.revertAll",
        label: "action.diff.revertAll",
        glyph: "↶",
        disabled: empty,
        run: () => emitNodeCommand(NODE_COMMANDS.diffRevertAll, nodeId),
      },
      {
        id: "diff.exportPatch",
        label: "action.diff.exportPatch",
        glyph: "⤓",
        disabled: empty,
        run: () => exportPatch(nodeId),
      },
    ];
  },

  file: ({ nodeId }) => {
    const node = findNode(nodeId);
    const path = node?.data.kind === "file" ? node.data.path : "";
    const rootPath = board().workspace?.rootPath ?? "";
    const desktop = isTauri();
    return [
      {
        id: "file.openEditor",
        label: "action.file.openEditor",
        glyph: "↗",
        disabled: !desktop,
        ...(desktop ? {} : { tooltip: "action.file.desktopOnly" }),
        run: () => {
          if (!desktop || !path) return;
          const absolute = path.startsWith("/")
            ? path
            : `${rootPath.replace(/\/$/, "")}/${path}`;
          void openExternal(`vscode://file/${absolute}`);
        },
      },
      {
        id: "file.addToAgent",
        label: "action.file.addToAgent",
        glyph: "@",
        run: () => sendToAgent(nodeId),
      },
    ];
  },

  context: ({ nodeId }) => [
    {
      id: "context.inject",
      label: "action.context.inject",
      glyph: "@",
      run: () => sendToAgent(nodeId),
    },
    {
      id: "context.refresh",
      label: "action.context.refresh",
      glyph: "↻",
      run: () => emitNodeCommand(NODE_COMMANDS.contextRefresh, nodeId),
    },
  ],

  log: ({ nodeId }) => [
    {
      id: "log.export",
      label: "action.log.export",
      glyph: "⤓",
      run: () => exportLog(nodeId),
    },
  ],

  image: ({ nodeId }) => [
    {
      id: "image.send",
      label: "action.image.send",
      glyph: "@",
      run: () => sendToAgent(nodeId),
    },
    reserved("image.annotate", "action.image.annotate", "✎"),
  ],

  note: ({ nodeId }) => [
    {
      id: "note.send",
      label: "action.note.send",
      glyph: "@",
      run: () => sendToAgent(nodeId),
    },
    {
      id: "note.toTask",
      label: "action.note.toTask",
      glyph: "☰",
      run: () => convertNoteToTask(nodeId),
    },
    reserved("note.split", "action.note.split", "⧉"),
  ],

  browser: ({ nodeId }) => {
    const node = findNode(nodeId);
    const url = node?.data.kind === "browser" ? node.data.url : "";
    return [
      {
        id: "browser.send",
        label: "action.browser.send",
        glyph: "@",
        disabled: !url,
        run: () => sendToAgent(nodeId),
      },
      {
        ...reserved("browser.screenshot", "action.browser.screenshot", "⤓"),
        tooltip: "browser.screenshotReserved",
      },
      {
        id: "browser.open",
        label: "action.browser.open",
        glyph: "↗",
        disabled: !url,
        run: () => {
          if (url) void openExternal(url);
        },
      },
    ];
  },
};
