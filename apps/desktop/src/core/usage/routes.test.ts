/**
 * 八条新路由在一个真的 core 服务器上的端到端。
 *
 * 用一台 `node:http` 的假 GitHub 跑完整条设备流——没有一条测试连真的 github.com，
 * 也没有一条测试写进开发者真正的登录钥匙串（`ARMADRA_SECRET_BACKEND=file`）。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EventBus } from "../bus";
import { openDatabase, type OpenedDatabase } from "../db/open";
import { CoreServer } from "../http/server";
import { createLog, nodePlatform } from "../platform";
import { install } from "./index";
import { readTokenFile } from "./secret-store";

const here = dirname(fileURLToPath(import.meta.url));

interface FakeOauth {
  readonly base: string;
  /** 下一次轮询答什么。测试按需改它。 */
  reply: Record<string, unknown>;
  readonly requests: string[];
  close(): Promise<void>;
}

async function fakeOauth(): Promise<FakeOauth> {
  const state: FakeOauth = {
    base: "",
    reply: { error: "authorization_pending" },
    requests: [],
    close: async () => {},
  };
  const server: Server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      state.requests.push(request.url ?? "");
      const body =
        request.url === "/login/device/code"
          ? {
              device_code: "device-secret",
              user_code: "AAAA-1111",
              verification_uri: "https://example.invalid/device",
              interval: 5,
              expires_in: 900,
            }
          : state.reply;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    })();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  return {
    ...state,
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
    get reply() {
      return state.reply;
    },
    set reply(value: Record<string, unknown>) {
      state.reply = value;
    },
    get requests() {
      return state.requests;
    },
  };
}

interface Harness {
  readonly base: string;
  readonly dataDir: string;
  readonly oauth: FakeOauth;
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const oauth = await fakeOauth();
  const dataDir = mkdtempSync(join(tmpdir(), "armadra-usage-"));
  process.env.ARMADRA_GITHUB_OAUTH_BASE = oauth.base;
  process.env.ARMADRA_GITHUB_API_BASE = oauth.base;
  process.env.ARMADRA_SECRET_BACKEND = "file";
  // 扫描的两棵树指向这个空目录，所以成本汇总不会去翻开发者自己的记录。
  process.env.CLAUDE_CONFIG_DIR = join(dataDir, "claude");
  process.env.CODEX_HOME = join(dataDir, "codex");

  const opened: OpenedDatabase = openDatabase({
    file: join(dataDir, "canvas.db"),
    migrationsDir: resolve(here, "../db/migrations"),
  });
  const platform = nodePlatform({
    dataDir,
    appVersion: "0.0.0-test",
    isPackaged: false,
    log: createLog("error"),
  });
  const server = new CoreServer({
    platform,
    bus: new EventBus(),
    version: "0.0.0-test",
  });
  const domain = install({
    dataDir,
    db: opened,
    server,
    bus: new EventBus(),
    platform,
    log: createLog("error"),
  });
  const listener = server.createListener();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  const port = (listener.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    dataDir,
    oauth,
    async close() {
      domain.stop();
      await server.close();
      opened.close();
      await oauth.close();
      rmSync(dataDir, { recursive: true, force: true });
      delete process.env.ARMADRA_GITHUB_OAUTH_BASE;
      delete process.env.ARMADRA_GITHUB_API_BASE;
      delete process.env.ARMADRA_SECRET_BACKEND;
      delete process.env.CLAUDE_CONFIG_DIR;
      delete process.env.CODEX_HOME;
    },
  };
}

