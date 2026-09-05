import { CanvasEntityKind, type HostCanvasClient } from "@armadra/host-client";
import { create, CanvasWorkspacePermissionsSchema } from "@armadra/protocol";
import {
  DEFAULT_VIEWPORT,
  type Board,
  type BoardDocument,
  type UpdateBoardRequest,
  type UpdateWorkspaceRequest,
  type Workspace,
} from "@armadra/shared";

import { RuntimeRequestError, runtimeApi } from "../api/client";
import { resolveHostCanvasClient } from "./host-session";
import {
  assertWhiteboardDigest,
  fromCanvasDocument,
  toCanvasDocument,
} from "./mapping";
import {
  canEditCanvas,
  useCanvasOwnership,
  type CanvasOwnershipStatus,
} from "./store";

/**
 * 画布网关（H01 第一阶段）—— 一次写只落一侧。
 *
 * Runtime 与 Host 同时接得上，但**永远只有一个是写方**：没有双写，也没有
 * 自动切换。切换是运维在维护窗口里做的动作，前端只负责探到归属、按归属
 * 路由，并在归属正在变时把画布变成只读。
 *
 * 读跟着最后一次探到的归属走；探不到时读 Runtime——它在交出写权之后仍然
 * 照常答读，所以读永远有地方去。写则相反：归属没落定就不写，
 * `unknown` / `error` / `maintenance` 全部抛 `CanvasReadOnlyError`。
 */

/** 归属没落定，这一次写不该发生。 */
export class CanvasReadOnlyError extends Error {
  readonly name = "CanvasReadOnlyError";
  constructor(readonly status: CanvasOwnershipStatus) {
    super(`Canvas is read-only (${status}).`);
  }
}

/**
 * Runtime 已经交出写权。**不重试**：同一个请求再发一次还是 409，
 * 而且写方已经换人了。捕获它的地方应该重新探归属，再决定走哪边。
 */
export class CanvasOwnershipMovedError extends Error {
  readonly name = "CanvasOwnershipMovedError";
}

export function isOwnershipMoved(error: unknown): boolean {
  return (
    error instanceof RuntimeRequestError &&
    error.status === 409 &&
    error.code === "ownership_moved"
  );
}

/** CAS 冲突：Runtime 的 409，或 Host 的 CONFLICT。 */
export function isCanvasConflict(error: unknown): boolean {
  if (error instanceof CanvasOwnershipMovedError) return false;
  if (error instanceof RuntimeRequestError)
    return error.status === 409 && error.code !== "ownership_moved";
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: string }).name === "HostCanvasError" &&
    (error as { failure?: string }).failure === "conflict"
  );
}

/**
 * 每块画布最后一次读到的 revision，Host 侧的 CAS 就靠它。
 *
 * Runtime 侧用的是 `board.updatedAt` 时间戳，两套 CAS 互不通用，所以这张表
 * 只在 Host 路径上有意义；切归属时会连同会话一起丢掉。
 */
const revisions = new Map<string, bigint>();
const revisionKey = (workspaceId: string, boardId: string) =>
  `${workspaceId}:${boardId}`;

function remember(workspaceId: string, boardId: string, revision: bigint) {
  revisions.set(revisionKey(workspaceId, boardId), revision);
}

function revisionOf(workspaceId: string, boardId: string): bigint {
  return revisions.get(revisionKey(workspaceId, boardId)) ?? 0n;
}

/**
 * 每个工作空间续订事件用的游标。
 *
 * 事件流是**一条**按工作空间划分的单调序号，不是每块画布一条，所以这张表
 * 按工作空间存。只准前进：往回退等于把已经应用过的改动当成没发生。
 */
const cursors = new Map<string, bigint>();

function rememberCursor(workspaceId: string, sequence: bigint) {
  const current = cursors.get(workspaceId);
  if (current === undefined || sequence > current)
    cursors.set(workspaceId, sequence);
}

/**
 * 当前续订游标；`null` 表示这个工作空间还没读到过任何文档——此时没有可续的
 * 位置，从 0 开始订会把整段历史当成「刚发生的改动」重放一遍。
 */
export function canvasEventCursor(workspaceId: string): bigint | null {
  return cursors.get(workspaceId) ?? null;
}

/** 只在快照重置游标时用：快照自带它一致的那个序号。 */
export function resetCanvasEventCursor(
  workspaceId: string,
  sequence: bigint,
): void {
  cursors.set(workspaceId, sequence);
}

/** 仅测试与切换归属时用：丢掉记住的 revision 与游标。 */
export function resetCanvasRevisions(): void {
  revisions.clear();
  cursors.clear();
}

type HostResolver = (
  workspaceId: string,
  mutation: boolean,
) => Promise<HostCanvasClient>;

let resolver: HostResolver = resolveHostCanvasClient;

/** 测试注入 Host 客户端；传 `null` 恢复真实实现。 */
export function setCanvasHostResolver(next: HostResolver | null): void {
  resolver = next ?? resolveHostCanvasClient;
}

/**
 * 事件跟随器走的也是这一个客户端，所以注入的替身对两条路同时生效——
 * 测试里不会出现「网关用假的、跟随器用真的」这种半真半假的状态。
 */
