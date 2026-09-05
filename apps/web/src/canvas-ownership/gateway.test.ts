import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  create,
  CanvasDocumentSchema,
  CanvasEntityKind,
  GetCanvasDocumentResponseSchema,
  SaveCanvasDocumentResponseSchema,
} from "@armadra/protocol";
import type { HostCanvasClient } from "@armadra/host-client";
import type { BoardDocument } from "@armadra/shared";

const canvasOwnership = vi.fn();
const loadBoard = vi.fn();
const saveBoard = vi.fn();
const deleteBoard = vi.fn();

/** 网关按 `code` 区分 `ownership_moved` 与普通 CAS 冲突，所以要真类。 */
class RuntimeRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "RuntimeRequestError";
  }
}

vi.mock("../api/client", () => ({
  RuntimeRequestError,
  runtimeApi: {
    canvasOwnership: () => canvasOwnership(),
    loadBoard: (...args: unknown[]) => loadBoard(...args),
    saveBoard: (...args: unknown[]) => saveBoard(...args),
    deleteBoard: (...args: unknown[]) => deleteBoard(...args),
  },
}));

const { useCanvasOwnership } = await import("./store");
const {
  canvasGateway,
  isCanvasConflict,
  resetCanvasRevisions,
  setCanvasHostResolver,
  CanvasOwnershipMovedError,
  CanvasReadOnlyError,
} = await import("./gateway");
const { toCanvasDocument } = await import("./mapping");

const timestamp = "2026-08-13T00:00:00.000Z";
const workspaceId = "019ff7d1-0d12-7421-833d-2c5e8d64ed21";
const boardId = "019ff7d1-7419-74df-89e2-b1619d36ea7d";

