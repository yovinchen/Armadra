/**
 * 远端执行的整条链路，不需要 sshd：Worker 是本机的一个真子进程（core 的真入口
 * 打成的包，`worker --stdio`），控制端经同一套帧、握手与重连规则和它说话。
 *
 * 真 `ssh` 的那一段——host key、askpass、Node 探测——由 `ssh.integration.test.ts`
 * 覆盖；这里测的是它之后的一切：Worker 执行了什么，控制端怎么把结果与错误交回
 * 路由，以及路由在远端工作空间上真的去了那台机器，而不是读本机的磁盘。
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
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
import { install as installFiles } from "../files/routes";
import { install as installImports } from "../imports/routes";
import { install as installGit } from "../git";
import { cleanupFixtures, repositoryAt } from "../git/fixture";
import type { SshHost } from "../settings/ssh-hosts";
import { type Fixture, fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import { createRemoteWorkspace } from "../workspaces/table";
import { setRemoteCaller } from "./execute";
import { FrameDecoder, encodeFrame, type WorkerResponse } from "./frames";
import { CONTRACT_VERSION, PROTOCOL_MAJOR } from "./handshake";
import { FILES_CAPABILITY, GIT_CAPABILITY } from "./operations";
import { serveWorker } from "./server";
import { remoteWatches } from "./watch";
import { RemoteError, RemoteWorker } from "./worker";
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

function worker(start: () => ChildProcess): RemoteWorker {
  return new RemoteWorker({
    dataDir: "/nonexistent",
    host: HOST,
    worker: HOST.worker as NonNullable<SshHost["worker"]>,
    askpass: {} as never,
    version: "0.1.0",
    spawn: start,
    node: usableNode,
  });
}

let start: () => ChildProcess;

beforeAll(async () => {
  start = await spawnWorker();
}, 120_000);

describe("the worker's stdio server", () => {
  it("greets first, then answers each request by id", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const decoder = new FrameDecoder();
    const frames: WorkerResponse[] = [];
    output.on("data", (chunk: Buffer) => {
      frames.push(...(decoder.push(chunk) as WorkerResponse[]));
    });
    const served = serveWorker({ input, output, instanceId: "session-1" });
    const dir = temporary("armadra-worker-");
    try {
      writeFileSync(join(dir.path, "a.txt"), "hi");
      input.write(
        encodeFrame({
          requestId: "r1",
          hostId: "far",
          expectedInstanceId: "session-1",
          deadlineUnixMs: Date.now() + 10_000,
          action: "files.read",
          payload: { root: dir.path, args: { path: "a.txt" } },
        }),
      );
      input.write(
        encodeFrame({
          requestId: "r2",
          hostId: "far",
          expectedInstanceId: "another-session",
          deadlineUnixMs: Date.now() + 10_000,
          action: "files.read",
          payload: { root: dir.path, args: { path: "a.txt" } },
        }),
      );
      input.write(
        encodeFrame({
          requestId: "r3",
          hostId: "far",
          expectedInstanceId: "",
          deadlineUnixMs: Date.now() + 10_000,
          action: "files.read",
          payload: { root: dir.path, args: { path: "../outside" } },
        }),
      );
      input.end();
      await served;
      const [hello, ...rest] = frames;
      expect(hello?.requestId).toBe("hello");
      expect(hello?.result).toMatchObject({
        protocol: { major: PROTOCOL_MAJOR },
        instanceId: "session-1",
        serviceContractVersion: CONTRACT_VERSION,
      });
      const byId = new Map(rest.map((frame) => [frame.requestId, frame]));
      expect(byId.get("r1")?.result).toMatchObject({ content: "hi" });
      // 发给另一个会话的请求不执行：那是重连之前的请求。
      expect(byId.get("r2")?.error?.code).toBe("instance_mismatch");
      // 根之外的路径由同一段校验拒绝，与本机相同。
      expect(byId.get("r3")?.status).toBeGreaterThanOrEqual(400);
      expect(byId.get("r3")?.status).toBeLessThan(500);
      expect(byId.get("r3")?.result).toBeUndefined();
    } finally {
      dir.remove();
    }
  });
});

describe("a worker child over stdio", () => {
  let dir: Temporary;
  beforeEach(() => {
    dir = temporary("armadra-remote-");
  });
  afterEach(() => dir.remove());

  it("hands over its capabilities and runs file operations on its own disk", async () => {
    const remote = worker(start);
    try {
      const hello = await remote.probe();
      expect([...hello.capabilities]).toEqual(
        expect.arrayContaining([FILES_CAPABILITY, GIT_CAPABILITY]),
      );
      const written = (await remote.request(
        "files.write",
        { root: dir.path, args: { path: "note.md", content: "# hi\n" } },
        false,
      )) as { sha256: string };
      expect(written.sha256).toHaveLength(64);
      expect(readFileSync(join(dir.path, "note.md"), "utf8")).toBe("# hi\n");
      const listed = (await remote.request(
        "files.list",
        { root: dir.path, args: { path: "." } },
        true,
      )) as { entries: { name: string }[] };
      expect(listed.entries.map((entry) => entry.name)).toContain("note.md");
      // 一个被拒绝的请求带着它自己的状态与代码回来。
      await expect(
        remote.request(
          "files.write",
          {
            root: dir.path,
            args: {
              path: "note.md",
              content: "x",
              expectedSha256: "0".repeat(64),
            },
          },
          false,
        ),
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      remote.close();
    }
  }, 60_000);

  it("replays a read on a fresh session but never a write whose answer was lost", async () => {
    // 第一个子进程回完握手就在第一个请求上断开；之后的是真 Worker。
    const flaky = `
      const hello = { requestId: "hello", instanceId: "flaky", status: 200, result: {
        protocol: { major: ${PROTOCOL_MAJOR}, minor: 0 }, instanceId: "flaky",
        runtimeVersion: "0.1.0", serviceContractVersion: ${CONTRACT_VERSION},
        capabilities: ["remote.execution.v1", "${FILES_CAPABILITY}", "${GIT_CAPABILITY}"],
        platform: "test", architecture: "test" } };
      const body = Buffer.from(JSON.stringify(hello));
      const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length, 0);
      process.stdout.write(Buffer.concat([prefix, body]));
      process.stdin.once("data", () => process.exit(0));
    `;
    let launches = 0;
    const alternating = (): ChildProcess => {
      launches += 1;
      return launches % 2 === 1
        ? spawn(process.execPath, ["-e", flaky], {
            stdio: ["pipe", "pipe", "inherit"],
          })
        : start();
    };
    writeFileSync(join(dir.path, "kept.txt"), "kept");
    const remote = worker(alternating);
    try {
      const read = (await remote.request(
        "files.read",
        { root: dir.path, args: { path: "kept.txt" } },
        true,
      )) as { content: string };
      expect(read.content).toBe("kept");
      expect(launches).toBe(2);

      remote.resume();
      launches = 0;
      const lost = remote.request(
        "files.write",
        { root: dir.path, args: { path: "new.txt", content: "x" } },
        false,
      );
      await expect(lost).rejects.toBeInstanceOf(RemoteError);
      await expect(lost).rejects.toMatchObject({ code: "unknown_outcome" });
      // 没有重发：新的会话从没收到这次写入。
      expect(launches).toBe(1);
      expect(existsSync(join(dir.path, "new.txt"))).toBe(false);
    } finally {
      remote.close();
    }
  }, 60_000);
});

describe("file routes on a remote workspace", () => {
  let core: Fixture;
  let remote: RemoteWorker;
  let far: Temporary;
  let id: string;

  beforeEach(() => {
    core = fixture([installWorkspaces, installFiles, installImports]);
    far = temporary("armadra-far-");
    remote = worker(start);
    setRemoteCaller(async (_hostId, operation, payload, replay) =>
      remote.request(operation, payload, replay),
    );
    id = createRemoteWorkspace(core.database, {
      name: "far",
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

  it("reads, writes, lists and searches on the execution host", async () => {
    mkdirSync(join(far.path, "src"));
    writeFileSync(
      join(far.path, "src", "main.ts"),
      "export const answer = 42;\n",
    );

    const listed = await core.call(
      "GET",
      `/api/workspaces/${id}/files?path=src`,
    );
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ entries: [{ name: "main.ts" }] });

    const read = await core.call(
      "GET",
      `/api/workspaces/${id}/file?path=src/main.ts`,
    );
    expect(read.status).toBe(200);
    const version = (read.body as { sha256: string }).sha256;

    const saved = await core.call("PUT", `/api/workspaces/${id}/file`, {
      path: "src/main.ts",
      content: "export const answer = 43;\n",
      expectedSha256: version,
    });
    expect(saved.status).toBe(200);
    expect(readFileSync(join(far.path, "src", "main.ts"), "utf8")).toContain(
      "43",
    );

    const stale = await core.call("PUT", `/api/workspaces/${id}/file`, {
      path: "src/main.ts",
      content: "lost",
      expectedSha256: version,
    });
    expect(stale.status).toBe(409);

    const found = await core.call("POST", `/api/workspaces/${id}/file-search`, {
      query: "answer",
    });
    expect(found.status).toBe(200);
    expect(JSON.stringify(found.body)).toContain("src/main.ts");

    const index = await core.call(
      "GET",
      `/api/workspaces/${id}/file-index?query=main`,
    );
    expect(JSON.stringify(index.body)).toContain("src/main.ts");

    const created = await core.call(
      "POST",
      `/api/workspaces/${id}/file-entries`,
      { path: "docs", kind: "directory" },
    );
    expect(created.status).toBe(200);
    expect(existsSync(join(far.path, "docs"))).toBe(true);

    const download = await core.call(
      "GET",
      `/api/workspaces/${id}/file-download?path=src/main.ts`,
    );
    expect(download.status).toBe(200);
    expect(download.raw?.toString("utf8")).toContain("43");
  }, 60_000);

  it("polls a watched remote file and publishes its change", async () => {
    writeFileSync(join(far.path, "watched.txt"), "one");
    const events: unknown[] = [];
    core.bus.on("workspace.event", ({ event }) => events.push(event));
    const registered = await core.call(
      "POST",
      `/api/workspaces/${id}/file-watch`,
      { path: "watched.txt", nodeId: "node-1" },
    );
    expect(registered.status).toBe(200);
    expect(registered.body).toMatchObject({ status: "watching", mode: "poll" });

    writeFileSync(join(far.path, "watched.txt"), "two");
    await remoteWatches.poll(id);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "file.changed",
        path: "watched.txt",
        kind: "modified",
      }),
    );
  }, 60_000);

  it("publishes an upload and a desktop drop on the execution host", async () => {
    const boundary = "remote-boundary";
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="manifest"\r\n\r\n` +
          `{"paths":["report.bin"]}\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="0"; filename="x"\r\n\r\n`,
        "utf8",
      ),
      Buffer.from([0, 1, 2, 255]),
      Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
    ]);
    const uploaded = await core.call(
      "POST",
      `/api/workspaces/${id}/imports`,
      body,
      { "content-type": `multipart/form-data; boundary=${boundary}` },
    );
    expect(uploaded.status).toBe(200);
    const path = (uploaded.body as { files: { path: string }[] }).files[0]
      ?.path as string;
    expect(readFileSync(join(far.path, path))).toEqual(
      Buffer.from([0, 1, 2, 255]),
    );

    // 拖进来的文件在控制端，根在执行主机：这边读，那边落地。
    const dropped = join(core.directory, "dropped.txt");
    writeFileSync(dropped, "from the desktop");
    const copied = await core.call(
      "POST",
      `/api/workspaces/${id}/imports/local`,
      { paths: [dropped] },
    );
    expect(copied.status).toBe(200);
    const copy = (copied.body as { files: { path: string }[] }).files[0]
      ?.path as string;
    expect(copy.endsWith("dropped.txt")).toBe(true);
    expect(readFileSync(join(far.path, copy), "utf8")).toBe("from the desktop");

    // 相对路径指的是工作空间里的文件，而工作空间在另一台机器上。
    const relative = await core.call(
      "POST",
      `/api/workspaces/${id}/imports/local`,
      { paths: ["dropped.txt"] },
    );
    expect(relative.status).toBe(400);
  }, 60_000);

  it("never answers a remote workspace from this machine's disk", async () => {
    setRemoteCaller(undefined);
    // 控制端的磁盘上恰好有同一个路径——正因为如此，回退到本机才是错的。
    writeFileSync(join(far.path, "here.txt"), "local");
    const read = await core.call(
      "GET",
      `/api/workspaces/${id}/file?path=here.txt`,
    );
    expect(read.status).toBe(501);
    expect(realpathSync(far.path)).toBe(far.path);
  });
});

describe("repository routes on a remote workspace", () => {
  let core: Fixture;
  let remote: RemoteWorker;
  let far: Temporary;
  let id: string;

  beforeEach(() => {
    core = fixture([installWorkspaces, installGit]);
    far = temporary("armadra-far-repo-");
    remote = worker(start);
    setRemoteCaller(async (_hostId, operation, payload, replay) =>
      remote.request(operation, payload, replay),
    );
    id = createRemoteWorkspace(core.database, {
      name: "far-repo",
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
    cleanupFixtures();
  });

  it("reads, stages and commits in the repository on the execution host", async () => {
    const repo = repositoryAt(far.path);
    repo.write("code.txt", "one\n");

    const status = await core.call(
      "GET",
      `/api/workspaces/${id}/git/status?path=.`,
    );
    expect(status.status).toBe(200);
    expect(JSON.stringify(status.body)).toContain("code.txt");

    const staged = await core.call("POST", `/api/workspaces/${id}/git/stage`, {
      path: ".",
      paths: ["code.txt"],
    });
    expect(staged.status).toBe(200);
    expect(staged.body).toEqual({ staged: ["code.txt"] });

    const diff = await core.call(
      "GET",
      `/api/workspaces/${id}/git/diff?path=.&scope=staged`,
    );
    expect(diff.status).toBe(200);
    expect(JSON.stringify(diff.body)).toContain("code.txt");

    const committed = await core.call(
      "POST",
      `/api/workspaces/${id}/git/commit`,
      { path: ".", message: "add code remotely" },
    );
    expect(committed.status).toBe(200);
    expect(repo.git("log", "-1", "--format=%s").trim()).toBe(
      "add code remotely",
    );

    const history = await core.call(
      "GET",
      `/api/workspaces/${id}/git/repository/history?path=.&limit=5`,
    );
    expect(history.status).toBe(200);
    expect(JSON.stringify(history.body)).toContain("add code remotely");

    const listed = await core.call(
      "GET",
      `/api/workspaces/${id}/git/repositories`,
    );
    expect(listed.status).toBe(200);

    // 队列在执行主机上；还没有发起过操作时列表为空（发起见 `worker-push.test.ts`）。
    const operations = await core.call(
      "GET",
      `/api/workspaces/${id}/git/repository/operations?path=.`,
    );
    expect(operations.status).toBe(200);
    expect(operations.body).toEqual([]);
  }, 60_000);
});

describe("opening and switching execution hosts", () => {
  let core: Fixture;
  let remote: RemoteWorker;

  beforeEach(() => {
    core = fixture([installWorkspaces, installFiles, installGit]);
    remote = worker(start);
    setRemoteCaller(async (_hostId, operation, payload, replay) =>
      remote.request(operation, payload, replay),
    );
  });
  afterEach(() => {
    setRemoteCaller(undefined);
    remote.close();
    core.close();
    cleanupFixtures();
  });

  it("opens a project on the host only once its root is proven there", async () => {
    const far = repositoryAt(join(core.directory, "far"));
    const opened = await core.call("POST", "/api/workspaces/remote", {
      name: "far",
      executionHostId: HOST.id,
      rootPath: far.path,
    });
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({
      executionHostId: HOST.id,
      rootPath: far.path,
    });

    const missing = await core.call("POST", "/api/workspaces/remote", {
      name: "gone",
      executionHostId: HOST.id,
      rootPath: join(core.directory, "does-not-exist"),
    });
    expect(missing.status).toBe(400);
    const listed = (await core.call("GET", "/api/workspaces")).body as {
      name: string;
    }[];
    expect(listed.map((one) => one.name)).not.toContain("gone");
  }, 60_000);

  it("rebinds to the same project elsewhere, refuses a different one unless forced, and waits for live terminals", async () => {
    const here = repositoryAt(join(core.directory, "here"));
    const there = join(core.directory, "there");
    here.git("clone", "-q", here.path, there);
    const created = await core.call("POST", "/api/workspaces", {
      name: "moving",
      rootPath: here.path,
      permissions: { read: true, write: true, execute: true },
    });
    const id = (created.body as { id: string }).id;

    // 同一个项目：HEAD 与顶层目录都一致，直接改绑。
    const moved = await core.call(
      "PATCH",
      `/api/workspaces/${id}/execution-host`,
      { executionHostId: HOST.id, rootPath: there },
    );
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({
      executionHostId: HOST.id,
      rootPath: realpathSync(there),
    });
    // 此后的读来自新主机上的那个目录。
    writeFileSync(join(there, "only-there.txt"), "x");
    const listing = await core.call("GET", `/api/workspaces/${id}/files`);
    expect(JSON.stringify(listing.body)).toContain("only-there.txt");

    // 另一个项目：两边指纹都给出来，不强制就不动。
    const other = repositoryAt(join(core.directory, "other"));
    other.write("different.txt", "y");
    other.commit("different");
    const refused = await core.call(
      "PATCH",
      `/api/workspaces/${id}/execution-host`,
      { executionHostId: "", rootPath: other.path },
    );
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: "root_mismatch",
      from: { entryCount: expect.any(Number) },
      to: { entryCount: expect.any(Number) },
    });

    // 还有终端开着：先列出来，而不是在它脚下换机器。
    core.database
      .prepare(
        "INSERT INTO terminal_sessions (id, workspace_id, owner_node_id, cwd, shell, status, created_at) " +
          "VALUES ('term-1', ?, 'node-1', '/', 'sh', 'running', '2026-01-01T00:00:00Z')",
      )
      .run(id);
    const blocked = await core.call(
      "PATCH",
      `/api/workspaces/${id}/execution-host`,
      { executionHostId: "", rootPath: other.path, force: true },
    );
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({
      code: "switch_blocked",
      blockers: [{ kind: "terminal", detail: "node-1" }],
    });
    core.database
      .prepare(
        "UPDATE terminal_sessions SET status = 'exited' WHERE id = 'term-1'",
      )
      .run();

    const forced = await core.call(
      "PATCH",
      `/api/workspaces/${id}/execution-host`,
      { executionHostId: "", rootPath: other.path, force: true },
    );
    expect(forced.status).toBe(200);
    expect(forced.body).not.toHaveProperty("executionHostId");
    expect(forced.body).toMatchObject({ rootPath: other.path });

    const migrate = await core.call(
      "PATCH",
      `/api/workspaces/${id}/execution-host`,
      { executionHostId: HOST.id, rootPath: there, migrateFiles: true },
    );
    expect(migrate.status).toBe(501);
  }, 60_000);
});

afterAll(() => {
  setRemoteCaller(undefined);
  disposeWorkerBundle();
});