export function resolveCanvasHostClient(
  workspaceId: string,
  mutation: boolean,
): Promise<HostCanvasClient> {
  return resolver(workspaceId, mutation);
}

async function settled(): Promise<CanvasOwnershipStatus> {
  const state = useCanvasOwnership.getState();
  // `error` is retried on the next attempt as well as `unknown`: a probe that
  // failed once is a lost request, not a verdict, and leaving the canvas
  // read-only until someone clicks a banner would turn one blip into a stall.
  // The retry is still bounded — `probe` folds concurrent callers into one
  // request, so a window full of nodes hitting this at once asks once.
  return state.status === "unknown" || state.status === "error"
    ? await state.probe()
    : state.status;
}

async function writeRoute(): Promise<"runtime" | "host"> {
  const status = await settled();
  if (!canEditCanvas(status)) throw new CanvasReadOnlyError(status);
  return status;
}

async function readRoute(): Promise<"runtime" | "host"> {
  // 读没有「拒绝」这一档：维护中或探测失败时回到 Runtime，它交出写权后
  // 仍然答读，所以读永远拿得到一份文档，不会变成一块空画布。
  return (await settled()) === "host" ? "host" : "runtime";
}

/**
 * Runtime 写的统一出口：把 `ownership_moved` 从普通 409 里摘出来。
 *
 * 摘出来才不会被自动变基当成「别的窗口先存了」而重放一次——那次重放会撞上
 * 同一堵墙，只是白白多写一次。
 */
async function runtimeWrite<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!isOwnershipMoved(error)) throw error;
    await useCanvasOwnership.getState().probe();
    throw new CanvasOwnershipMovedError();
  }
}

function operationId(
  workspaceId: string,
  boardId: string,
  revision: bigint,
): string {
  // 同一个基线 revision 的重试用同一个 id：Host 认得出这是重放，回原样的
  // 回执而不是再写一次。内容变了再用它就是 CONFLICT，这正是我们要的。
  return `canvas/${workspaceId}/${boardId}/${revision}`;
}

async function hostDocument(
  client: HostCanvasClient,
  workspaceId: string,
  boardId: string,
): Promise<BoardDocument> {
  const document = await client.getDocument(boardId);
  await assertWhiteboardDigest(document);
  remember(workspaceId, boardId, document.canvas!.revision);
  // 这份文档读到的位置就是续订的起点：从这里往后订，只会拿到读完之后发生的
  // 改动，而不是把已经在手里的内容再当成新事件收一遍。
  rememberCursor(workspaceId, document.eventSequence);
  return fromCanvasDocument(document);
}

