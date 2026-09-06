import {
  create,
  CanvasAnnotationSchema,
  CanvasEdgeKind,
  CanvasEdgeSchema,
  CanvasNodeSchema,
  CanvasSchema,
  type Canvas,
  type CanvasAnnotation,
  type CanvasDocument,
  type CanvasEdge as PbCanvasEdge,
  type CanvasNode as PbCanvasNode,
} from "@armadra/protocol";
import {
  boardDocumentSchema,
  type BoardDocument,
  type CanvasEdge,
  type CanvasNode,
} from "@armadra/shared";

/**
 * 前端文档 ↔ 画布 Protobuf 的映射（H01 §3.2）。
 *
 * 三条不能丢的性质：
 *  1. **没设过的尺寸不是零。** `size` / `collapsed` / `expandedHeight` 在
 *     proto 里是 optional，缺省表示「按节点类型的默认值」；写成 0 会在下次
 *     读回来时把画布上的节点压扁。
 *  2. **父级就是父级。** frame 嵌套是一个普通的 `parentId` 引用，迁移比对时
 *     不需要懂 frame 怎么画。
 *  3. **白板是带摘要的不透明块。** 谁都不解它，读回来时摘要对不上就报错，
 *     宁可失败也不把一份坏快照当成空白板。
 *
 * 标签与备注在 proto 里是独立的 `CanvasAnnotation`：换节点类型时备注还在，
 * 迁移时也能单独比对。空标签且空备注不生成注解——那是「没有注解」，
 * 不是「一条空注解」。
 */

/** 白板快照的协议版本；只有它变了才需要迁移已存的快照。 */
export const WHITEBOARD_SCHEMA_VERSION = 1;
/**
 * 白板引擎的标签。三端都不比较它（Host 与 Runtime 的常量另有一份，见
 * React Flow 计划 §3.5 的核实表），所以换引擎时只改这一处。
 */
export const WHITEBOARD_ENGINE = "armadra-flow";

export interface CanvasDocumentParts {
  canvas: Canvas;
  nodes: PbCanvasNode[];
  edges: PbCanvasEdge[];
  annotations: CanvasAnnotation[];
}

/** 映射失败是硬失败：半份文档写回去等于把没解出来的那半删掉。 */
export class CanvasMappingError extends Error {
  constructor(readonly reason: string) {
    super(`Canvas document mapping failed (${reason}).`);
    this.name = "CanvasMappingError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function unixMs(value: string): bigint {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new CanvasMappingError("timestamp");
  return BigInt(parsed);
}

function isoTime(value: bigint): string {
  // 时间戳留在毫秒量级，Number 转换是精确的；真正会被舍掉的是 revision 与
  // epoch，那两个从头到尾都是 bigint。
  const millis = Number(value);
  if (!Number.isSafeInteger(millis)) throw new CanvasMappingError("timestamp");
  return new Date(millis).toISOString();
}

export async function whiteboardDigest(
  snapshot: Uint8Array,
): Promise<Uint8Array> {
  // 复制一份到独占的 ArrayBuffer：protobuf 的 bytes 可能落在共享缓冲上，
  // WebCrypto 不收那种视图。
  const owned = new Uint8Array(new ArrayBuffer(snapshot.byteLength));
  owned.set(snapshot);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", owned));
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1)
    if (left[index] !== right[index]) return false;
  return true;
}

/**
 * 前端文档 → 一次 `SaveDocument` 的四段内容。
 *
 * `revision` 是调用方读到的那一版；0 表示「这块画布还没建过」。
 */
