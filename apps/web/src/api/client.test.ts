import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardDocument } from "@ai-coding-canvas/shared";
import {
  RuntimeConnectionError,
  agentWebSocketUrl,
  runtimeApi,
  terminalWebSocketUrl,
} from "./client";

const timestamp = "2026-08-13T00:00:00.000Z";
const workspaceId = "019ff7d1-0d12-7421-833d-2c5e8d64ed21";
const boardId = "019ff7d1-7419-74df-89e2-b1619d36ea7d";

function stubJson(payload: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => payload,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const boardDocument: BoardDocument = {
  board: {
    id: boardId,
    workspaceId,
    name: "Default",
    sortOrder: 0,
    viewport: { x: 12, y: -8, zoom: 0.75 },
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  nodes: [],
  edges: [],
  strokes: [],
};

describe("Runtime API connection errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("turns WebKit Load failed into an actionable Runtime error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Load failed")),
    );

    const error = await runtimeApi.health().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(RuntimeConnectionError);
    expect(error).toMatchObject({
      message: expect.stringContaining("无法连接本地 Runtime"),
      endpoint: "http://127.0.0.1:43120",
    });
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("expected an Error");
    expect(error.message).not.toContain("Load failed");
  });

  it("surfaces the runtime error message instead of a status code", async () => {
    stubJson({ code: "conflict", message: "看板已被其他窗口修改" }, false, 409);

    await expect(runtimeApi.loadBoard(workspaceId, boardId)).rejects.toThrow(
      "看板已被其他窗口修改",
    );
  });
});

describe("board routes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves a board with the CAS timestamp, strokes and viewport", async () => {
    const fetchMock = stubJson(boardDocument);

    await runtimeApi.saveBoard(workspaceId, boardId, boardDocument);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `http://127.0.0.1:43120/api/workspaces/${workspaceId}/boards/${boardId}/document`,
    );
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      expectedUpdatedAt: timestamp,
      nodes: [],
      edges: [],
      strokes: [],
      viewport: { x: 12, y: -8, zoom: 0.75 },
    });
  });

  it("loads a board document and keeps its persisted viewport", async () => {
    stubJson(boardDocument);

    const loaded = await runtimeApi.loadBoard(workspaceId, boardId);
    expect(loaded.board.viewport).toEqual({ x: 12, y: -8, zoom: 0.75 });
    expect(loaded.strokes).toEqual([]);
  });

  it("tolerates an empty body when deleting a board", async () => {
    const fetchMock = stubJson(null);

    await expect(
      runtimeApi.deleteBoard(workspaceId, boardId),
    ).resolves.toBeUndefined();
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].method).toBe(
      "DELETE",
    );
  });
});

describe("git and gateway routes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the path list when staging", async () => {
    const fetchMock = stubJson({ staged: ["src/App.tsx"] });

    const result = await runtimeApi.gitStage(workspaceId, ["src/App.tsx"]);

    expect(result.staged).toEqual(["src/App.tsx"]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/api/workspaces/${workspaceId}/git/stage`);
    expect(JSON.parse(String(init.body))).toEqual({ paths: ["src/App.tsx"] });
  });

  it("rejects an empty revert before touching the network", async () => {
    const fetchMock = stubJson({ reverted: [] });

    expect(() => runtimeApi.gitRevert(workspaceId, [])).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes git diff statuses to the diff node vocabulary", async () => {
    stubJson({
      repository: true,
      clean: false,
      files: [
        {
          path: "src/App.tsx",
          status: "M",
          additions: 3,
          deletions: 1,
          patch: "",
        },
      ],
    });

    const diff = await runtimeApi.gitDiff(workspaceId);
    expect(diff.files[0]?.status).toBe("M");
  });

  it("scopes the gateway query to a workspace", async () => {
    const fetchMock = stubJson({
      enabled: false,
      port: 7420,
      addresses: [],
      devices: [],
      implemented: false,
    });

    const status = await runtimeApi.gatewayStatus(workspaceId);
    expect(status).toMatchObject({ enabled: false, implemented: false });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://127.0.0.1:43120/api/gateway?workspaceId=${workspaceId}`,
    );
  });

  it("defaults a terminal without a reported pid to null", async () => {
    stubJson({
      id: "019ff7d1-ab76-728d-be18-3acfd6181af8",
      workspaceId,
      cwd: "/tmp/one",
      shell: "/bin/zsh",
      command: null,
      status: "running",
      exitCode: null,
      createdAt: timestamp,
      endedAt: null,
    });

    const session = await runtimeApi.getTerminal(
      "019ff7d1-ab76-728d-be18-3acfd6181af8",
    );
    expect(session.pid).toBeNull();
  });
});

describe("websocket urls", () => {
  it("keeps the runtime origin and upgrades the scheme", () => {
    expect(terminalWebSocketUrl("abc")).toBe(
      "ws://127.0.0.1:43120/api/terminals/abc/ws",
    );
    expect(agentWebSocketUrl("abc")).toBe(
      "ws://127.0.0.1:43120/api/agents/abc/ws",
    );
  });
});
