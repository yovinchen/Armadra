import type { EventBus } from "../bus";
import type { RouteMatch } from "../http/router";
import type { CoreContext } from "../main";
import { answered, workspaceId } from "../workspaces/routes";
import {
  badRequest,
  internalError,
  isUuid,
  jsonObject,
  optionalString,
} from "../workspaces/support";
import { getWorkspace } from "../workspaces/table";
import {
  type Viewport,
  createBoard,
  getBoard,
  deleteBoard,
  listBoards,
  updateBoard,
} from "./boards";
import { parseContextLinks, putContextLinks } from "./context-links";
import type {
  CanvasEdge,
  CanvasNode,
  SaveBoardRequest,
} from "./document-types";
import { loadBoard, saveBoard } from "./documents";
import {
  CanvasPresence,
  type PresenceSnapshot,
  parseClientId,
  parseDeviceName,
} from "./presence";

/**
 * `/api/workspaces/{id}/boards` — board records, the document load/save pair,
 * and the per-node context-link document.
 *
 * The `kanban` check is the first thing `PUT …/document` does, before the
 * board is even read: it is request validation, it has to answer the same way
 * whatever else is true, and a retired task-board write must be refused
 * explicitly rather than have its data silently discarded.
 */

let assembled: CanvasPresence | undefined;

/** 运行中的 core 的在线表；测试与别的域用它看「谁在看这块画布」。 */
export function canvasPresence(): CanvasPresence | undefined {
  return assembled;
}

