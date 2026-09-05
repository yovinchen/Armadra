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
export const permissionModeSchema = z.enum(PERMISSION_MODES);

export type CanvasNodeType = (typeof NODE_TYPES)[number];
export type CanvasEdgeKind = (typeof EDGE_KINDS)[number];
export type NodeColor = (typeof NODE_COLORS)[number];
export type AgentState = (typeof AGENT_STATES)[number];
export type PermissionMode = (typeof PERMISSION_MODES)[number];
