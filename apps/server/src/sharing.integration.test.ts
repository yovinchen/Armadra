import { mkdtempSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "./serve";

/**
 * 装配级用例：服务器壳上的账号、邀请与共享真的生效（R8）。
 *
 * 一个管理员（配对出来的 owner）、三个靠邀请注册进来的人：w1 上的 editor、
 * w1 上的 viewer、只在 w2 上有授予的「局外人」。用例回答四件事：
 *
 *   1. 权限矩阵：同一组路由，四个人各拿到什么（HTTP 面）；
 *   2. 事件流：订阅在升级前按 `events:read@workspace` 判，只收自己那块画布的帧；
 *   3. 邀请：注册即兑换，一张邀请只能用一次；
 *   4. 撤销共享：已开的事件流立刻被关（4403），下一个请求就是 403。
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../../desktop/src/core/db/migrations");
// 服务器壳自己不依赖 `ws`（它只转发升级）；客户端从 core 那边借一份。
const { WebSocket } = createRequire(
  resolve(here, "../../desktop/package.json"),
)("ws") as typeof import("ws");

interface Answer {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

interface Person {
  readonly cookie: string;
  readonly csrf: string;
  readonly principalId: string;
}

let running: Awaited<ReturnType<typeof serve>>;
let origin: string;
let admin: Person;
let editor: Person;
let viewer: Person;
let outsider: Person;
let w1: string;
let w2: string;

function call(
  path: string,
  options: {
    method?: string;
    person?: Person;
    body?: unknown;
  } = {},
): Promise<Answer> {
  const url = new URL(path, origin);
  const payload =
    options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((done, failed) => {
    const headers: Record<string, string> = { origin };
    if (options.person !== undefined) {
      headers.cookie = options.person.cookie;
      headers["x-armadra-csrf"] = options.person.csrf;
    }
    if (payload !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
    const client = httpsRequest(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: options.method ?? "GET",
        headers,
        rejectUnauthorized: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          done({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    client.on("error", failed);
    if (payload !== undefined) client.write(payload);
    client.end();
  });
}

function person(answer: Answer): Person {
  const cookies = answer.headers["set-cookie"] as string[];
  const body = JSON.parse(answer.body) as {
    csrfToken: string;
    device: { principalId: string };
  };
  return {
    cookie: cookies
      .map((value) => (value.split(";")[0] as string).trim())
      .join("; "),
    csrf: body.csrfToken,
    principalId: body.device.principalId,
  };
}

async function invite(
  role: string,
  workspaceId: string,
): Promise<{ token: string }> {
  const issued = await call("/api/identity/invitations", {
    method: "POST",
    person: admin,
    body: { role, targetWorkspaceId: workspaceId },
  });
  expect(issued.status).toBe(201);
  return JSON.parse(issued.body) as { token: string };
}

async function register(token: string, displayName: string): Promise<Person> {
  const answer = await call("/api/identity/register", {
    method: "POST",
    body: { token, displayName, password: "correct horse battery" },
  });
  expect(answer.status).toBe(201);
  return person(answer);
}

async function workspace(name: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), `armadra-share-${name}-`));
  writeFileSync(join(root, "README.md"), name);
  const created = await call("/api/workspaces", {
    method: "POST",
    person: admin,
    body: { name, rootPath: root },
  });
  expect(created.status).toBe(200);
  return (JSON.parse(created.body) as { id: string }).id;
}

/** 开一条事件流。结果是升级的 HTTP 状态，成功时带着 socket 与收到的帧。 */
function subscribe(
  who: Person,
  workspaceId: string,
): Promise<
  | { status: number }
  | {
      status: 101;
      socket: InstanceType<typeof WebSocket>;
      frames: string[];
      closed: Promise<number>;
    }
> {
  return new Promise((done) => {
    const socket = new WebSocket(
      `${origin.replace("https:", "wss:")}/api/workspaces/${workspaceId}/events`,
      {
        headers: { origin, cookie: who.cookie },
        rejectUnauthorized: false,
      },
    );
    const frames: string[] = [];
    const closed = new Promise<number>((settle) => {
      socket.on("close", (code) => settle(code));
    });
    socket.on("message", (data) => frames.push(String(data)));
    socket.on("unexpected-response", (_request, response) => {
      done({ status: response.statusCode ?? 0 });
      socket.terminate();
    });
    socket.on("error", () => {});
    socket.on("open", () => done({ status: 101, socket, frames, closed }));
  });
}

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "armadra-server-share-"));
  const webRoot = mkdtempSync(join(tmpdir(), "armadra-web-share-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
  running = await serve({
    listen: { host: "127.0.0.1", port: 0 },
    publicOrigins: [],
    dataDir,
    webRoot,
    deviceName: "管理员的电脑",
    pairing: true,
    env: {
      ARMADRA_CORE_MIGRATIONS_DIR: migrationsDir,
      ARMADRA_LOG: "error",
    },
    stdout: () => {},
    moduleDir: here,
  });
  origin = running.origin;
  // 首个管理员：服务器上还没有 owner，第一张配对票兑换出来的就是它。
  expect(running.hasAdmin()).toBe(false);
  const paired = await call("/api/identity/pair", {
    method: "POST",
    body: { ticket: running.pairingTicket },
  });
  expect(paired.status).toBe(200);
  admin = person(paired);
  expect(running.hasAdmin()).toBe(true);

  w1 = await workspace("w1");
  w2 = await workspace("w2");
  editor = await register((await invite("editor", w1)).token, "编辑");
  viewer = await register((await invite("viewer", w1)).token, "只读");
  outsider = await register((await invite("viewer", w2)).token, "局外人");
}, 60_000);

