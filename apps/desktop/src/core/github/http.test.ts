/**
 * `/api/github/*` 的端到端：一个真的 core 服务器、一个真的身份会话、一台假
 * GitHub。
 *
 * 这一组测的不是动词的逻辑（那在 `service.test.ts` / `pulls.test.ts` 里），而是
 * **这一面说得对**：路径、Origin 与 CSRF 的门、错误信封、零值照写，以及 24 个
 * 动词一个不少。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";


import { GithubCredentialSource } from "./types";
import { EventBus } from "../bus";
import { openDatabase, type OpenedDatabase } from "../db/open";
import { CoreServer } from "../http/server";
import {
  IdentityService,
  IdentityStore,
  identityInstanceId,
} from "../identity";
import { allScopes } from "../identity/scopes";
import { createLog, nodePlatform } from "../platform";
import { CredentialService } from "./credentials";
import { API_METHODS, API_PREFIX, GITHUB_METHODS, GithubHttp } from "./http";
import {
  fakeGithub,
  memorySecrets,
  migrationsDir,
  stubGh,
  type FakeGithub,
} from "./fixture";
import { GithubService } from "./service";
import { GithubStore } from "./store";

const ORIGIN = "http://127.0.0.1:5173";

interface Harness {
  readonly base: string;
  readonly github: FakeGithub;
  readonly accessToken: string;
  readonly csrfToken: string;
  readonly workspaceId: string;
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const github = await fakeGithub();
  const dataDir = mkdtempSync(join(tmpdir(), "armadra-github-http-"));
  const opened: OpenedDatabase = openDatabase({
    file: join(dataDir, "canvas.db"),
    migrationsDir: migrationsDir(),
  });
  const identityStore = new IdentityStore(opened.database);
  const instanceId = identityInstanceId();
  const identity = new IdentityService(identityStore, instanceId);
  // 一次本机配对，拿到全套授权——这就是桌面壳走的那条路。
  const { ticket } = identity.issueBootstrap({
    hostId: identityStore.hostId(),
    instanceId,
    origin: ORIGIN,
    deviceName: "test-device",
    scopes: allScopes(),
  });
  const credentials = identity.consumeBootstrap({
    ticket,
    hostId: identityStore.hostId(),
    instanceId,
    origin: ORIGIN,
  });

  const store = new GithubStore(opened.database);
  const credentialService = new CredentialService({
    store,
    secrets: memorySecrets(),
    gh: stubGh(),
    client: {
      fetch: (input, init) =>
        globalThis.fetch(
          String(input).replace("https://api.github.com", github.base),
          init,
        ),
      sleep: async () => {},
    },
  });
  github.route("GET /user", { body: { login: "octocat" } });
  await credentialService.configure(
    GithubCredentialSource.TOKEN_REF,
    "ghp_pasted_token_value",
    "",
    0,
  );

  const service = new GithubService({
    store,
    credentials: credentialService,
    hostId: identityStore.hostId(),
  });
  const http = new GithubHttp({ service, identity });

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
  server.raw(API_PREFIX, (request, response, cors) =>
    http.handle(request, response, cors),
  );
  const listener = server.createListener();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  const port = (listener.address() as AddressInfo).port;

  return {
    base: `http://127.0.0.1:${port}`,
    github,
    accessToken: credentials.accessToken,
    csrfToken: credentials.csrfToken,
    workspaceId: "ws-1",
    async close() {
      await server.close();
      opened.close();
      await github.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** JSON 面的一次调用：工作空间在查询串上，身体里只有这个动词自己的参数。 */
