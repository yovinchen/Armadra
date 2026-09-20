import type { Board } from "../../canvas/boards";
import type {
  BoardDocument,
  CanvasNode,
  Position,
  Size,
} from "../../canvas/document-types";
import { loadBoard, saveBoard } from "../../canvas/documents";
import { DomainError, rfc3339, uuidV7 } from "../../workspaces/support";
import type { Caller } from "../nodes";
import { Refusal, collapseNewlines } from "../refusals";
import type { CollabContext } from "../service";

/**
 * Loading and saving the board document, plus the placement and naming rules
 * every control verb shares.
 *
 * Ported from the pre-merge implementation. Every mutating verb
 * goes through the ordinary board document — load, edit, save with the same
 * CAS the web app uses — and then publishes `board.changed` so the canvas
 * reloads. The agent never touches the front end, and the front end never has
 * to trust the agent: it re-reads the board it already knows how to read.
 */

export const DEFAULT_NODE_COLOR = "#0a84ff";

/**
 * The 7 node colours a control verb may set — mirrors `NODE_COLORS` in
 * `packages/shared/src/domain.ts`.
 */
export const NODE_PALETTE = [
  "#0a84ff",
  "#32d74b",
  "#ffd60a",
  "#ff453a",
  "#bf5af2",
  "#6ac4dc",
  "#ff9f0a",
] as const;

/** New nodes are placed to the right of the node that asked for them. */
export const PLACEMENT_GAP = 60;

/** Default geometry per node type. */
export function defaultSize(nodeType: string): Size {
  switch (nodeType) {
    case "terminal":
      return { width: 640, height: 440 };
    case "sticky":
      return { width: 240, height: 200 };
    case "group":
      return { width: 520, height: 360 };
    case "editor":
      return { width: 660, height: 460 };
    case "diff":
      return { width: 860, height: 500 };
    case "files":
      return { width: 340, height: 460 };
    case "browser":
      return { width: 800, height: 560 };
    case "automation":
      return { width: 360, height: 260 };
    case "agentActivity":
      return { width: 340, height: 240 };
    default:
      return { width: 260, height: 200 };
  }
}

export function load(context: CollabContext, caller: Caller): BoardDocument {
  try {
    return loadBoard(
      context.database,
      caller.node.workspaceId,
      caller.node.boardId,
    );
  } catch (error) {
    throw asRefusal(error);
  }
}

/**
 * Saves through the same optimistic-concurrency path the canvas uses and tells
 * every client to reload. A conflict means a human moved something in the last
 * instant; asking the agent to retry is the honest answer.
 */
export function save(
  context: CollabContext,
  caller: Caller,
  document: BoardDocument,
): void {
  let saved: BoardDocument;
  try {
    saved = saveBoard(
      context.database,
      caller.node.workspaceId,
      caller.node.boardId,
      {
        expectedUpdatedAt: document.board.updatedAt,
        nodes: document.nodes,
        edges: document.edges,
        viewport: document.board.viewport,
        // The control verbs add and move nodes; the whiteboard is not theirs
        // to touch, so it is carried through untouched.
      },
    );
  } catch (error) {
    if (error instanceof DomainError && error.status === 409) {
      throw Refusal.badRequest("画布刚刚被改动过，请再试一次。");
    }
    throw asRefusal(error);
  }
  context.publish(caller.node.workspaceId, {
    type: "board.changed",
    boardId: saved.board.id,
    updatedAt: saved.board.updatedAt,
  });
}

export function asRefusal(error: unknown): Refusal {
  if (error instanceof Refusal) return error;
  if (error instanceof DomainError) {
    return new Refusal(
      error.status,
      error.status >= 500 ? `画布操作失败：${error.message}` : error.message,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return Refusal.internal(`画布操作失败：${message}`);
}

export function newNode(
  boardId: string,
  nodeType: string,
  title: string,
  position: Position,
  size: Size,
  data: unknown,
): CanvasNode {
  const now = rfc3339();
  return {
    id: uuidV7(),
    boardId,
    type: nodeType,
    title,
    color: DEFAULT_NODE_COLOR,
    position,
    size,
    labels: [],
    note: "",
    data,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * To the right of the caller, same y — and pushed down if something is already
 * standing there, because two nodes at identical coordinates look like one.
 */
export function placement(
  document: BoardDocument,
  callerId: string,
  nodeType: string,
): Position {
  const anchor = document.nodes.find((node) => node.id === callerId);
  let x = PLACEMENT_GAP;
  let y = PLACEMENT_GAP;
  if (anchor !== undefined) {
    const width = anchor.size?.width ?? defaultSize(anchor.type).width;
    x = anchor.position.x + width + PLACEMENT_GAP;
    y = anchor.position.y;
  }
  const height = defaultSize(nodeType).height;
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const taken = document.nodes.some(
      (node) =>
        Math.abs(node.position.x - x) < 24 &&
        Math.abs(node.position.y - y) < 24,
    );
    if (!taken) break;
    y += height + 40;
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { x: PLACEMENT_GAP, y: PLACEMENT_GAP };
  }
  return { x, y };
}

/**
 * `--node` / `--to` against the board itself, for the verbs that edit what is
 * already there.
 *
 * Unlike {@link import("../addressing").resolveLink} this does not require a
 * context link: renaming or colouring a node on your own board is not reaching
 * into somebody else's context. Ambiguity is still refused rather than
 * guessed.
 */
export function resolveOnBoard(
  document: BoardDocument,
  wanted: string,
): CanvasNode {
  const needle = wanted.trim();
  const byId = document.nodes.find((node) => node.id === needle);
  if (byId !== undefined) return byId;
  const lowered = needle.toLowerCase();
  const exact = document.nodes.filter(
    (node) => node.title.toLowerCase() === lowered,
  );
  if (exact.length === 1) return exact[0] as CanvasNode;
  if (exact.length > 1) throw ambiguous(needle, exact.length);
  const partial = document.nodes.filter((node) =>
    node.title.toLowerCase().includes(lowered),
  );
  if (partial.length === 1) return partial[0] as CanvasNode;
  if (partial.length > 1) throw ambiguous(needle, partial.length);
  throw Refusal.notFound(`这块画布上没有叫「${needle}」的节点。`);
}

function ambiguous(wanted: string, count: number): Refusal {
  return Refusal.badRequest(
    `「${wanted}」同时匹配 ${count} 个节点，请改用节点 ID。`,
  );
}

export function cleanTitle(title: string): string {
  const cleaned = collapseNewlines(title);
  if (cleaned === "") throw Refusal.badRequest("标题不能是空的。");
  if ([...cleaned].length > 160) {
    throw Refusal.badRequest("标题最长 160 个字符。");
  }
  return cleaned;
}

export type { Board, BoardDocument, CanvasNode };
