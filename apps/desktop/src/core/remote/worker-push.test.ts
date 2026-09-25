/**
 * 第一批之后补上的远端能力：Git 长操作与它推回来的进度、集成状态与工作树绑定、
 * 以及两台机器各跑一半的 AI 提交信息。
 *
 * 与 `execution.test.ts` 同一个办法：core 的真入口打成包，本机子进程跑
 * `worker --stdio`，控制端经同一套帧、握手与推送
 * 和它说话，不需要 sshd。推送帧经 `remotePushed` 进各域，与远端域装配时一样。
 */

import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
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
import { temporary, type Temporary } from "../files/workspace.fixture";
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
import type { SshHost } from "../settings/ssh-hosts";
import { type Fixture, fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import { createRemoteWorkspace } from "../workspaces/table";
import {
  type RemoteChannel,
  executeOn,
  remoteConnected,
  remoteDisconnected,
  remotePushed,
  setRemoteCaller,
} from "./execute";
import { RemoteGitOperations } from "./git-operations";
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

beforeAll(async () => {
  start = await spawnWorker();
}, 120_000);

afterAll(() => {
  setRemoteCaller(undefined);
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