export const canvasGateway = {
  async loadBoard(
    workspaceId: string,
    boardId: string,
  ): Promise<BoardDocument> {
    if ((await readRoute()) === "runtime")
      return runtimeApi.loadBoard(workspaceId, boardId);
    return hostDocument(
      await resolver(workspaceId, false),
      workspaceId,
      boardId,
    );
  },

  async saveBoard(
    workspaceId: string,
    boardId: string,
    document: BoardDocument,
  ): Promise<BoardDocument> {
    if ((await writeRoute()) === "runtime")
      return runtimeWrite(() =>
        runtimeApi.saveBoard(workspaceId, boardId, document),
      );
    const client = await resolver(workspaceId, true);
    const revision = revisionOf(workspaceId, boardId);
    const parts = await toCanvasDocument(document, revision);
    const response = await client.saveDocument({
      operationId: operationId(workspaceId, boardId, revision),
      canvas: parts.canvas,
      expectedRevision: revision,
      nodes: parts.nodes,
      edges: parts.edges,
      annotations: parts.annotations,
    });
    const saved = response.document!;
    await assertWhiteboardDigest(saved);
    remember(
      workspaceId,
      boardId,
      nextRevision(response, saved.canvas!.revision, boardId),
    );
    // 自己写出去的事件不必再收一遍：把游标推到本次收据的最后一个序号，
    // 跟随器就不会把这次保存报成「别人改了」。
    if (response.receipt && response.receipt.lastSequence > 0n)
      rememberCursor(workspaceId, response.receipt.lastSequence);
    return fromCanvasDocument(saved);
  },

  async createBoard(workspaceId: string, name: string): Promise<Board> {
    if ((await writeRoute()) === "runtime")
      return runtimeWrite(() => runtimeApi.createBoard(workspaceId, name));
    const client = await resolver(workspaceId, true);
    const boardId = crypto.randomUUID();
    const now = new Date().toISOString();
    const board: Board = {
      id: boardId,
      workspaceId,
      name,
      sortOrder: 0,
      viewport: { ...DEFAULT_VIEWPORT },
      whiteboard: "",
      createdAt: now,
      updatedAt: now,
    };
    // 新建就是「期望 revision 0」——它明确表示这块画布从来没建过，
    // 而不是「随便覆盖现有的那块」。
    const parts = await toCanvasDocument({ board, nodes: [], edges: [] }, 0n);
    const response = await client.saveDocument({
      operationId: operationId(workspaceId, boardId, 0n),
      canvas: parts.canvas,
      expectedRevision: 0n,
      nodes: [],
      edges: [],
      annotations: [],
    });
    const saved = response.document!;
    remember(workspaceId, boardId, saved.canvas!.revision);
    return fromCanvasDocument(saved).board;
  },

  async updateBoard(
    workspaceId: string,
    boardId: string,
    patch: UpdateBoardRequest,
  ): Promise<Board> {
    if ((await writeRoute()) === "runtime")
      return runtimeWrite(() =>
        runtimeApi.updateBoard(workspaceId, boardId, patch),
      );
    const client = await resolver(workspaceId, true);
    const current = await hostDocument(client, workspaceId, boardId);
    const revision = revisionOf(workspaceId, boardId);
    const next: BoardDocument = {
      ...current,
      board: {
        ...current.board,
        name: patch.name ?? current.board.name,
        sortOrder: patch.sortOrder ?? current.board.sortOrder,
      },
    };
    const parts = await toCanvasDocument(next, revision);
    const response = await client.saveDocument({
      operationId: operationId(workspaceId, boardId, revision),
      canvas: parts.canvas,
      expectedRevision: revision,
      nodes: parts.nodes,
      edges: parts.edges,
      annotations: parts.annotations,
    });
    const saved = response.document!;
    remember(workspaceId, boardId, saved.canvas!.revision);
    return fromCanvasDocument(saved).board;
  },

  async deleteBoard(workspaceId: string, boardId: string): Promise<void> {
    if ((await writeRoute()) === "runtime") {
      await runtimeWrite(() => runtimeApi.deleteBoard(workspaceId, boardId));
      return;
    }
    const client = await resolver(workspaceId, true);
    let revision = revisionOf(workspaceId, boardId);
    // 删除留下的是带版本的墓碑，所以必须报出读到的那一版；0 表示「没建过」，
    // 拿它去删什么都删不掉。
    if (revision <= 0n) {
      await hostDocument(client, workspaceId, boardId);
      revision = revisionOf(workspaceId, boardId);
    }
    await client.deleteCanvas({
      operationId: `canvas/${workspaceId}/${boardId}/delete/${revision}`,
      canvasId: boardId,
      expectedRevision: revision,
    });
    revisions.delete(revisionKey(workspaceId, boardId));
  },

  async updateWorkspace(
    workspaceId: string,
    patch: UpdateWorkspaceRequest,
  ): Promise<Workspace> {
    if ((await writeRoute()) === "runtime")
      return runtimeWrite(() => runtimeApi.updateWorkspace(workspaceId, patch));
    const client = await resolver(workspaceId, true);
    const current = await hostWorkspace(client, workspaceId);
    const response = await client.putWorkspace({
      operationId: `workspace/${workspaceId}/${current.revision}`,
      workspace: {
        ...current,
        name: patch.name ?? current.name,
        color: patch.color ?? current.color,
        permissions: patch.permissions
          ? create(CanvasWorkspacePermissionsSchema, patch.permissions)
          : current.permissions,
      },
      expectedRevision: current.revision,
    });
    const saved = response.workspace!;
    return {
      id: saved.workspaceId,
      name: saved.name,
      rootPath: saved.rootPath,
      color: saved.color,
      // The Host canvas surface carries no execution host: a workspace it owns
      // is one the local Runtime executes, which the empty id stands for.
      executionHostId: "",
      permissions: saved.permissions ?? {
        read: true,
        write: true,
        execute: true,
      },
      lastOpenedAt: new Date(Number(saved.lastOpenedAtUnixMs)).toISOString(),
      createdAt: new Date(Number(saved.createdAtUnixMs)).toISOString(),
      updatedAt: new Date(Number(saved.updatedAtUnixMs)).toISOString(),
    };
  },

  async deleteWorkspace(workspaceId: string): Promise<void> {
    if ((await writeRoute()) === "runtime") {
      await runtimeWrite(() => runtimeApi.deleteWorkspace(workspaceId));
      return;
    }
    const client = await resolver(workspaceId, true);
    const current = await hostWorkspace(client, workspaceId);
    await client.deleteWorkspace({
      operationId: `workspace/${workspaceId}/delete/${current.revision}`,
      workspaceId,
      expectedRevision: current.revision,
    });
  },
};

async function hostWorkspace(client: HostCanvasClient, workspaceId: string) {
  const page = await client.listWorkspaces("", 200);
  const found = page.workspaces.find(
    (workspace) => workspace.workspaceId === workspaceId,
  );
  if (!found) throw new CanvasReadOnlyError("error");
  return found;
}

/**
 * 回执里画布那一行的新版本优先：它是这次事务实际落库的版本，比响应文档里
 * 顺带带回来的那一份更接近「下一次 CAS 该报什么」。
 */
function nextRevision(
  response: {
    receipt?: {
      revisions: { kind: number; entityId: string; revision: bigint }[];
    };
  },
  fallback: bigint,
  boardId: string,
): bigint {
  const row = response.receipt?.revisions.find(
    (entry) =>
      entry.kind === CanvasEntityKind.CANVAS && entry.entityId === boardId,
  );
  return row?.revision ?? fallback;
}