const document: BoardDocument = {
  board: {
    id: boardId,
    workspaceId,
    name: "默认画布",
    sortOrder: 0,
    viewport: { x: 0, y: 0, zoom: 1 },
    whiteboard: "",
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  nodes: [],
  edges: [],
};

const ownership = (owner: "runtime" | "host", phase = "settled") => ({
  domain: "canvas" as const,
  owner,
  epoch: 4n,
  phase,
  reasonCode: "ownership.switch.verified",
  updatedAt: timestamp,
});

/** 只实现网关会调到的那几个方法，其余保持缺席，用到就会炸。 */
function hostClient() {
  const getDocument = vi.fn(async () => {
    const parts = await toCanvasDocument(document, 5n);
    return create(GetCanvasDocumentResponseSchema, {
      document: {
        canvas: parts.canvas,
        nodes: parts.nodes,
        edges: parts.edges,
        annotations: parts.annotations,
      },
    }).document!;
  });
  const saveDocument = vi.fn(async (input: { operationId: string }) => {
    const parts = await toCanvasDocument(document, 6n);
    return create(SaveCanvasDocumentResponseSchema, {
      document: create(CanvasDocumentSchema, { canvas: parts.canvas }),
      receipt: {
        operationId: input.operationId,
        revisions: [
          {
            kind: CanvasEntityKind.CANVAS,
            entityId: boardId,
            revision: 6n,
          },
        ],
      },
    });
  });
  const client = { getDocument, saveDocument } as unknown as HostCanvasClient;
  return { client, getDocument, saveDocument };
}

beforeEach(() => {
  canvasOwnership.mockReset();
  loadBoard.mockReset();
  saveBoard.mockReset();
  deleteBoard.mockReset();
  loadBoard.mockResolvedValue(document);
  saveBoard.mockResolvedValue(document);
  deleteBoard.mockResolvedValue(undefined);
  resetCanvasRevisions();
});

afterEach(() => {
  setCanvasHostResolver(null);
  useCanvasOwnership.getState().reset();
});

describe("画布网关按归属路由", () => {
  it("Runtime 在写时读写都走 Runtime，一次都不碰 Host", async () => {
    canvasOwnership.mockResolvedValue(ownership("runtime"));
    const host = hostClient();
    setCanvasHostResolver(async () => host.client);

    await canvasGateway.loadBoard(workspaceId, boardId);
    await canvasGateway.saveBoard(workspaceId, boardId, document);

    expect(loadBoard).toHaveBeenCalledTimes(1);
    expect(saveBoard).toHaveBeenCalledTimes(1);
    expect(host.getDocument).not.toHaveBeenCalled();
    expect(host.saveDocument).not.toHaveBeenCalled();
  });

  it("Host 在写时读写都走 Host，一次都不碰 Runtime", async () => {
    canvasOwnership.mockResolvedValue(ownership("host"));
    const host = hostClient();
    setCanvasHostResolver(async () => host.client);

    const loaded = await canvasGateway.loadBoard(workspaceId, boardId);
    expect(loaded.board.id).toBe(boardId);
    await canvasGateway.saveBoard(workspaceId, boardId, document);

    expect(host.getDocument).toHaveBeenCalledWith(boardId);
    expect(host.saveDocument).toHaveBeenCalledTimes(1);
    expect(loadBoard).not.toHaveBeenCalled();
    expect(saveBoard).not.toHaveBeenCalled();
  });

  it("Host 保存带上读到的 revision 与可重放的操作 id", async () => {
    canvasOwnership.mockResolvedValue(ownership("host"));
    const host = hostClient();
    setCanvasHostResolver(async () => host.client);

    await canvasGateway.loadBoard(workspaceId, boardId);
    await canvasGateway.saveBoard(workspaceId, boardId, document);
    const first = host.saveDocument.mock.calls[0]![0] as unknown as {
      operationId: string;
      expectedRevision: bigint;
    };
    expect(first.expectedRevision).toBe(5n);
    expect(first.operationId).toBe(`canvas/${workspaceId}/${boardId}/5`);

    // 回执把画布推到 6：下一次 CAS 必须报 6，否则会拿旧版去覆盖。
    await canvasGateway.saveBoard(workspaceId, boardId, document);
    const second = host.saveDocument.mock.calls[1]![0] as unknown as {
      expectedRevision: bigint;
    };
    expect(second.expectedRevision).toBe(6n);
  });

  it("维护窗口里写被挡下，读仍然回 Runtime", async () => {
    canvasOwnership.mockResolvedValue(ownership("runtime", "switching"));
    const host = hostClient();
    setCanvasHostResolver(async () => host.client);

    await expect(
      canvasGateway.saveBoard(workspaceId, boardId, document),
    ).rejects.toBeInstanceOf(CanvasReadOnlyError);
    await expect(
      canvasGateway.deleteBoard(workspaceId, boardId),
    ).rejects.toBeInstanceOf(CanvasReadOnlyError);
    expect(saveBoard).not.toHaveBeenCalled();
    expect(deleteBoard).not.toHaveBeenCalled();
    expect(host.saveDocument).not.toHaveBeenCalled();

    await expect(
      canvasGateway.loadBoard(workspaceId, boardId),
    ).resolves.toEqual(document);
  });

  it("探测失败时同样禁写", async () => {
    canvasOwnership.mockRejectedValue(new Error("unreachable"));
    await expect(
      canvasGateway.saveBoard(workspaceId, boardId, document),
    ).rejects.toMatchObject({ status: "error" });
    expect(saveBoard).not.toHaveBeenCalled();
  });

  /**
   * 探测失败是一次请求丢了，不是一个判决。下一次保存要重新探，否则一次网络
   * 抖动就把画布锁成只读，直到有人去点横幅上的按钮。
   */
  it("探测失败后下一次保存会重探并恢复", async () => {
    canvasOwnership
      .mockRejectedValueOnce(new Error("unreachable"))
      .mockResolvedValue(ownership("runtime"));

    await expect(
      canvasGateway.saveBoard(workspaceId, boardId, document),
    ).rejects.toBeInstanceOf(CanvasReadOnlyError);
    expect(saveBoard).not.toHaveBeenCalled();

    await canvasGateway.saveBoard(workspaceId, boardId, document);
    expect(saveBoard).toHaveBeenCalledTimes(1);
    expect(useCanvasOwnership.getState().status).toBe("runtime");
  });

  /**
   * `ownership_moved` 不是「再试一次」。重试只会撞上同一堵墙，而且写方
   * 已经换人了——正确动作是重新探归属，再由上层决定走哪边。
   */
  it("ownership_moved 触发重探而不是重试", async () => {
    canvasOwnership
      .mockResolvedValueOnce(ownership("runtime"))
      .mockResolvedValueOnce(ownership("host"));
    saveBoard.mockRejectedValue(
      new RuntimeRequestError(409, "canvas moved", "ownership_moved"),
    );

    await expect(
      canvasGateway.saveBoard(workspaceId, boardId, document),
    ).rejects.toBeInstanceOf(CanvasOwnershipMovedError);

    expect(saveBoard).toHaveBeenCalledTimes(1);
    expect(canvasOwnership).toHaveBeenCalledTimes(2);
    expect(useCanvasOwnership.getState().status).toBe("host");
  });

  it("ownership_moved 不被当成 CAS 冲突去变基", async () => {
    canvasOwnership.mockResolvedValue(ownership("runtime"));
    saveBoard.mockRejectedValue(
      new RuntimeRequestError(409, "canvas moved", "ownership_moved"),
    );
    const failure = await canvasGateway
      .saveBoard(workspaceId, boardId, document)
      .catch((error: unknown) => error);
    expect(isCanvasConflict(failure)).toBe(false);
    // 普通 409 仍然是冲突，自动变基那条路不能被这次改动堵上。
    expect(isCanvasConflict(new RuntimeRequestError(409, "stale"))).toBe(true);
  });

  it("Host 的 CONFLICT 也算冲突", () => {
    expect(
      isCanvasConflict({ name: "HostCanvasError", failure: "conflict" }),
    ).toBe(true);
    expect(
      isCanvasConflict({ name: "HostCanvasError", failure: "network" }),
    ).toBe(false);
  });
});