function apiCall(
  harnessed: Harness,
  verb: string,
  body: Record<string, unknown>,
  overrides: { headers?: Record<string, string> } = {},
): Promise<Response> {
  return fetch(
    `${harnessed.base}${API_PREFIX}${verb}?workspaceId=${harnessed.workspaceId}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        authorization: `Bearer ${harnessed.accessToken}`,
        "x-armadra-csrf": harnessed.csrfToken,
        ...overrides.headers,
      },
      body: JSON.stringify(body),
    },
  );
}

describe("GitHub 的 HTTP 面", () => {
  let harnessed: Harness;

  beforeEach(async () => {
    harnessed = await harness();
  });

  afterEach(async () => {
    await harnessed.close();
  });

  it("这一面覆盖 24 个动词", () => {
    expect(new Set(GITHUB_METHODS).size).toBe(GITHUB_METHODS.length);
    expect(GITHUB_METHODS).toHaveLength(24);
  });

  it("没有 Origin 的请求一律 403", async () => {
    const response = await fetch(
      `${harnessed.base}${API_PREFIX}get-credential?workspaceId=${harnessed.workspaceId}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${harnessed.accessToken}`,
        },
        body: "{}",
      },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: "PERMISSION_DENIED",
      message: "GitHub permission or CSRF check failed",
    });
  });

  it("写没有 CSRF 就 403，读不要求", async () => {
    const write = await apiCall(
      harnessed,
      "set-issue-state",
      {
        repository: { owner: "octo", name: "repo" },
        number: "7",
        state: "GITHUB_ISSUE_STATE_CLOSED",
        expectedUpdatedAtUnixMs: "1",
      },
      { headers: { "x-armadra-csrf": "" } },
    );
    expect(write.status).toBe(403);
    const read = await apiCall(
      harnessed,
      "get-credential",
      {},
      { headers: { "x-armadra-csrf": "" } },
    );
    expect(read.status).toBe(200);
  });

  it("过期或伪造的会话是 401", async () => {
    const response = await apiCall(
      harnessed,
      "get-credential",
      {},
      { headers: { authorization: "Bearer not-a-real-token" } },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      code: "UNAUTHENTICATED",
      message: "Device session is invalid or expired",
    });
  });

  it("GET 一条动词路径是 404，这一面只有 POST", async () => {
    const response = await fetch(
      `${harnessed.base}${API_PREFIX}get-credential?workspaceId=${harnessed.workspaceId}`,
      { method: "GET", headers: { origin: ORIGIN } },
    );
    expect(response.status).toBe(404);
  });

  it("JSON 面答同一批动词，工作空间跟着查询串走", async () => {
    const response = await apiCall(harnessed, "get-credential", {});
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.accountLogin).toBe("octocat");
    expect(body.available).toBe(true);
    // 零值照写：页面的 zod 解的是一份**总是完整**的记录。
    expect(body).toHaveProperty("source");
    expect(body).toHaveProperty("revision");
    // 这一面也不会把令牌带出去。
    expect(JSON.stringify(body)).not.toContain("ghp_pasted_token_value");
  });

  it("JSON 面上的域错误也是 { code, message }，code 与兼容面一致", async () => {
    const response = await apiCall(harnessed, "create-issue", {
      repository: { owner: "octo", name: "repo" },
      title: "",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "INVALID_ARGUMENT",
      message: "Invalid GitHub request",
    });
  });

  it("没报工作空间就是 INVALID_ARGUMENT，不是一次「空列表」", async () => {
    const response = await fetch(
      `${harnessed.base}${API_PREFIX}get-credential`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          authorization: `Bearer ${harnessed.accessToken}`,
          "x-armadra-csrf": harnessed.csrfToken,
        },
        body: "{}",
      },
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("INVALID_ARGUMENT");
  });

  it("没有这个动词就是 404，而不是一个看起来成功的空响应", async () => {
    const response = await apiCall(harnessed, "not-a-verb", {});
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("NOT_FOUND");
  });

  it("24 个动词各有一条 JSON 路由，拼法是方法名的 kebab-case", () => {
    expect(Object.keys(API_METHODS)).toHaveLength(24);
    expect(API_METHODS["get-credential"]).toBe("GetCredential");
    expect(API_METHODS["put-status-mapping"]).toBe("PutStatusMapping");
    expect(new Set(Object.values(API_METHODS))).toEqual(
      new Set(GITHUB_METHODS),
    );
  });

  it("JSON 面走完列表 → 关闭一条", async () => {
    const issue = {
      id: 1,
      number: 7,
      title: "An issue",
      body: "body",
      state: "open",
      updated_at: "2026-09-02T00:00:00Z",
    };
    harnessed.github.route("GET /repos/octo/repo/issues", { body: [issue] });
    harnessed.github.route("GET /repos/octo/repo/issues/7", { body: issue });
    harnessed.github.route("PATCH /repos/octo/repo/issues/7", {
      body: { ...issue, state: "closed" },
    });

    const listed = (await (
      await apiCall(harnessed, "list-issues", {
        repository: { owner: "octo", name: "repo" },
      })
    ).json()) as { issues: Record<string, unknown>[] };
    expect(listed.issues[0]?.state).toBe("GITHUB_ISSUE_STATE_OPEN");
    // 列表里不带正文，这一面和兼容面同一条规矩。
    expect(listed.issues[0]?.body).toBe("");

    const closed = (await (
      await apiCall(harnessed, "set-issue-state", {
        repository: { owner: "octo", name: "repo" },
        number: "7",
        state: "GITHUB_ISSUE_STATE_CLOSED",
        expectedUpdatedAtUnixMs: listed.issues[0]?.updatedAtUnixMs,
      })
    ).json()) as Record<string, unknown>;
    expect(closed.state).toBe("GITHUB_ISSUE_STATE_CLOSED");
  });

});