export async function toCanvasDocument(
  document: BoardDocument,
  revision: bigint,
): Promise<CanvasDocumentParts> {
  const board = document.board;
  const snapshot = board.whiteboard ? encoder.encode(board.whiteboard) : null;
  const canvas = create(CanvasSchema, {
    canvasId: board.id,
    workspaceId: board.workspaceId,
    name: board.name,
    sortOrder: BigInt(board.sortOrder),
    viewport: {
      x: board.viewport.x,
      y: board.viewport.y,
      zoom: board.viewport.zoom,
    },
    whiteboard: snapshot
      ? {
          schemaVersion: WHITEBOARD_SCHEMA_VERSION,
          engineVersion: WHITEBOARD_ENGINE,
          snapshot,
          sha256: await whiteboardDigest(snapshot),
          bytes: BigInt(snapshot.byteLength),
        }
      : undefined,
    createdAtUnixMs: unixMs(board.createdAt),
    updatedAtUnixMs: unixMs(board.updatedAt),
    revision,
  });

  const nodes = document.nodes.map((node) =>
    create(CanvasNodeSchema, {
      nodeId: node.id,
      canvasId: node.boardId,
      type: node.type,
      title: node.title,
      color: node.color,
      position: { x: node.position.x, y: node.position.y },
      // 三个 optional 原样传递：`undefined` 必须留成缺省。
      size: node.size
        ? { width: node.size.width, height: node.size.height }
        : undefined,
      collapsed: node.collapsed,
      expandedHeight: node.expandedHeight,
      parentId: node.parentId ?? "",
      dataJson: encoder.encode(JSON.stringify(node.data)),
      createdAtUnixMs: unixMs(node.createdAt),
      updatedAtUnixMs: unixMs(node.updatedAt),
    }),
  );

  const edges = document.edges.map((edge) =>
    create(CanvasEdgeSchema, {
      edgeId: edge.id,
      canvasId: edge.boardId,
      sourceNodeId: edge.source,
      targetNodeId: edge.target,
      kind: CanvasEdgeKind.LINK,
      createdAtUnixMs: unixMs(edge.createdAt),
      updatedAtUnixMs: unixMs(edge.updatedAt),
    }),
  );

  const annotations = document.nodes
    .filter((node) => node.labels.length > 0 || node.note !== "")
    .map((node) =>
      create(CanvasAnnotationSchema, {
        // 一个节点最多一条注解，所以注解 id 就用节点 id：重放同一次保存时
        // 命中的是同一行，不会长出第二条备注。
        annotationId: node.id,
        canvasId: node.boardId,
        nodeId: node.id,
        labels: node.labels,
        note: node.note,
        createdAtUnixMs: unixMs(node.createdAt),
        updatedAtUnixMs: unixMs(node.updatedAt),
      }),
    );

  return { canvas, nodes, edges, annotations };
}

/** 画布 Protobuf → 前端文档。解不出来就抛，不交半份给界面。 */
export function fromCanvasDocument(document: CanvasDocument): BoardDocument {
  const canvas = document.canvas;
  if (!canvas) throw new CanvasMappingError("canvas");

  let whiteboard = "";
  const board = canvas.whiteboard;
  if (board && board.snapshot.byteLength > 0) {
    if (BigInt(board.snapshot.byteLength) !== board.bytes)
      throw new CanvasMappingError("whiteboardLength");
    try {
      whiteboard = decoder.decode(board.snapshot);
    } catch {
      throw new CanvasMappingError("whiteboardEncoding");
    }
  }

  const notes = new Map(
    document.annotations.map((annotation) => [annotation.nodeId, annotation]),
  );

  const nodes = document.nodes.map((node) => {
    const annotation = notes.get(node.nodeId);
    if (!node.position) throw new CanvasMappingError("position");
    return {
      id: node.nodeId,
      boardId: node.canvasId,
      type: node.type,
      title: node.title,
      color: node.color,
      position: { x: node.position.x, y: node.position.y },
      size: node.size
        ? { width: node.size.width, height: node.size.height }
        : undefined,
      collapsed: node.collapsed,
      expandedHeight: node.expandedHeight,
      parentId: node.parentId || undefined,
      labels: annotation?.labels ?? [],
      note: annotation?.note ?? "",
      data: parseJson(node.dataJson),
      createdAt: isoTime(node.createdAtUnixMs),
      updatedAt: isoTime(node.updatedAtUnixMs),
    };
  });

  const edges = document.edges.map((edge) => ({
    id: edge.edgeId,
    boardId: edge.canvasId,
    source: edge.sourceNodeId,
    target: edge.targetNodeId,
    kind: "link",
    createdAt: isoTime(edge.createdAtUnixMs),
    updatedAt: isoTime(edge.updatedAtUnixMs),
  }));

  // 过一遍 zod：Host 存的是客户端给的不透明 payload，读回来时它是不是仍然
  // 是这个版本认得的形状，只有 schema 说了算。
  const parsed = boardDocumentSchema.safeParse({
    board: {
      id: canvas.canvasId,
      workspaceId: canvas.workspaceId,
      name: canvas.name,
      sortOrder: Number(canvas.sortOrder),
      viewport: canvas.viewport
        ? {
            x: canvas.viewport.x,
            y: canvas.viewport.y,
            zoom: canvas.viewport.zoom,
          }
        : undefined,
      whiteboard,
      createdAt: isoTime(canvas.createdAtUnixMs),
      updatedAt: isoTime(canvas.updatedAtUnixMs),
    },
    nodes,
    edges,
  });
  if (!parsed.success) throw new CanvasMappingError("schema");
  return parsed.data;
}

/** 白板摘要校验；Host 不解快照，所以对不上只能在这里发现。 */
export async function assertWhiteboardDigest(
  document: CanvasDocument,
): Promise<void> {
  const board = document.canvas?.whiteboard;
  if (!board || board.snapshot.byteLength === 0) return;
  const digest = await whiteboardDigest(board.snapshot);
  if (!sameBytes(digest, board.sha256))
    throw new CanvasMappingError("whiteboardDigest");
}

function parseJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0) throw new CanvasMappingError("data");
  try {
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    throw new CanvasMappingError("data");
  }
}

export type { BoardDocument, CanvasEdge, CanvasNode };
