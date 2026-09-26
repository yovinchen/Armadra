/**
 * 分块传输：比一帧大的导入、下载与白板资产，以及连接断开后的续传。
 *
 * 与 `execution.test.ts` 同一个办法：本机子进程跑真 Worker（`--state-dir` 指向
 * 临时目录，暂存在那里），控制端经同一套帧说话。调用经一个记账的包装，于是能
 * 断言走的是分块、能在某一块的答复上「断线」。
 */

import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
import { install as installAssets } from "../assets/routes";
import { install as installFiles } from "../files/routes";
import { temporary, type Temporary } from "../files/workspace.fixture";
import { install as installImports } from "../imports/routes";
import type { SshHost } from "../settings/ssh-hosts";
import { tempDir } from "../testing/temp-dir";
import { type Fixture, fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import { createRemoteWorkspace } from "../workspaces/table";
import { type RemoteCaller, executeOn, setRemoteCaller } from "./execute";
import { CHUNK_BYTES, upload } from "./transfer";
import { RemoteError, RemoteWorker } from "./worker";
import { disposeWorkerBundle, spawnWorker } from "./worker.fixture";

const HOST: SshHost = {
  id: "far",
  name: "far",
  host: "far.example",
  worker: { path: "/opt/armadra/bin/armadra-core" },
};

let startWith: (stateDir: string) => Promise<() => ChildProcess>;

beforeAll(async () => {
  startWith = async (stateDir) => await spawnWorker(["--state-dir", stateDir]);
  await startWith(tempDir("armadra-transfer-warm-"));
}, 120_000);

afterAll(() => {
  setRemoteCaller(undefined);
  disposeWorkerBundle();
});

function multipart(files: readonly { path: string; bytes: Buffer }[]): {
  body: Buffer;
  type: string;
} {
  const boundary = "chunked-boundary";
  const parts: Buffer[] = [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="manifest"\r\n\r\n` +
        `${JSON.stringify({ paths: files.map((file) => file.path) })}\r\n`,
      "utf8",
    ),
  ];
  files.forEach((file, index) => {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${index}"; filename="x"\r\n\r\n`,
        "utf8",
      ),
      file.bytes,
      Buffer.from("\r\n", "utf8"),
    );
  });
  parts.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return {
    body: Buffer.concat(parts),
    type: `multipart/form-data; boundary=${boundary}`,
  };
}