export function install(context: CoreContext): void {
  const database = context.db.database;
  const { server, bus } = context;
  const presence = new CanvasPresence({
    publish: (id, snapshot) => publishPresence(bus, id, snapshot),
  });
  presence.start();
  assembled?.stop();
  assembled = presence;

  server.router.handle(
    "GET",
    "/api/workspaces/{workspaceId}/boards",
    answered((match) => ({
      status: 200,
      body: listBoards(database, workspaceId(match)),
    })),
  );

  server.router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/boards",
    answered((match, request) => {
      const body = jsonObject(request.body);
      const name = optionalString(body, "name");
      if (name === undefined) throw badRequest("Board name is invalid");
      return {
        status: 200,
        body: createBoard(database, workspaceId(match), name),
      };
    }),
  );

  server.router.handle(
    "PATCH",
    "/api/workspaces/{workspaceId}/boards/{boardId}",
    answered((match, request) => {
      const body = jsonObject(request.body);
      const sortOrder = body.sortOrder;
      if (
        sortOrder !== undefined &&
        sortOrder !== null &&
        typeof sortOrder !== "number"
      ) {
        throw badRequest("sortOrder must be a number");
      }
      return {
        status: 200,
        body: updateBoard(database, workspaceId(match), boardId(match), {
          name: optionalString(body, "name"),
          sortOrder: typeof sortOrder === "number" ? sortOrder : undefined,
        }),
      };
    }),
  );

  server.router.handle(
    "DELETE",
    "/api/workspaces/{workspaceId}/boards/{boardId}",
    answered((match) => {
      deleteBoard(database, workspaceId(match), boardId(match));
      return { status: 204, body: undefined };
    }),
  );

  server.router.handle(
    "GET",
    "/api/workspaces/{workspaceId}/boards/{boardId}/document",
    answered((match) => ({
      status: 200,
      body: loadBoard(database, workspaceId(match), boardId(match)),
    })),
  );

  server.router.handle(
    "PUT",
    "/api/workspaces/{workspaceId}/boards/{boardId}/document",
    answered((match, request) => {
      const body = jsonObject(request.body);
      if (Object.prototype.hasOwnProperty.call(body, "kanban")) {
        throw badRequest(
          "Task-board writes are retired; historical records are available as read-only archives",
        );
      }
      const save = parseSaveRequest(body);
      // 租约先于 CAS（契约 §9）：别人正在写是 423，手里那份旧了才是 409。
      // 板子存不存在留给 `saveBoard` 判，它的 404 在租约之前也在之后都一样。
      getBoardOrThrow(database, workspaceId(match), boardId(match));
      presence.authorizeWrite(
        workspaceId(match),
        boardId(match),
        save.clientId,
      );
      const document = saveBoard(
        database,
        workspaceId(match),
        boardId(match),
        save,
      );
      publishBoardChanged(
        bus,
        workspaceId(match),
        document.board.id,
        document.board.updatedAt,
      );
      return { status: 200, body: document };
    }),
  );

  // 在线设备的心跳（契约 §9.1）。只读的客户端也要心跳，所以它和读同一档
  // 权限（`route-scopes.ts`）。
  server.router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/boards/{boardId}/presence",
    answered((match, request) => {
      const body = jsonObject(request.body);
      const id = workspaceId(match);
      const board = getBoardOrThrow(database, id, boardId(match));
      if (body.active !== undefined && typeof body.active !== "boolean") {
        throw badRequest("active must be a boolean");
      }
      return {
        status: 200,
        body: presence.heartbeat(id, board, {
          clientId: parseClientId(body.clientId),
          deviceName: parseDeviceName(body.deviceName),
          active: body.active === true,
        }),
      };
    }),
  );

  // 显式离开：切走画布、关掉页面时页面用 `keepalive` 发这一条。没登记过的
  // 客户端离开不是错误——那正是「已经过期了」的样子。
  server.router.handle(
    "DELETE",
    "/api/workspaces/{workspaceId}/boards/{boardId}/presence/{clientId}",
    answered((match) => {
      const id = workspaceId(match);
      const board = getBoardOrThrow(database, id, boardId(match));
      return {
        status: 200,
        body: presence.leave(id, board, parseClientId(match.params.clientId)),
      };
    }),
  );

  // 拿 / 接管写租约（契约 §9.2）。接管的二次确认在页面上。
  server.router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/boards/{boardId}/lease",
    answered((match, request) => {
      const body = jsonObject(request.body);
      const id = workspaceId(match);
      const board = getBoardOrThrow(database, id, boardId(match));
      if (body.takeover !== undefined && typeof body.takeover !== "boolean") {
        throw badRequest("takeover must be a boolean");
      }
      return {
        status: 200,
        body: presence.acquire(id, board, {
          clientId: parseClientId(body.clientId),
          deviceName: parseDeviceName(body.deviceName),
          takeover: body.takeover === true,
        }),
      };
    }),
  );

  server.router.handle(
    "PUT",
    "/api/workspaces/{workspaceId}/context-links/{nodeId}",
    answered((match, request) => {
      const body = jsonObject(request.body);
      const id = workspaceId(match);
      // The workspace read is the 404, and it happens before the node id is
      // even looked at: a document for a workspace nobody registered is not a
      // malformed request.
      getWorkspace(database, id);
      const nodeId = match.params.nodeId;
      if (!isUuid(nodeId)) throw badRequest("Node id is invalid");
      return {
        status: 200,
        body: putContextLinks(database, id, nodeId, parseContextLinks(body)),
      };
    }),
  );
}

/** `board.changed` — the frame every other window rebases its unsaved edits on. */
function publishBoardChanged(
  bus: EventBus,
  workspaceId: string,
  boardId: string,
  updatedAt: string,
): void {
  bus.emit("workspace.event", {
    workspaceId,
    event: { type: "board.changed", boardId, updatedAt },
  });
}

/**
 * `canvas.presence`：谁在看、谁在写（契约 §9.4）。不进 outbox——那是给断线
 * 续订补发用的，而补发一帧过去的在线表只会让页面短暂地看见已经走了的设备；
 * 重连后的第一次心跳自己就带回当前的那一份。
 */
function publishPresence(
  bus: EventBus,
  workspaceId: string,
  snapshot: PresenceSnapshot,
): void {
  bus.emit("workspace.event", {
    workspaceId,
    event: { type: "canvas.presence", ...snapshot },
  });
}

/** 板子在不在这个工作空间里；不在就是 404。回的是规范化后的板 id。 */
function getBoardOrThrow(
  database: CoreContext["db"]["database"],
  workspace: string,
  board: string,
): string {
  return getBoard(database, workspace, board).id;
}

function boardId(match: RouteMatch): string {
  const id = match.params.boardId;
  if (id === undefined) throw internalError("boardId is not in the path");
  return id;
}

