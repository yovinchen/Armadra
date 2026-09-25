/**
 * 断线续订，对着一个真的 core。
 *
 * 验收里的那一幕：两个客户端看同一个工作空间，一个断开五秒（这里用几十毫秒，
 * 时间不是变量，断开这件事才是），期间发生的事件在它带着游标回来之后必须逐帧
 * 补齐，而且和另一个从没断过的客户端收到的完全一致。
 *
 * 第二件要证的事同样重要：**不带游标的客户端什么都没变**。页面
 * （`apps/web/src/api/events.ts`）不带游标，所以它既不会收到控制帧，也不会因为
 * 这一批多收到或少收到任何一帧。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { type RunningCore, run } from "../main";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");

const running: RunningCore[] = [];
const directories: string[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const core of running.splice(0)) await core.stop();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function start(): Promise<RunningCore> {
  const dataDir = mkdtempSync(join(tmpdir(), "armadra-outbox-"));
  directories.push(dataDir);
  const core = await run({
    argv: ["--listen", "tcp:127.0.0.1:0", "--data-dir", dataDir],
    env: {
      ARMADRA_CORE_MIGRATIONS_DIR: migrationsDir,
      ARMADRA_LOG: "error",
    },
    stdout: () => {},
  });
  running.push(core);
  core.db.database
    .prepare(
      "INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("ws", "ws", "/tmp/ws", "2026-09-20T00:00:00Z", "2026-09-20T00:00:00Z");
  return core;
}

function authority(core: RunningCore): string {
  const tcp = core.bound.find((spec) => spec.kind === "tcp");
  if (tcp?.kind !== "tcp") throw new Error("no TCP listener");
  return `${tcp.host}:${tcp.port}`;
}

function address(core: RunningCore, query = ""): string {
  return `ws://${authority(core)}/api/workspaces/ws/events${query}`;
}

/** 升级必须报来源，和页面一样。 */
function options(core: RunningCore): { origin: string } {
  return { origin: `http://${authority(core)}` };
}

interface Client {
  readonly socket: WebSocket;
  readonly frames: string[];
  /** 最后一条控制帧报的游标，带游标的客户端才有。 */
  cursor: number;
}

async function connect(core: RunningCore, query = ""): Promise<Client> {
  const socket = new WebSocket(address(core, query), options(core));
  sockets.push(socket);
  const client: Client = { socket, frames: [], cursor: 0 };
  socket.on("message", (data: Buffer) => {
    const text = data.toString("utf8");
    const parsed = JSON.parse(text) as { type?: string; cursor?: number };
    if (parsed.type === "cursor") {
      client.cursor = Number(parsed.cursor ?? 0);
      return;
    }
    client.frames.push(text);
  });
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.once("open", () => resolveOpen());
    socket.once("error", rejectOpen);
  });
  return client;
}

/** 升级被拒时 `ws` 给的是 `unexpected-response`，状态行就是拒绝的理由。 */
function refusal(core: RunningCore, query: string): Promise<string> {
  const socket = new WebSocket(address(core, query), options(core));
  return new Promise((resolveRefusal, rejectRefusal) => {
    socket.once(
      "unexpected-response",
      (
        request: { destroy(): void },
        response: {
          statusCode?: number;
          statusMessage?: string;
          destroy(): void;
        },
      ) => {
        const line =
          `${response.statusCode} ${response.statusMessage ?? ""}`.trim();
        // 拒绝之后这条连接就到头了。自己收掉，否则 `ws` 会在下一拍抱怨一个
        // 「还没建起来就被关掉」的 socket。
        response.destroy();
        request.destroy();
        resolveRefusal(line);
      },
    );
    socket.once("error", () => {});
    socket.once("open", () => rejectRefusal(new Error("升级本该被拒")));
  });
}

function publish(core: RunningCore, boardId: string): void {
  core.bus.emit("workspace.event", {
    workspaceId: "ws",
    event: {
      type: "board.changed",
      boardId,
      updatedAt: "2026-09-20T00:00:00Z",
    },
  });
}

