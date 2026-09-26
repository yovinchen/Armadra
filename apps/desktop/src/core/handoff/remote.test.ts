/**
 * 远端工作空间的交接：材料经 Worker 在执行主机上采集，不再被拒。
 *
 * 与 `remote/worker-push.test.ts` 同一个办法：core 的真入口打成包，本机子进程跑
 * `worker --stdio`；工作空间行绑在执行主机上，远端调用经记账的包装发给那个
 * Worker，于是能断言交接真的走了 `handoff.capture`，而不是读了本机同名路径。
 */

import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
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
import { type AgentFixture, agentFixture } from "../agent/fixture";
import { setRemoteCaller } from "../remote/execute";
import { RemoteWorker } from "../remote/worker";
import { disposeWorkerBundle, spawnWorker } from "../remote/worker.fixture";
import type { SshHost } from "../settings/ssh-hosts";
import { tempDir } from "../testing/temp-dir";
import { EMPTY_SECTIONS } from "./bundle";
import { capture } from "./capture";
import { prepare } from "./store";

const HOST: SshHost = {
  id: "far",
  name: "far",
  host: "far.example",
  worker: { path: "/opt/armadra/bin/armadra-core" },
};

let start: () => ChildProcess;

beforeAll(async () => {
  start = await spawnWorker();
}, 120_000);

afterAll(() => {
  setRemoteCaller(undefined);
  disposeWorkerBundle();
});

describe("a handoff on a remote workspace", () => {
  let fixture: AgentFixture;
  let remote: RemoteWorker;
  let source: string;
  let target: string;
  let sourceSession: string;
  let targetSession: string;
  const operations: string[] = [];

  const request = (overrides: Record<string, unknown> = {}) =>
    ({
      sourceNodeId: source,
      sourceSessionId: sourceSession,
      sourceGeneration: 1,
      targetNodeId: target,
      targetSessionId: targetSession,
      targetGeneration: 1,
      sections: { ...EMPTY_SECTIONS, goal: "finish the port" },
      filePaths: ["a.txt", "missing.txt"],
      byteBudget: 8192,
      includeTranscript: false,
      ...overrides,
    }) as never;

  beforeEach(() => {
    operations.length = 0;
    fixture = agentFixture();
    fixture.database
      .prepare("UPDATE workspaces SET execution_host_id = ? WHERE id = ?")
      .run(HOST.id, fixture.workspaceId);
    source = fixture.agentNode("Source");
    target = fixture.agentNode("Target", "codex");
    fixture.link(source, target);
    sourceSession = fixture.session(source, "claude");
    targetSession = fixture.session(target, "codex");
    remote = new RemoteWorker({
      dataDir: "/nonexistent",
      host: HOST,
      worker: HOST.worker as NonNullable<SshHost["worker"]>,
      askpass: {} as never,
      version: "0.1.0",
      spawn: start,
      node: async () => ({
        version: "v24.0.0",
        major: 24,
        usable: true,
        detail: "",
      }),
    });
    setRemoteCaller(async (_hostId, operation, payload, replay) => {
      operations.push(operation);
      return await remote.request(operation, payload, replay);
    });
  });

  afterEach(() => {
    setRemoteCaller(undefined);
    remote.close();
    fixture.close();
  });

  it("collects files and the repository on the execution host", async () => {
    writeFileSync(join(fixture.directory, "a.txt"), "hello");
    execFileSync("git", ["init", "-q"], { cwd: fixture.directory });
    const view = await prepare(fixture.collab, fixture.workspaceId, request());
    expect(operations).toEqual(["handoff.capture"]);
    const byPath = new Map(view.bundle.files.map((file) => [file.path, file]));
    expect(byPath.get("a.txt")?.status).toBe("referenced");
    expect(byPath.get("a.txt")?.executionHost).toBe("execution-host:far");
    expect(byPath.get("missing.txt")?.status).toBe("missing");
    expect(view.bundle.git.worktreeId).toHaveLength(64);
    expect(view.bundle.source.executionHost).toBe("local-runtime");
  });

  it("takes an SSH Agent on the same host, and refuses one on another", async () => {
    const setHost = (nodeId: string, hostId: string): void => {
      fixture.database
        .prepare(
          "UPDATE nodes SET data_json = json_set(data_json, '$.ssh', json(?)) WHERE id = ?",
        )
        .run(JSON.stringify({ hostId }), nodeId);
    };
    setHost(source, HOST.id);
    const view = await prepare(fixture.collab, fixture.workspaceId, request());
    expect(view.bundle.source.executionHost).toBe("execution-host:far");
    setHost(source, "elsewhere");
    await expect(
      prepare(fixture.collab, fixture.workspaceId, request()),
    ).rejects.toThrow(/同一台执行主机/u);
  });

  it("answers an unreachable host by name rather than reading this disk", async () => {
    setRemoteCaller(async () => {
      throw Object.assign(new Error("执行主机 far 的 Worker 连接断开了"), {
        status: 503,
        code: "unavailable",
      });
    });
    await expect(
      prepare(fixture.collab, fixture.workspaceId, request()),
    ).rejects.toThrow(/断开/u);
  });
});

describe("capture", () => {
  it("reads the transcript tail where the Agent runs", () => {
    const root = tempDir("armadra-capture-");
    const transcript = join(root, "session.jsonl");
    writeFileSync(transcript, '{"type":"user","message":"hi"}\n');
    const captured = capture(root, {
      paths: [],
      execute: false,
      executionHost: "execution-host:far",
      transcript: { provider: "claude", path: transcript },
    });
    expect(captured.transcript).toEqual({
      state: "read",
      text: '{"type":"user","message":"hi"}\n',
    });
    expect(
      capture(root, {
        paths: [],
        execute: false,
        executionHost: "execution-host:far",
        transcript: { provider: "claude", path: join(root, "gone.jsonl") },
      }).transcript,
    ).toEqual({ state: "missing" });
  });
});
