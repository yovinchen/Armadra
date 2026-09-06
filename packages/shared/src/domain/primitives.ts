import { z } from "zod";

export const NODE_TYPES = [
  "terminal",
  "sticky",
  "group",
  "editor",
  "diff",
  "files",
  "browser",
  "automation",
  "agentActivity",
] as const;

/** Only one edge kind is persisted; rope/subagent edges are derived per frame. */
export const EDGE_KINDS = ["link"] as const;

/** Node colour palette — plan §3.4. */
export const NODE_COLORS = [
  "#0a84ff",
  "#32d74b",
  "#ffd60a",
  "#ff453a",
  "#bf5af2",
  "#6ac4dc",
  "#ff9f0a",
] as const;

export const DEFAULT_NODE_COLOR = NODE_COLORS[0];

export const AGENT_STATES = ["working", "waiting", "blocked", "done"] as const;

/**
 * Which channel a node's state was learned through — docs/design/agent-collaboration-channels.md §3.2.
 *
 * The distinction is not decoration. `hook` and `extension` are the same three
 * layers of authentication over two transports (a forked `armadra-hook`, or an
 * in-process extension on the same socket), and either one is evidence a turn
 * really ended. `observed` is the PTY-side guess of §3.4: it may drive a header
 * hint and auto-naming, and it must never satisfy the idle gate that lets a
 * prompt be written into somebody's terminal. An absent source means nothing
 * has reported at all, which is a grey badge, not an idle one.
 */
export const AGENT_STATE_SOURCES = ["hook", "extension", "observed"] as const;

export const PERMISSION_MODES = [
  "default",
  "auto-edit",
  "full-auto",
  "plan",
] as const;

export const nodeTypeSchema = z.enum(NODE_TYPES);
export const edgeKindSchema = z.enum(EDGE_KINDS);
export const nodeColorSchema = z.enum(NODE_COLORS);
export const agentStateSchema = z.enum(AGENT_STATES);
export const agentStateSourceSchema = z.enum(AGENT_STATE_SOURCES);
export const permissionModeSchema = z.enum(PERMISSION_MODES);

export type CanvasNodeType = (typeof NODE_TYPES)[number];
export type CanvasEdgeKind = (typeof EDGE_KINDS)[number];
export type NodeColor = (typeof NODE_COLORS)[number];
export type AgentState = (typeof AGENT_STATES)[number];
export type AgentStateSource = (typeof AGENT_STATE_SOURCES)[number];
export type PermissionMode = (typeof PERMISSION_MODES)[number];