/** 让写出去的帧真的到达对面。 */
function settle(): Promise<void> {
  return new Promise((done) => setTimeout(done, 60));
}

describe("断线续订", () => {
  it("带游标回来的客户端补齐的帧与从没断过的那个一致", async () => {
    const core = await start();
    const steady = await connect(core, "?cursor=0");
    const flaky = await connect(core, "?cursor=0");
    publish(core, "before");
    await settle();
    expect(flaky.cursor).toBeGreaterThan(0);
    const resume = flaky.cursor;

    flaky.socket.close();
    await settle();
    publish(core, "gap-1");
    publish(core, "gap-2");
    await settle();

    const back = await connect(core, `?cursor=${resume}`);
    publish(core, "after");
    await settle();

    expect(back.frames.map((frame) => JSON.parse(frame).boardId)).toEqual([
      "gap-1",
      "gap-2",
      "after",
    ]);
    // 断过的那个从游标之后收齐，和一直在线的那个看到的是同一串帧。
    expect(back.frames).toEqual(steady.frames.slice(1));
    expect(back.cursor).toBe(steady.cursor);
  });

  it("在线表只扇出、不进 outbox", async () => {
    const core = await start();
    const live = await connect(core);
    core.bus.emit("workspace.event", {
      workspaceId: "ws",
      event: {
        type: "canvas.presence",
        boardId: "board",
        clients: [],
        lease: null,
      },
    });
    publish(core, "after");
    await settle();
    expect(live.frames.map((frame) => JSON.parse(frame).type)).toEqual([
      "canvas.presence",
      "board.changed",
    ]);
    const stored = core.db.database
      .prepare("SELECT COUNT(*) AS count FROM events")
      .get() as { count: number };
    expect(Number(stored.count)).toBe(1);
  });

  it("游标过旧是 SNAPSHOT_REQUIRED，比水位高是 CURSOR_AHEAD", async () => {
    const core = await start();
    publish(core, "one");
    publish(core, "two");
    publish(core, "three");
    await settle();
    // 保留下限由 outbox 里最旧的那一条推出来：裁掉前两条，1 就再也补不回来了。
    core.db.database.exec("DELETE FROM events WHERE seq <= 2");
    expect(await refusal(core, "?cursor=1")).toBe("409 SNAPSHOT_REQUIRED");
    expect(await refusal(core, "?cursor=99")).toBe("409 CURSOR_AHEAD");
    expect(await refusal(core, "?cursor=abc")).toBe("400 INVALID_CURSOR");
  });

  /**
   * `?cursor=now` 是「我还没有位置」：不补发历史，只报一次当前水位。页面第一次
   * 连上时用它——`cursor=0` 会把这个 core 发过的一切重放一遍，那是另一个问题的
   * 答案。
   */
  it("cursor=now 只报当前水位，不补发任何历史", async () => {
    const core = await start();
    publish(core, "before-one");
    publish(core, "before-two");
    await settle();
    const seeded = await connect(core, "?cursor=now");
    await settle();
    expect(seeded.frames).toEqual([]);
    expect(seeded.cursor).toBeGreaterThan(0);
    const seededAt = seeded.cursor;

    publish(core, "after");
    await settle();
    expect(seeded.frames.map((frame) => JSON.parse(frame).boardId)).toEqual([
      "after",
    ]);
    expect(seeded.cursor).toBeGreaterThan(seededAt);

    // 那个数拿回来能续：这正是页面重连时做的事。
    const resumed = await connect(core, `?cursor=${seededAt}`);
    await settle();
    expect(resumed.frames.map((frame) => JSON.parse(frame).boardId)).toEqual([
      "after",
    ]);
  });

  it("不带游标的客户端一帧不多一帧不少", async () => {
    const core = await start();
    const plain = await connect(core);
    publish(core, "one");
    publish(core, "two");
    await settle();
    expect(plain.frames.map((frame) => JSON.parse(frame).boardId)).toEqual([
      "one",
      "two",
    ]);
    // 控制帧从没到过这条连接，所以 `cursor` 还是初值。
    expect(plain.cursor).toBe(0);
  });
});
