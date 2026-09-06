import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const languageService = vi.fn();
const openLanguageSession = vi.fn();
const closeLanguageSession = vi.fn((..._args: unknown[]) =>
  Promise.resolve({}),
);

vi.mock("@/api/client", () => ({
  RuntimeRequestError: class RuntimeRequestError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
  runtimeApi: {
    languageService: (...args: unknown[]) => languageService(...args),
    openLanguageSession: (...args: unknown[]) => openLanguageSession(...args),
    closeLanguageSession: (...args: unknown[]) => closeLanguageSession(...args),
  },
  languageSessionUrl: (workspaceId: string, sessionId: string) =>
    `ws://runtime/api/workspaces/${workspaceId}/language/sessions/${sessionId}/stream`,
}));
vi.mock("@/files/open-editor", () => ({ openFileInEditor: vi.fn() }));

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import {
  acquireLanguageClient,
  resetLanguageClients,
  type LanguageClient,
} from "./client";
import { useDiagnosticsStore } from "./diagnostics-store";
import { fakeSocketFactory, lastSocket, resetSockets } from "./fake-socket";
import { useLanguageStatusStore } from "./status-store";

/**
 * 会话的一整条路（语言服务设计 §2.9、§5 批次 C）。
 *
 * 一个脚本化的假 server：`initialize` 由 Runtime 侧代答，所以这里也是测试
 * 直接回；诊断按 `publishDiagnostics` 推。断言的是三件事：会话开在哪、
 * `didOpen` 送出去的是不是 `armadra:///` 的 uri、诊断有没有同时进 store
 * 和视图。
 */

const CAPABILITIES = {
  textDocumentSync: 2,
  hoverProvider: true,
  renameProvider: true,
  documentFormattingProvider: true,
};

function session(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "s1",
    generation: 1,
    serverId: "ruff",
    state: "running",
    serverCapabilities: CAPABILITIES,
    ...overrides,
  };
}

/** 让排好的微任务跑完。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 代答 `initialize`。
 *
 * 真实路径上答话的是 Runtime 的会话（它用缓存的 server capabilities 代答，
 * 设计 §2.2 `session`）。id 从客户端刚发出的那条里读——重连之后 `LSPClient`
 * 的请求编号是接着数的，写死 1 只在第一次对。
 */
function answerInitialize(socket: ReturnType<typeof lastSocket>): void {
  const sent = socket!.sent.map(
    (raw) => JSON.parse(raw) as { id?: number; method?: string },
  );
  const request = sent
    .filter((message) => message.method === "initialize")
    .at(-1);
  socket!.receive({
    jsonrpc: "2.0",
    id: request?.id,
    result: { capabilities: CAPABILITIES },
  });
}

let views: EditorView[] = [];

function open(client: LanguageClient, uri: string, doc: string): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [client.plugin(uri)] }),
  });
  views.push(view);
  return view;
}

beforeEach(() => {
  resetSockets();
  languageService.mockReset().mockResolvedValue({
    status: "available",
    executionHostId: "local",
    servers: [],
  });
  openLanguageSession.mockReset().mockResolvedValue(session());
  closeLanguageSession.mockClear();
  useDiagnosticsStore.setState({ byUri: {} });
  useLanguageStatusStore.setState({ sessions: {}, servers: {}, stderr: {} });
});

afterEach(() => {
  for (const view of views) view.destroy();
  views = [];
  resetLanguageClients();
});