/**
 * The save body, with the defaults serde applies.
 *
 * Nothing here decides whether the document is *valid* — that is
 * `validation.ts`, and it runs against the board it claims. This only turns
 * JSON into the shape that check reads, and refuses a body that is not even
 * shaped like a document.
 */
export function parseSaveRequest(
  body: Record<string, unknown>,
): SaveBoardRequest {
  const expectedUpdatedAt = optionalString(body, "expectedUpdatedAt");
  if (expectedUpdatedAt === undefined) {
    throw badRequest("expectedUpdatedAt is required");
  }
  const whiteboard = body.whiteboard;
  if (
    whiteboard !== undefined &&
    whiteboard !== null &&
    typeof whiteboard !== "string"
  ) {
    throw badRequest("whiteboard must be a string");
  }
  const clientId = body.clientId;
  return {
    expectedUpdatedAt,
    // 写者是谁（契约 §9.3）。缺席是没有身份的旧写者，在租约空着时放行。
    clientId:
      clientId === undefined || clientId === null
        ? undefined
        : parseClientId(clientId),
    nodes: array(body.nodes, "nodes").map(parseNode),
    edges: array(body.edges, "edges").map(parseEdge),
    viewport: parseViewport(body.viewport),
    // An absent snapshot preserves the stored one; an explicit `null` is the
    // same as absent, which is what `Option<String>` means on the Rust side.
    whiteboard: typeof whiteboard === "string" ? whiteboard : undefined,
  };
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw badRequest(`${name} must be an array`);
  return value;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseViewport(value: unknown): Viewport {
  const source = object(value, "viewport");
  for (const key of ["x", "y", "zoom"]) {
    if (typeof source[key] !== "number") {
      throw badRequest("Board viewport is invalid");
    }
  }
  return {
    x: source.x as number,
    y: source.y as number,
    zoom: source.zoom as number,
  };
}

/** `#0a84ff` is `default_node_color`; `labels` and `note` default likewise. */
const DEFAULT_NODE_COLOR = "#0a84ff";

function parseNode(value: unknown): CanvasNode {
  const source = object(value, "node");
  const node: Record<string, unknown> = {
    id: text(source, "id"),
    boardId: text(source, "boardId"),
    type: text(source, "type"),
    title: text(source, "title"),
    color: optionalString(source, "color") ?? DEFAULT_NODE_COLOR,
    position: parsePosition(source.position),
    labels: parseLabels(source.labels),
    note: optionalString(source, "note") ?? "",
    data: source.data,
    createdAt: text(source, "createdAt"),
    updatedAt: text(source, "updatedAt"),
  };
  const size = source.size;
  if (size !== undefined && size !== null) {
    const parsed = object(size, "size");
    if (typeof parsed.width !== "number" || typeof parsed.height !== "number") {
      throw badRequest("Board contains an invalid node");
    }
    node.size = { width: parsed.width, height: parsed.height };
  }
  if (typeof source.collapsed === "boolean") node.collapsed = source.collapsed;
  if (typeof source.expandedHeight === "number") {
    node.expandedHeight = source.expandedHeight;
  }
  const parentId = optionalString(source, "parentId");
  if (parentId !== undefined) node.parentId = parentId;
  return node as unknown as CanvasNode;
}

function parseEdge(value: unknown): CanvasEdge {
  const source = object(value, "edge");
  return {
    id: text(source, "id"),
    boardId: text(source, "boardId"),
    source: text(source, "source"),
    target: text(source, "target"),
    kind: optionalString(source, "kind") ?? "link",
    createdAt: text(source, "createdAt"),
    updatedAt: text(source, "updatedAt"),
  };
}

function parsePosition(value: unknown): { x: number; y: number } {
  const source = object(value, "position");
  if (typeof source.x !== "number" || typeof source.y !== "number") {
    throw badRequest("Board contains an invalid node");
  }
  return { x: source.x, y: source.y };
}

function parseLabels(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  return array(value, "labels").map((entry) => {
    if (typeof entry !== "string") {
      throw badRequest("Board contains an invalid node");
    }
    return entry;
  });
}

function text(source: Record<string, unknown>, name: string): string {
  const value = source[name];
  if (typeof value !== "string") {
    throw badRequest(`Board contains an invalid node: ${name} is missing`);
  }
  return value;
}