describe("chunked transfers to an execution host", () => {
  let core: Fixture;
  let remote: RemoteWorker;
  let far: Temporary;
  let stateDir: string;
  let id: string;
  const calls: string[] = [];
  /** 在转给 Worker 之后、答复回来之前插一手：模拟答复丢失。 */
  let intercept:
    | ((operation: string, forward: () => Promise<unknown>) => Promise<unknown>)
    | undefined;

  beforeEach(async () => {
    calls.length = 0;
    intercept = undefined;
    core = fixture([
      installWorkspaces,
      installFiles,
      installImports,
      installAssets,
    ]);
    far = temporary("armadra-far-transfer-");
    stateDir = tempDir("armadra-far-state-");
    remote = new RemoteWorker({
      dataDir: "/nonexistent",
      host: HOST,
      worker: HOST.worker as NonNullable<SshHost["worker"]>,
      askpass: {} as never,
      version: "0.1.0",
      spawn: await startWith(stateDir),
      node: async () => ({
        version: "v24.0.0",
        major: 24,
        usable: true,
        detail: "",
      }),
    });
    const caller: RemoteCaller = async (
      _hostId,
      operation,
      payload,
      replay,
    ) => {
      calls.push(operation);
      const forward = () => remote.request(operation, payload, replay);
      return intercept === undefined
        ? await forward()
        : await intercept(operation, forward);
    };
    setRemoteCaller(caller);
    id = createRemoteWorkspace(core.database, {
      name: "far",
      executionHostId: HOST.id,
      rootPath: far.path,
    }).id;
  });

  afterEach(() => {
    setRemoteCaller(undefined);
    remote.close();
    far.remove();
    core.close();
  });

  it("imports a batch bigger than one frame, big files chunked ahead", async () => {
    // 合计 18 MiB：单帧的办法这里只能 413。单个文件的上限仍是 16 MiB。
    const big = randomBytes(9 * 1024 * 1024);
    const other = randomBytes(9 * 1024 * 1024);
    const small = Buffer.from("a small note");
    const { body, type } = multipart([
      { path: "big.bin", bytes: big },
      { path: "other.bin", bytes: other },
      { path: "note.txt", bytes: small },
    ]);
    const uploaded = await core.call(
      "POST",
      `/api/workspaces/${id}/imports`,
      body,
      {
        "content-type": type,
      },
    );
    expect(uploaded.status).toBe(200);
    const paths = (uploaded.body as { files: { path: string }[] }).files.map(
      (file) => file.path,
    );
    const bigPath = paths.find((path) => path.endsWith("big.bin")) as string;
    const notePath = paths.find((path) => path.endsWith("note.txt")) as string;
    expect(readFileSync(join(far.path, bigPath)).equals(big)).toBe(true);
    expect(readFileSync(join(far.path, notePath), "utf8")).toBe("a small note");
    // 大的分块先传，小的随发布那一帧走；用完的暂存删掉了。
    expect(calls.filter((call) => call === "transfer.chunk")).toHaveLength(
      2 * Math.ceil(big.byteLength / CHUNK_BYTES),
    );
    expect(calls.at(-1)).toBe("imports.write");
    expect(
      readdirSync(join(stateDir, "transfers")).filter((name) =>
        name.endsWith(".part"),
      ),
    ).toEqual([]);
  }, 120_000);

  it("resumes from what the worker already has after a lost answer", async () => {
    const bytes = randomBytes(3 * CHUNK_BYTES + 123);
    let dropped = 0;
    intercept = async (operation, forward) => {
      const answer = await forward();
      // 第二块已经写进 Worker 的暂存，答复却在路上丢了。
      if (
        operation === "transfer.chunk" &&
        dropped === 0 &&
        calls.filter((call) => call === "transfer.chunk").length === 2
      ) {
        dropped += 1;
        throw new RemoteError(503, "unavailable", "连接断开了");
      }
      return answer;
    };
    const transfer = await upload(
      { rootPath: far.path, executionHostId: HOST.id },
      bytes,
    );
    expect(dropped).toBe(1);
    expect(calls).toContain("transfer.status");
    // 续传没有重发已经收下的那一块：一共四块。
    expect(calls.filter((call) => call === "transfer.chunk")).toHaveLength(4);
    const part = join(stateDir, "transfers", `${transfer}.part`);
    expect(readFileSync(part).equals(bytes)).toBe(true);
  }, 120_000);

  it("downloads a file bigger than one frame in chunks", async () => {
    const bytes = randomBytes(13 * 1024 * 1024);
    writeFileSync(join(far.path, "large.bin"), bytes);
    const answer = await core.call(
      "GET",
      `/api/workspaces/${id}/file-download?path=large.bin`,
    );
    expect(answer.status).toBe(200);
    expect(answer.raw?.equals(bytes)).toBe(true);
    expect(calls.filter((call) => call === "files.downloadChunk")).toHaveLength(
      Math.ceil(bytes.byteLength / CHUNK_BYTES),
    );
  }, 120_000);

  it("stores, imports, reads and exports whiteboard assets on the host", async () => {
    // 一张 2 MiB 的「图片」：超过帧里直接带的上限，分块传过去。
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      randomBytes(2 * 1024 * 1024),
    ]);
    const stored = await core.call(
      "POST",
      `/api/workspaces/${id}/assets`,
      png,
      {
        "content-type": "image/png",
      },
    );
    expect(stored.status).toBe(200);
    const asset = stored.body as { id: string; path: string };
    expect(readFileSync(join(far.path, asset.path)).equals(png)).toBe(true);
    expect(calls).toContain("transfer.chunk");

    const read = await core.call(
      "GET",
      `/api/workspaces/${id}/assets/${asset.id}`,
    );
    expect(read.status).toBe(200);
    expect(read.raw?.equals(png)).toBe(true);

    // 工作空间里已有的图片：路径是执行主机上的。
    writeFileSync(join(far.path, "diagram.png"), png.subarray(0, 1024));
    const imported = await core.call(
      "POST",
      `/api/workspaces/${id}/assets/import`,
      { path: "diagram.png" },
    );
    expect(imported.status).toBe(200);
    expect(
      existsSync(join(far.path, (imported.body as { path: string }).path)),
    ).toBe(true);

    const exportId = "0192f1a0-7c1e-7b7a-8a55-3a1c2d3e4f51";
    const exported = await core.call(
      "POST",
      `/api/workspaces/${id}/exports/${exportId}/png`,
      {
        dataUrl: `data:image/png;base64,${png.subarray(0, 64).toString("base64")}`,
      },
    );
    expect(exported.status).toBe(200);
    expect(
      readFileSync(
        join(
          far.path,
          (exported.body as { relativePath: string }).relativePath,
        ),
      ).equals(png.subarray(0, 64)),
    ).toBe(true);
  }, 120_000);

  it("falls back to one frame for a worker without chunks, and says why when it cannot", async () => {
    intercept = async (operation, forward) => {
      if (operation.startsWith("transfer.")) {
        throw new RemoteError(501, "unsupported", "no transfer.v1");
      }
      return await forward();
    };
    const two = randomBytes(2 * 1024 * 1024);
    const fits = multipart([{ path: "two.bin", bytes: two }]);
    const ok = await core.call(
      "POST",
      `/api/workspaces/${id}/imports`,
      fits.body,
      {
        "content-type": fits.type,
      },
    );
    expect(ok.status).toBe(200);
    const tooBig = multipart([
      { path: "twelve.bin", bytes: randomBytes(12 * 1024 * 1024) },
    ]);
    const refused = await core.call(
      "POST",
      `/api/workspaces/${id}/imports`,
      tooBig.body,
      { "content-type": tooBig.type },
    );
    expect(refused.status).toBe(413);
    expect((refused.body as { message: string }).message).toContain("11 MiB");
  }, 120_000);

  it("refuses a chunk that would leave a gap", async () => {
    const target = { rootPath: far.path, executionHostId: HOST.id };
    await executeOn(target, "transfer.begin", {
      transferId: "0192f1a0-gap",
      size: 10,
      sha256: "0".repeat(64),
    });
    await expect(
      executeOn(target, "transfer.chunk", {
        transferId: "0192f1a0-gap",
        offset: 5,
        base64: Buffer.from("abc").toString("base64"),
      }),
    ).rejects.toMatchObject({ status: 409 });
  }, 60_000);
});