afterAll(async () => {
  await running?.stop();
});

describe("共享的权限矩阵", () => {
  it("工作空间列表只给看得见的那几块", async () => {
    const ids = async (who: Person) =>
      (
        JSON.parse((await call("/api/workspaces", { person: who })).body) as {
          id: string;
        }[]
      ).map((item) => item.id);
    expect(await ids(admin)).toEqual(expect.arrayContaining([w1, w2]));
    expect(await ids(editor)).toEqual([w1]);
    expect(await ids(viewer)).toEqual([w1]);
    expect(await ids(outsider)).toEqual([w2]);
  });

  it("读：owner、editor、viewer 放行，非成员 403", async () => {
    const read = (who: Person) =>
      call(`/api/workspaces/${w1}/boards`, { person: who });
    expect((await read(admin)).status).toBe(200);
    expect((await read(editor)).status).toBe(200);
    expect((await read(viewer)).status).toBe(200);
    const denied = await read(outsider);
    expect(denied.status).toBe(403);
    expect(JSON.parse(denied.body).code).toBe("forbidden");
  });

  it("写：owner 与 editor 放行，viewer 与非成员 403", async () => {
    const write = (who: Person, name: string) =>
      call(`/api/workspaces/${w1}/boards`, {
        method: "POST",
        person: who,
        body: { name },
      });
    expect((await write(admin, "管理员的看板")).status).toBe(200);
    expect((await write(editor, "编辑的看板")).status).toBe(200);
    expect((await write(viewer, "只读的看板")).status).toBe(403);
    expect((await write(outsider, "局外人的看板")).status).toBe(403);
  });

  it("执行：开终端要 operator，editor 与 viewer 都不行", async () => {
    const spawn = (who: Person) =>
      call("/api/terminals", {
        method: "POST",
        person: who,
        body: { workspaceId: w1, cwd: tmpdir() },
      });
    expect((await spawn(editor)).status).toBe(403);
    expect((await spawn(viewer)).status).toBe(403);
    expect((await spawn(outsider)).status).toBe(403);
  });

  it("工作空间本身与全局设置只有 owner 能动", async () => {
    const rename = (who: Person) =>
      call(`/api/workspaces/${w1}`, {
        method: "PATCH",
        person: who,
        body: { name: "改名" },
      });
    expect((await rename(editor)).status).toBe(403);
    expect((await call("/api/settings", { person: editor })).status).toBe(403);
    expect((await call("/api/settings", { person: admin })).status).toBe(200);
  });

  it("共享只有 owner 能改", async () => {
    const attempt = await call("/api/identity/grants", {
      method: "PUT",
      person: editor,
      body: {
        workspaceId: w1,
        subjectKind: "principal",
        subjectId: outsider.principalId,
        role: "driver",
      },
    });
    expect(attempt.status).toBe(403);
  });
});

