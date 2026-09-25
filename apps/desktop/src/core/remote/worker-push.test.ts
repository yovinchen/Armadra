/**
 * 第一批之后补上的远端能力：Git 长操作与它推回来的进度、集成状态与工作树绑定、
 * 两台机器各跑一半的 AI 提交信息、Worker 侧推送的文件监听、一轮读取的远端资源，
 * 以及承载语言服务的第二条连接。
 *
 * 与 `execution.test.ts` 同一个办法：core 的真入口打成包，本机子进程跑
 * `worker --stdio`（语言连接加 `--language-link`），控制端经同一套帧、握手与推送
 * 和它说话，不需要 sshd。推送帧经 `remotePushed` 进各域，与远端域装配时一样。
 */

import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, writeFileSync } from "node:fs";
import { type Socket, connect } from "node:net";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { WebSocket } from "ws";
import { temporary, type Temporary } from "../files/workspace.fixture";
import { install as installFiles } from "../files/routes";
import { install as installGit } from "../git";
import {
  cleanupFixtures,
  repositoryAt,
  temporaryDirectory,
} from "../git/fixture";
import {
  generateFrom,
  type Capture,
  type GitMessageSource,
} from "../git/message";
import type { OperationSnapshot } from "../git/repository/types";
import { MOCK_LSP } from "../language/fixture";
import { RemoteLanguage } from "../language/remote";
import { RemoteResources } from "../resources/remote";
import type { SshHost } from "../settings/ssh-hosts";
import { type Fixture, fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import { type Workspace, createRemoteWorkspace } from "../workspaces/table";
import {
  type RemoteChannel,
  executeOn,
  remoteConnected,
  remoteDisconnected,
  remotePushed,
  setLanguageCaller,
  setRemoteCaller,
} from "./execute";
import { RemoteGitOperations } from "./git-operations";
import { LANGUAGE_CAPABILITY } from "./language";
import type { RemoteResourceRead } from "./resources-worker";
import { remoteWatches } from "./watch";
import { RemoteWorker } from "./worker";
import { disposeWorkerBundle, spawnWorker } from "./worker.fixture";

const HOST: SshHost = {
  id: "far",
  name: "far",
  host: "far.example",
  worker: { path: "/opt/armadra/bin/armadra-core" },
};

const usableNode = async () => ({
  version: "v24.0.0",
  major: 24,
  usable: true,
  detail: "",
});

/** 与远端域装配时一样：推送与起落都交给事件口。 */
function worker(
  start: () => ChildProcess,
  channel: RemoteChannel = "control",
): RemoteWorker {
  return new RemoteWorker({
    dataDir: "/nonexistent",
    host: HOST,
    worker: HOST.worker as NonNullable<SshHost["worker"]>,
    askpass: {} as never,
    version: "0.1.0",
    spawn: start,
    node: usableNode,
    languageLink: channel === "language",
    onEvent: (event) => remotePushed(HOST.id, channel, event),
    onConnected: () => remoteConnected(HOST.id, channel),
    onDisconnected: () => remoteDisconnected(HOST.id, channel),
  });
}

async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

let start: () => ChildProcess;
let startLanguage: () => ChildProcess;

beforeAll(async () => {
  start = await spawnWorker();
  startLanguage = await spawnWorker(["--language-link"]);
}, 120_000);

afterAll(() => {
  setRemoteCaller(undefined);
  setLanguageCaller(undefined);
  disposeWorkerBundle();
  cleanupFixtures();
});

describe("repository operations on a remote workspace", () => {
  let core: Fixture;
  let remote: RemoteWorker;
  let far: Temporary;
  let id: string;

  beforeEach(() => {
    core = fixture([installWorkspaces, installGit]);
    far = temporary("armadra-far-ops-");
    remote = worker(start);
    setRemoteCaller(async (_hostId, operation, payload, replay) =>
      remote.request(operation, payload, replay),
    );
    id = createRemoteWorkspace(core.database, {
      name: "far-ops",
      executionHostId: HOST.id,
      rootPath: far.path,
      permissions: { read: true, write: true, execute: true },
    }).id;
  });
  afterEach(() => {
    setRemoteCaller(undefined);
    remote.close();
    far.remove();
    core.close();
  });

  it("queues an operation on the execution host and follows its pushed progress", async () => {
    const repo = repositoryAt(far.path);
    const started = await core.call(
      "POST",
      `/api/workspaces/${id}/git/repository/operations`,
      {
        path: ".",
        action: {
          kind: "createBranch",
          name: "topic",
          startPoint: null,
          switch: false,
        },
        expected: {
          headOid: repo.git("rev-parse", "HEAD").trim(),
          branch: repo.git("branch", "--show-current").trim(),
        },
      },
    );
    expect(started.status).toBe(200);
    const operationId = (started.body as OperationSnapshot).id;

    // 面板照旧轮询；答的是 Worker 推来的那一帧，结局到了就是终态。
    const finished = await until(async () => {
      const polled = await core.call(
        "GET",
        `/api/workspaces/${id}/git/repository/operations/${operationId}`,
      );
      const snapshot = polled.body as OperationSnapshot;
      return snapshot.state === "succeeded" ? snapshot : undefined;
    });
    expect(finished.progress).toBe(100);
    expect(repo.git("branch", "--list", "topic").trim()).toContain("topic");

    const listed = await core.call(
      "GET",
      `/api/workspaces/${id}/git/repository/operations?path=.`,
    );
    expect(
      (listed.body as OperationSnapshot[]).map((entry) => entry.id),
    ).toEqual([operationId]);
    // 已结束的操作取消是无操作，答同一个终态。
    const cancelled = await core.call(
      "POST",
      `/api/workspaces/${id}/git/repository/operations/${operationId}/cancel`,
    );
    expect((cancelled.body as OperationSnapshot).state).toBe("succeeded");

    // 别的工作空间看不到它。
    const elsewhere = temporary("armadra-far-other-");
    try {
      const other = createRemoteWorkspace(core.database, {
        name: "other",
        executionHostId: HOST.id,
        rootPath: elsewhere.path,
      }).id;
      const foreign = await core.call(
        "GET",
        `/api/workspaces/${other}/git/repository/operations/${operationId}`,
      );
      expect(foreign.status).toBe(404);
    } finally {
      elsewhere.remove();
    }
  }, 60_000);

  it("reads integration state and verifies a worktree binding on the execution host", async () => {
    repositoryAt(far.path);
    const integration = await core.call(
      "GET",
      `/api/workspaces/${id}/git/repository/integration?path=.`,
    );
    expect(integration.status).toBe(200);
    expect(integration.body).toMatchObject({ owned: false, sessionId: null });

    const binding = await core.call(
      "POST",
      `/api/workspaces/${id}/git/repository/worktree-binding`,
      { worktreePath: "." },
    );
    expect(binding.status).toBe(200);
    expect(binding.body).toMatchObject({ valid: true, code: "ok" });
  }, 60_000);

  it.skipIf(process.platform === "win32")(
    "captures the staged source on the execution host and drafts here",
    async () => {
      const repo = repositoryAt(far.path);
      repo.write("src/far.ts", "export const far = 1;\n");
      repo.git("add", "-A");
      const target = { rootPath: far.path, executionHostId: HOST.id };
      const reads = {
        capture: async () =>
          (await executeOn(target, "git.messageCapture", {
            execute: true,
          })) as Capture,
        source: async () =>
          (await executeOn(target, "git.messageSource", {
            execute: true,
          })) as GitMessageSource,
      };
      const captured = await reads.source();
      const binary = join(temporaryDirectory("remote-claude"), "claude");
      writeFileSync(
        binary,
        [
          "#!/bin/sh",
          'if [ "$1" = "--help" ]; then',
          "  echo '--bare --tools --strict-mcp-config --mcp-config --disable-slash-commands --setting-sources --no-session-persistence --output-format --max-budget-usd'",
          "  exit 0",
          "fi",
          "cat > /dev/null",
          `echo '{"type":"result","subtype":"success","is_error":false,"result":"feat: add far"}'`,
        ].join("\n"),
      );
      chmodSync(binary, 0o755);
      const draft = await generateFrom(
        reads,
        {
          provider: "claude-bare",
          expectedHead: captured.expectedHead,
          indexDigest: captured.indexDigest,
          language: "en",
          conventional: true,
        },
        { binary, key: "k", endpointSupported: true, timeoutMs: 10_000 },
      );
      expect(draft.message).toBe("feat: add far");
      expect(draft.includedFiles).toEqual(["src/far.ts"]);
    },
    60_000,
  );
});

describe("the controller's mirror of a remote operation", () => {
  it("settles what was in flight when the link dropped instead of leaving it running", async () => {
    const mirror = new RemoteGitOperations();
    let next = 0;
    const snapshot = (id: string): OperationSnapshot =>
      ({
        id,
        repositoryId: "r",
        workspaceRoot: "/w",
        repositoryPath: "/w",
        action: { kind: "fetch" },
        state: "queued",
        cancellationRequested: false,
        progress: 0,
        createdAt: "2026-09-26T00:00:00Z",
        finishedAt: null,
        message: null,
      }) as unknown as OperationSnapshot;
    setRemoteCaller(async () => snapshot(`op-${(next += 1)}`));
    try {
      const target = { rootPath: "/w", executionHostId: HOST.id };
      const args = {
        path: ".",
        action: { kind: "fetch" } as never,
        expected: { headOid: null, branch: null },
        execute: true,
      };
      const queued = await mirror.start(target, "ws", args);
      const running = await mirror.start(target, "ws", args);
      remotePushed(HOST.id, "control", {
        type: "git.operation",
        snapshot: { ...running, state: "running", progress: 40 },
      });
      expect(mirror.snapshot("ws", running.id).progress).toBe(40);

      remoteDisconnected(HOST.id, "control");
      expect(mirror.snapshot("ws", queued.id).state).toBe("cancelled");
      expect(mirror.snapshot("ws", running.id).state).toBe("unknownOutcome");
      // 晚到的一帧不能把终态改回去。
      remotePushed(HOST.id, "control", {
        type: "git.operation",
        snapshot: { ...running, state: "running", progress: 90 },
      });
      expect(mirror.snapshot("ws", running.id).state).toBe("unknownOutcome");
      expect(() => mirror.snapshot("other", running.id)).toThrow();
    } finally {
      setRemoteCaller(undefined);
      mirror.dispose();
    }
  });
});

describe("watching remote files", () => {
  let core: Fixture;
  let remote: RemoteWorker;
  let far: Temporary;
  let id: string;

  beforeEach(() => {
    core = fixture([installWorkspaces, installFiles]);
    far = temporary("armadra-far-watch-");
    remote = worker(start);
    setRemoteCaller(async (_hostId, operation, payload, replay) =>
      remote.request(operation, payload, replay),
    );
    id = createRemoteWorkspace(core.database, {
      name: "far-watch",
      executionHostId: HOST.id,
      rootPath: far.path,
    }).id;
  });
  afterEach(() => {
    remoteWatches.releaseWorkspace(id);
    setRemoteCaller(undefined);
    remote.close();
    far.remove();
    core.close();
  });

  it("is told of a change by the worker's own watcher, and survives a dropped link", async () => {
    writeFileSync(join(far.path, "pushed.txt"), "one");
    const events: Record<string, unknown>[] = [];
    core.bus.on("workspace.event", ({ event }) =>
      events.push(event as unknown as Record<string, unknown>),
    );
    const registered = await core.call(
      "POST",
      `/api/workspaces/${id}/file-watch`,
      { path: "pushed.txt", nodeId: "node-1" },
    );
    expect(registered.body).toMatchObject({
      status: "watching",
      mode: "events",
    });

    writeFileSync(join(far.path, "pushed.txt"), "two");
    // 没有人调 `poll`：变化是 Worker 推过来的。
    await until(() =>
      events.find(
        (event) =>
          event.type === "file.changed" &&
          event.path === "pushed.txt" &&
          event.kind === "modified",
      ),
    );

    // 连接断了：先退回轮询。轮询的请求把连接拉起来，握手之后整组重登回推送，
    // 断线期间的改动在重登时比对出来。
    remote.resume();
    expect(remoteWatches.modeOf(id)).toBe("poll");
    events.length = 0;
    writeFileSync(join(far.path, "pushed.txt"), "three");
    await remoteWatches.poll(id);
    await until(() =>
      remoteWatches.modeOf(id) === "events" ? true : undefined,
    );
    await until(() =>
      events.find(
        (event) => event.type === "file.changed" && event.path === "pushed.txt",
      ),
    );
  }, 60_000);
});

describe("remote resources", () => {
  let remote: RemoteWorker;
  let sshd: ChildProcess | undefined;
  let client: Socket | undefined;

  beforeEach(() => {
    remote = worker(start);
    setRemoteCaller(async (_hostId, operation, payload, replay) =>
      remote.request(operation, payload, replay),
    );
  });
  afterEach(() => {
    client?.destroy();
    sshd?.kill();
    setRemoteCaller(undefined);
    remote.close();
  });

  it.skipIf(process.platform === "win32")(
    "finds a session's tree by its connection and measures it in one round",
    async () => {
      // 一个替身 `sshd`：接受连接后派生一个子进程，就像真的 sshd 派生登录 shell。
      const script = `
        const net = require("node:net");
        const { spawn } = require("node:child_process");
        const server = net.createServer(() => {
          spawn("sleep", ["30"], { stdio: "ignore" });
        });
        server.listen(0, "127.0.0.1", () => {
          process.stdout.write(String(server.address().port) + "\\n");
        });
      `;
      sshd = spawn(process.execPath, ["-e", script], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      const port = await new Promise<number>((resolve) => {
        sshd?.stdout?.once("data", (chunk: Buffer) =>
          resolve(Number(chunk.toString("utf8").trim())),
        );
      });
      client = connect(port, "127.0.0.1");
      await new Promise((resolve) => client?.once("connect", resolve));
      const clientPort = client.localPort as number;
      // 让替身把子进程派生出来。
      await new Promise((resolve) => setTimeout(resolve, 300));

      const read = async () =>
        (await remote.request(
          "resources.read",
          {
            root: "/",
            args: {
              sessions: [
                { sessionId: "matched", clientPort },
                { sessionId: "unmatched", clientPort: 1 },
                { sessionId: "unknown", clientPort: null },
              ],
            },
          },
          true,
        )) as RemoteResourceRead;
      const first = await read();
      expect(first.host.memory.totalBytes).toBeGreaterThan(0);
      const matched = first.sessions.find(
        (entry) => entry.sessionId === "matched",
      );
      expect(matched?.pid).toBe(sshd.pid);
      expect(matched?.memoryBytes).toBeGreaterThan(0);
      expect(matched?.childCount).toBeGreaterThanOrEqual(1);
      // 第一轮没有 CPU 基线：是 `null`，不是 0。
      expect(first.host.cpuPercent).toBeNull();
      for (const sessionId of ["unmatched", "unknown"]) {
        const row = first.sessions.find(
          (entry) => entry.sessionId === sessionId,
        );
        expect(row?.memoryBytes).toBeNull();
        expect(row?.unknownReason).toBe("remote");
      }

      await new Promise((resolve) => setTimeout(resolve, 300));
      const second = await read();
      expect(second.host.cpuPercent).not.toBeNull();
      expect(
        second.sessions.find((entry) => entry.sessionId === "matched")
          ?.cpuPercent,
      ).not.toBeNull();
    },
    60_000,
  );

  it("hands out a host overview only after a round has come back, and nothing once unreadable", async () => {
    const cache = new RemoteResources();
    expect(cache.host(HOST.id)).toBeUndefined();
    await cache.settled();
    const overview = cache.host(HOST.id);
    expect(overview).toMatchObject({ hostId: HOST.id, location: "remote" });
    expect(overview?.memory.totalBytes).toBeGreaterThan(0);

    // 读不到时不留旧数。
    setRemoteCaller(async () => {
      throw new Error("host is gone");
    });
    let now = Date.now() + 5_000;
    const later = new RemoteResources(() => now);
    later.host(HOST.id);
    await later.settled();
    now += 5_000;
    expect(later.host(HOST.id)).toBeUndefined();
  }, 60_000);
});

/** 只用到 `send` / `close` / 事件的替身 socket。 */
class FakeSocket extends EventEmitter {
  readonly sent: string[] = [];
  closed: number | undefined;
  send(body: string): void {
    this.sent.push(body);
  }
  close(code?: number): void {
    this.closed = code ?? 1000;
  }
}

describe("the language link", () => {
  let link: RemoteWorker;
  let language: RemoteLanguage;
  let root: Temporary;
  const published: Record<string, unknown>[] = [];

  beforeEach(() => {
    root = temporary("armadra-far-language-");
    link = worker(startLanguage, "language");
    setLanguageCaller(async (_hostId, action, payload, replay) =>
      link.request(action, payload, replay),
    );
    language = new RemoteLanguage();
    language.attachSink({
      publish: (_workspaceId, event) => published.push(event),
      fileChanged: () => {},
    });
    published.length = 0;
  });
  afterEach(() => {
    language.dispose();
    setLanguageCaller(undefined);
    link.close();
    root.remove();
  });

  it("runs the server on the execution host and carries its messages both ways", async () => {
    writeFileSync(join(root.path, "notes.md"), "line\nTODO here\n");
    const workspace = {
      id: "ws-far",
      name: "far",
      rootPath: root.path,
      color: "#000",
      permissions: { read: true, write: true, execute: true },
      executionHostId: HOST.id,
      lastOpenedAt: "",
      createdAt: "",
      updatedAt: "",
    } as Workspace;
    const settings = {
      servers: { marksman: { path: process.execPath, args: [MOCK_LSP] } },
    };

    const probe = await link.probe();
    expect(probe.capabilities.has(LANGUAGE_CAPABILITY)).toBe(true);

    const listed = await language.service(workspace, HOST.id, settings, false);
    expect(listed.executionHostId).toBe(HOST.id);
    expect(
      listed.servers.find((row) => row.serverId === "marksman")?.state,
    ).toBe("available");

    const opened = await language.open(
      workspace,
      HOST.id,
      settings,
      "markdown",
      "node-1",
    );
    expect(opened.state).toBe("running");
    expect(language.awaitingSocket(opened.sessionId)).toBe(true);

    const socket = new FakeSocket();
    expect(
      language.attach(
        workspace.id,
        opened.sessionId,
        socket as unknown as WebSocket,
      ),
    ).toBe(true);
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "textDocument/didOpen",
          params: {
            textDocument: {
              uri: "armadra:///notes.md",
              languageId: "markdown",
              version: 1,
              text: "line\nTODO here\n",
            },
          },
        }),
      ),
      false,
    );
    const diagnostics = await until(() =>
      socket.sent.find((body) => body.includes("publishDiagnostics")),
    );
    expect(diagnostics).toContain("armadra:///notes.md");
    // 远端的绝对路径不出执行主机。
    expect(diagnostics).not.toContain(root.path);

    // 语言连接断了：会话被告知 `link_lost`，socket 关掉让编辑器重连。
    link.resume();
    await until(() => (socket.closed === undefined ? undefined : true));
    expect(socket.closed).toBe(1011);
    expect(published).toContainEqual(
      expect.objectContaining({
        type: "language.session",
        sessionId: opened.sessionId,
        state: "disconnected",
        reason: "link_lost",
      }),
    );
    expect(language.has(workspace.id, opened.sessionId)).toBe(false);
  }, 60_000);

  it("says the link is lost, per language, when the host cannot be reached", async () => {
    setLanguageCaller(async () => {
      throw Object.assign(new Error("unreachable"), {
        status: 503,
        code: "unavailable",
      });
    });
    const status = await language.service(
      {
        id: "ws-x",
        rootPath: root.path,
        permissions: { read: true, write: true, execute: true },
      } as Workspace,
      HOST.id,
      {},
      false,
    );
    expect(status.status).toBe("unavailable");
    expect(status.reason).toBe("link_lost");
    expect(status.servers.every((row) => row.state === "disconnected")).toBe(
      true,
    );
  });
});