describe("language client", () => {
  it("opens one session per workspace and language, and shares it", async () => {
    const first = acquireLanguageClient("w1", "python", fakeSocketFactory);
    const second = acquireLanguageClient("w1", "python", fakeSocketFactory);
    await settle();

    expect(openLanguageSession).toHaveBeenCalledTimes(1);
    expect(first.client).toBe(second.client);
    expect(lastSocket()!.url).toContain(
      "/api/workspaces/w1/language/sessions/s1/stream",
    );

    // 还有一个节点开着，会话不关。
    first.release();
    expect(closeLanguageSession).not.toHaveBeenCalled();
    second.release();
    expect(closeLanguageSession).toHaveBeenCalledWith("w1", "s1");
  });

  it("answers unsupported without opening a socket", async () => {
    openLanguageSession.mockResolvedValue(
      session({
        state: "unsupported",
        reason: "server_not_found",
        serverCapabilities: undefined,
      }),
    );
    const { client } = acquireLanguageClient("w1", "rust", fakeSocketFactory);
    await settle();

    expect(lastSocket()).toBeUndefined();
    expect(client.status.state).toBe("unsupported");
    expect(client.status.reason).toBe("server_not_found");
    // 没有会话就没有扩展——不注册补全源，不出现一个永远为空的列表。
    expect(client.plugin("armadra:///src/main.rs")).toEqual([]);
  });

  it("sends didOpen with a workspace-relative uri, never a path", async () => {
    const { client } = acquireLanguageClient("w1", "python", fakeSocketFactory);
    await settle();
    const socket = lastSocket()!;
    socket.open();
    answerInitialize(socket);
    await settle();

    open(client, "armadra:///src/main.py", "import os\n");
    await settle();

    const [didOpen] = socket.sentMethod("textDocument/didOpen");
    expect(didOpen).toBeDefined();
    const params = didOpen!.params as {
      textDocument: { uri: string; text: string };
    };
    expect(params.textDocument.uri).toBe("armadra:///src/main.py");
    expect(params.textDocument.text).toBe("import os\n");
    // 抓包里不该出现绝对路径（§6.1 第 10 条的 Web 侧对应物）。
    expect(socket.sent.join("")).not.toContain("file://");
  });

  it("puts published diagnostics in the store and on the view", async () => {
    const { client } = acquireLanguageClient("w1", "python", fakeSocketFactory);
    await settle();
    const socket = lastSocket()!;
    socket.open();
    answerInitialize(socket);
    await settle();
    open(client, "armadra:///src/main.py", "import os\n");
    await settle();

    socket.receive({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: "armadra:///src/main.py",
        // 版本号是执行主机的，与 Web 侧的文档版本无关——官方的
        // `serverDiagnostics()` 会因此丢弃这条，我们的实现不会。
        version: 41,
        diagnostics: [
          {
            range: {
              start: { line: 0, character: 7 },
              end: { line: 0, character: 9 },
            },
            severity: 2,
            code: "F401",
            source: "ruff",
            message: "`os` imported but unused",
          },
        ],
      },
    });
    await settle();

    const stored =
      useDiagnosticsStore.getState().byUri["armadra:///src/main.py"];
    expect(stored).toHaveLength(1);
    expect(stored![0]!.code).toBe("F401");

    // 空数组是「这个文件干净了」，不是「没有消息」：条目要消失。
    socket.receive({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri: "armadra:///src/main.py", diagnostics: [] },
    });
    await settle();
    expect(useDiagnosticsStore.getState().byUri).toEqual({});
  });

  it("reopens a session after the socket drops, and replays didOpen", async () => {
    vi.useFakeTimers();
    try {
      const { client } = acquireLanguageClient(
        "w1",
        "python",
        fakeSocketFactory,
      );
      await vi.advanceTimersByTimeAsync(0);
      const first = lastSocket()!;
      first.open();
      answerInitialize(first);
      await vi.advanceTimersByTimeAsync(0);
      open(client, "armadra:///src/main.py", "import os\n");
      await vi.advanceTimersByTimeAsync(0);
      expect(first.sentMethod("textDocument/didOpen")).toHaveLength(1);

      openLanguageSession.mockResolvedValue(session({ sessionId: "s2" }));
      first.drop();
      expect(client.status.reconnecting).toBe(true);
      // 旧会话的出口在 Runtime 那边随 socket 一起没了，所以重连是开新会话。
      await vi.advanceTimersByTimeAsync(600);
      expect(openLanguageSession).toHaveBeenCalledTimes(2);

      const second = lastSocket()!;
      expect(second).not.toBe(first);
      second.open();
      answerInitialize(second);
      await vi.advanceTimersByTimeAsync(0);
      // 重连之后 server 手里是空的，打开的文件要重新报一遍（§1.3）。
      expect(second.sentMethod("textDocument/didOpen")).toHaveLength(1);
      expect(client.status.reconnecting).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after five attempts and clears the diagnostics it was showing", async () => {
    vi.useFakeTimers();
    try {
      const { client } = acquireLanguageClient(
        "w1",
        "python",
        fakeSocketFactory,
      );
      await vi.advanceTimersByTimeAsync(0);
      useDiagnosticsStore.getState().publish("armadra:///src/main.py", [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          message: "stale",
        },
      ]);

      for (let attempt = 0; attempt < 6; attempt += 1) {
        lastSocket()!.drop();
        await vi.advanceTimersByTimeAsync(10_000);
      }
      expect(client.status.state).toBe("disconnected");
      expect(client.status.reconnecting).toBe(false);
      // 断线之后留着上一次的诊断，就是对着一份可能已经改过的文件显示结论。
      expect(useDiagnosticsStore.getState().byUri).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("opening a session", () => {
  it("probes once per workspace before the first session", async () => {
    // Runtime only launches the absolute path a probe froze. A session sent
    // before the first probe is answered `server_not_found` on a machine that
    // has the server, so discovery has to come first — and once is enough.
    const first = acquireLanguageClient("w1", "python", fakeSocketFactory);
    const second = acquireLanguageClient("w1", "rust", fakeSocketFactory);
    await settle();
    expect(languageService).toHaveBeenCalledTimes(1);
    expect(languageService).toHaveBeenCalledWith("w1");
    expect(openLanguageSession).toHaveBeenCalledTimes(2);
    first.release();
    second.release();
  });

  it("keeps the runtime's own reason when it refuses the session", async () => {
    const { RuntimeRequestError } = await import("@/api/client");
    openLanguageSession.mockRejectedValue(
      new (RuntimeRequestError as new (
        status: number,
        message: string,
      ) => Error)(403, "execution_not_granted"),
    );
    const { client } = acquireLanguageClient("w1", "python", fakeSocketFactory);
    await settle();
    // 「需要执行权限」和「连不上」是两句不同的话。
    expect(client.status).toMatchObject({
      state: "unsupported",
      reason: "execution_not_granted",
    });
  });

  it("falls back to session_failed for a refusal it cannot name", async () => {
    openLanguageSession.mockRejectedValue(new Error("socket hang up"));
    const { client } = acquireLanguageClient("w1", "python", fakeSocketFactory);
    await settle();
    expect(client.status.reason).toBe("session_failed");
  });
});