describe("用量的九条路由", () => {
  let state: Harness;

  beforeEach(async () => {
    state = await harness();
  });

  afterEach(async () => {
    await state.close();
  });

  async function json(
    path: string,
    method = "GET",
  ): Promise<Record<string, unknown>> {
    const response = await fetch(`${state.base}${path}`, { method });
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  }

  it("第一次取之前的快照是每家都 unavailable", async () => {
    const snapshot = await json("/api/usage");
    expect(snapshot.refreshAvailableAt).toBeNull();
    expect(snapshot.providers).toHaveLength(3);
    for (const provider of snapshot.providers as Record<string, unknown>[]) {
      // 「没有凭据」是一个真的答案，而这正是胶囊不渲染的那个状态。
      expect(provider.status).toBe("unavailable");
      expect(provider.credentialSource).toBe("none");
      expect(provider.windows).toEqual([]);
    }
  });

  it("mini 是同一份缓存的投影：没有数据时两条都是 null", async () => {
    expect(await json("/api/usage/mini")).toEqual({
      session: null,
      week: null,
      fetchedAt: null,
    });
  });

  it("手动刷新返回快照，而不是让调用方为节流分支", async () => {
    const refreshed = await json("/api/usage/refresh", "POST");
    expect(refreshed.providers).toHaveLength(3);
    // 这台机器上没有凭据，所以每家仍然是 unavailable——但这是一个**带原因**的
    // 答案，不是一次失败。
    expect(refreshed.refreshAvailableAt).toBeTypeOf("string");
  });

  it("成本汇总在没有记录时是 unavailable，而不是一堆零加 ok", async () => {
    const summary = await json("/api/usage/cost/refresh", "POST");
    expect(summary.status).toBe("unavailable");
    expect(summary.daily).toHaveLength(30);
    expect(summary.today).toEqual({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      costUsd: 0,
      complete: true,
      models: [],
    });
    // 再要一次落在 30 秒冷却里，答的是缓存。
    const again = await json("/api/usage/cost", "GET");
    expect(again.scannedAt).toBe(summary.scannedAt);
  });

  it("Copilot 的设备流能走完登录 → 轮询 → 登出", async () => {
    const before = await json("/api/usage/copilot");
    expect(before).toEqual({ signedIn: false, backend: "file" });

    const started = await json("/api/usage/copilot/login", "POST");
    const pending = started.pending as Record<string, unknown>;
    expect(pending.userCode).toBe("AAAA-1111");
    expect(pending.verificationUri).toBe("https://example.invalid/device");
    // device code 等价于 bearer，它不在任何一条响应上。
    expect(JSON.stringify(started)).not.toContain("device-secret");

    // 用户还没敲进去。
    const waiting = await json("/api/usage/copilot/poll", "POST");
    expect(waiting.progress).toBe("pending");
    expect(waiting.signedIn).toBe(false);

    state.oauth.reply = { access_token: "gho_test_token" };
    const authorized = await json("/api/usage/copilot/poll", "POST");
    expect(authorized.progress).toBe("authorized");
    expect(authorized.signedIn).toBe(true);
    // 令牌进的是 0600 文件后端，而不是响应。
    expect(JSON.stringify(authorized)).not.toContain("gho_test_token");
    expect(
      readTokenFile(join(state.dataDir, "secrets/Armadra Copilot.token")),
    ).toBe("gho_test_token");

    const out = await json("/api/usage/copilot/logout", "POST");
    expect(out.signedIn).toBe(false);
    expect(
      readTokenFile(join(state.dataDir, "secrets/Armadra Copilot.token")),
    ).toBeUndefined();
  });

  it("用户拒绝是一个终态，而不是继续轮询", async () => {
    await json("/api/usage/copilot/login", "POST");
    state.oauth.reply = { error: "access_denied" };
    const denied = await json("/api/usage/copilot/poll", "POST");
    expect(denied.progress).toBe("denied");
    // 流被丢掉了，所以下一次轮询要求重新开始而不是一次失败。
    const after = await json("/api/usage/copilot/poll", "POST");
    expect(after.progress).toBe("expired");
  });

  it("没有流在跑时的轮询要求重新开始", async () => {
    const result = await json("/api/usage/copilot/poll", "POST");
    expect(result.progress).toBe("expired");
    expect(result.pending).toBeUndefined();
  });

  it("重新打开的设置页继续显示用户正在敲的那个码", async () => {
    const first = await json("/api/usage/copilot/login", "POST");
    const second = await json("/api/usage/copilot/login", "POST");
    expect((second.pending as Record<string, unknown>).userCode).toBe(
      (first.pending as Record<string, unknown>).userCode,
    );
    // 只要了一次 device code。
    expect(
      state.oauth.requests.filter((url) => url === "/login/device/code"),
    ).toHaveLength(1);
  });
});