describe("邀请", () => {
  it("一张邀请只能兑换一次", async () => {
    const { token } = await invite("viewer", w1);
    await register(token, "第一个");
    const second = await call("/api/identity/register", {
      method: "POST",
      body: { token, displayName: "第二个", password: "correct horse battery" },
    });
    expect(second.status).toBe(401);
  });

  it("作废的邀请兑换不了", async () => {
    const issued = await call("/api/identity/invitations", {
      method: "POST",
      person: admin,
      body: { role: "viewer", targetWorkspaceId: w1 },
    });
    const { invitationId, token } = JSON.parse(issued.body) as {
      invitationId: string;
      token: string;
    };
    expect(
      (
        await call(`/api/identity/invitations/${invitationId}`, {
          method: "DELETE",
          person: admin,
        })
      ).status,
    ).toBe(200);
    const redeemed = await call("/api/identity/register", {
      method: "POST",
      body: { token, displayName: "迟到", password: "correct horse battery" },
    });
    expect(redeemed.status).toBe(401);
  });

  it("命令行也能签一张，链接落在页面根的片段上", () => {
    const issued = running.invite({ role: "viewer", targetWorkspaceId: w1 });
    expect(issued.url.startsWith(`${origin}/#invite=`)).toBe(true);
  });
});

describe("事件流与撤销", () => {
  it("非成员在升级前就被拒，成员只收自己那块画布的帧", async () => {
    expect((await subscribe(outsider, w1)).status).toBe(403);
    const opened = await subscribe(viewer, w1);
    expect(opened.status).toBe(101);
    if (!("socket" in opened)) return;
    running.core.bus.emit("workspace.event", {
      workspaceId: w2,
      event: { type: "board.changed", boardId: "w2-board", updatedAt: "t" },
    });
    running.core.bus.emit("workspace.event", {
      workspaceId: w1,
      event: { type: "board.changed", boardId: "w1-board", updatedAt: "t" },
    });
    await expect
      .poll(() => opened.frames.some((frame) => frame.includes("w1-board")))
      .toBe(true);
    expect(opened.frames.some((frame) => frame.includes("w2-board"))).toBe(
      false,
    );
    opened.socket.close();
  });

  it("撤销共享之后事件流立刻关掉，下一个请求就是 403", async () => {
    const opened = await subscribe(viewer, w1);
    expect(opened.status).toBe(101);
    if (!("socket" in opened)) return;
    expect(
      (await call(`/api/workspaces/${w1}/boards`, { person: viewer })).status,
    ).toBe(200);
    const revoked = await call("/api/identity/grants", {
      method: "DELETE",
      person: admin,
      body: {
        workspaceId: w1,
        subjectKind: "principal",
        subjectId: viewer.principalId,
      },
    });
    expect(revoked.status).toBe(200);
    expect(await opened.closed).toBe(4403);
    expect(
      (await call(`/api/workspaces/${w1}/boards`, { person: viewer })).status,
    ).toBe(403);
    expect((await subscribe(viewer, w1)).status).toBe(403);
    // 另一个人的订阅不受牵连。
    const other = await subscribe(editor, w1);
    expect(other.status).toBe(101);
    if ("socket" in other) other.socket.close();
  });
});
