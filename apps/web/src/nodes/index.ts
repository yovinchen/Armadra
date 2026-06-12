import type { ComponentType } from "react";
import type { CanvasNodeType } from "@ai-coding-canvas/shared";
import { AgentNode } from "./AgentNode";
import { BrowserNode } from "./BrowserNode";
import { ContextNode } from "./ContextNode";
import { DiffNode } from "./DiffNode";
import { FileNode } from "./FileNode";
import { ImageNode } from "./ImageNode";
import { LogNode } from "./LogNode";
import { NoteNode } from "./NoteNode";
import { TaskNode } from "./TaskNode";
import { TerminalNode } from "./TerminalNode";
import type { NodeContentProps } from "./types";

export type { NodeContentProps, OfKind } from "./types";

export {
  EDGE_META,
  NODE_META,
  PALETTE_TYPES,
  SPINNING_STATUSES,
  STATUS_META,
  type EdgeMeta,
  type NodeMeta,
  type StatusMeta,
  type StatusTone,
} from "./meta";

export {
  NODE_ACTIONS,
  emitNodeCommand,
  NODE_COMMANDS,
  type NodeAction,
  type NodeActionContext,
} from "./actions";

/** Type → body component. The shell (header/handles) lives in `canvas/NodeCard`. */
export const NODE_CONTENT: Record<
  CanvasNodeType,
  ComponentType<NodeContentProps>
> = {
  task: TaskNode,
  agent: AgentNode,
  terminal: TerminalNode,
  diff: DiffNode,
  file: FileNode,
  context: ContextNode,
  note: NoteNode,
  browser: BrowserNode,
  image: ImageNode,
  log: LogNode,
};
