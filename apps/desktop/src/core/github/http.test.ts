/**
 * 两张面的端到端：一个真的 core 服务器、一个真的身份会话、一台假 GitHub。
 *
 * 这一组测的不是动词的逻辑（那在 `service.test.ts` / `pulls.test.ts` 里），而是
 * **前端一行不改也能用**：路径、媒体类型、Origin 与 CSRF 的门、错误信封，以及
 * 24 个方法一个不少。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import {
  GetGithubCredentialRequestSchema,
  GetGithubIssueRequestSchema,
  GetGithubIssueResponseSchema,
  GithubCredentialStatusSchema,
  GithubIssueState,
  ListGithubIssuesRequestSchema,
  ListGithubIssuesResponseSchema,
  SetGithubIssueStateRequestSchema,
  GithubIssueSchema,
  create,
  fromBinary,
  toBinary,
} from "@armadra/protocol";
import type { DescMessage, MessageShape } from "@bufbuild/protobuf";

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
import {
  API_METHODS,
  API_PREFIX,
  GithubHttp,
  MEDIA_TYPE,
  RPC_METHODS,
  RPC_PREFIX,
} from "./http";
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
  await credentialService.configure(3, "ghp_pasted_token_value", "", 0);

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
  server.raw(RPC_PREFIX, (request, response, cors) =>
    http.rpc(request, response, cors),
  );
  server.raw(API_PREFIX, (request, response, cors) =>
    http.api(request, response, cors),
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

function rpcCall(
  harnessed: Harness,
  method: string,
  schema: DescMessage,
  message: MessageShape<DescMessage>,
  overrides: { headers?: Record<string, string> } = {},
): Promise<Response> {
  return fetch(`${harnessed.base}${RPC_PREFIX}${method}`, {
    method: "POST",
    headers: {
      "content-type": MEDIA_TYPE,
      origin: ORIGIN,
      authorization: `Bearer ${harnessed.accessToken}`,
      "x-armadra-csrf": harnessed.csrfToken,
      ...overrides.headers,
    },
    body: toBinary(schema, message) as BodyInit,
  });
}

describe("GitHub 的两张 HTTP 面", () => {
  let harnessed: Harness;

  beforeEach(async () => {
    harnessed = await harness();
  });

  afterEach(async () => {
    await harnessed.close();
  });

  it("兼容面覆盖 24 个方法", () => {
    // Go 侧 `githubMethod` 列的是同一批。少一个，面板的某一步就断在那里。
    expect(new Set(RPC_METHODS).size).toBe(RPC_METHODS.length);
    expect(RPC_METHODS).toHaveLength(24);
  });

  it("读取凭据状态走 protobuf，一来一回都对得上", async () => {
    const response = await rpcCall(
      harnessed,
      "GetCredential",
      GetGithubCredentialRequestSchema,
      create(GetGithubCredentialRequestSchema, {
        meta: { scope: { workspaceId: harnessed.workspaceId } },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(MEDIA_TYPE);
    const status = fromBinary(
      GithubCredentialStatusSchema,
      new Uint8Array(await response.arrayBuffer()),
    );
    expect(status.available).toBe(true);
    expect(status.accountLogin).toBe("octocat");
  });

  it("列表响应不带正文：一百条正文装不进一帧", async () => {
    harnessed.github.route("GET /repos/octo/repo/issues", {
      body: [
        {
          id: 1,
          number: 7,
          title: "An issue",
          body: "a very long body that must not travel in a list",
          state: "open",
          updated_at: "2026-09-02T00:00:00Z",
        },
      ],
    });
    const response = await rpcCall(
      harnessed,
      "ListIssues",
      ListGithubIssuesRequestSchema,
      create(ListGithubIssuesRequestSchema, {
        meta: { scope: { workspaceId: harnessed.workspaceId } },
        repository: { owner: "octo", name: "repo" },
      }),
    );
    expect(response.status).toBe(200);
    const listed = fromBinary(
      ListGithubIssuesResponseSchema,
      new Uint8Array(await response.arrayBuffer()),
    );
    expect(listed.issues).toHaveLength(1);
    expect(listed.issues[0]?.body).toBe("");
    expect(listed.issues[0]?.title).toBe("An issue");
  });

  it("没有 Origin 的请求一律 403", async () => {
    const response = await fetch(
      `${harnessed.base}${RPC_PREFIX}GetCredential`,
      {
        method: "POST",
        headers: {
          "content-type": MEDIA_TYPE,
          authorization: `Bearer ${harnessed.accessToken}`,
        },
        body: toBinary(
          GetGithubCredentialRequestSchema,
          create(GetGithubCredentialRequestSchema, {
            meta: { scope: { workspaceId: harnessed.workspaceId } },
          }),
        ) as BodyInit,
      },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: "PERMISSION_DENIED",
      message: "GitHub permission or CSRF check failed",
    });
  });

  it("写没有 CSRF 就 403，读不要求", async () => {
    const write = await rpcCall(
      harnessed,
      "SetIssueState",
      SetGithubIssueStateRequestSchema,
      create(SetGithubIssueStateRequestSchema, {
        meta: { scope: { workspaceId: harnessed.workspaceId } },
        repository: { owner: "octo", name: "repo" },
        number: 7n,
        state: GithubIssueState.CLOSED,
        expectedUpdatedAtUnixMs: 1n,
      }),
      { headers: { "x-armadra-csrf": "" } },
    );
    expect(write.status).toBe(403);
    const read = await rpcCall(
      harnessed,
      "GetCredential",
      GetGithubCredentialRequestSchema,
      create(GetGithubCredentialRequestSchema, {
        meta: { scope: { workspaceId: harnessed.workspaceId } },
      }),
      { headers: { "x-armadra-csrf": "" } },
    );
    expect(read.status).toBe(200);
  });

  it("scope 指名另一台机器的 host 被拒，而不是当成本地", async () => {
    const response = await rpcCall(
      harnessed,
      "GetCredential",
      GetGithubCredentialRequestSchema,
      create(GetGithubCredentialRequestSchema, {
        meta: {
          scope: { workspaceId: harnessed.workspaceId, hostId: "someone-else" },
        },
      }),
    );
    expect(response.status).toBe(403);
  });

  it("没有工作空间的请求是 400，不是一次全局授权", async () => {
    const response = await rpcCall(
      harnessed,
      "GetCredential",
      GetGithubCredentialRequestSchema,
      create(GetGithubCredentialRequestSchema, {}),
    );
    expect(response.status).toBe(400);
  });

  it("不是 protobuf 的请求体是 415", async () => {
    const response = await fetch(
      `${harnessed.base}${RPC_PREFIX}GetCredential`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          authorization: `Bearer ${harnessed.accessToken}`,
        },
        body: "{}",
      },
    );
    expect(response.status).toBe(415);
  });

  it("不存在的方法是 404，GET 是 405", async () => {
    const missing = await fetch(`${harnessed.base}${RPC_PREFIX}NoSuchMethod`, {
      method: "POST",
      headers: { "content-type": MEDIA_TYPE, origin: ORIGIN },
      body: new Uint8Array() as BodyInit,
    });
    expect(missing.status).toBe(404);
    const wrongVerb = await fetch(
      `${harnessed.base}${RPC_PREFIX}GetCredential`,
      { method: "GET", headers: { origin: ORIGIN } },
    );
    expect(wrongVerb.status).toBe(405);
  });

  it("过期或伪造的会话是 401", async () => {
    const response = await rpcCall(
      harnessed,
      "GetCredential",
      GetGithubCredentialRequestSchema,
      create(GetGithubCredentialRequestSchema, {
        meta: { scope: { workspaceId: harnessed.workspaceId } },
      }),
      { headers: { authorization: "Bearer not-a-real-token" } },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      code: "UNAUTHENTICATED",
      message: "Device session is invalid or expired",
    });
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
    expect(new Set(Object.values(API_METHODS))).toEqual(new Set(RPC_METHODS));
  });

  it("两张面对同一条记录说同一句话", async () => {
    const issue = {
      id: 1,
      number: 7,
      title: "An issue",
      body: "body",
      state: "open",
      updated_at: "2026-09-02T00:00:00Z",
    };
    harnessed.github.route("GET /repos/octo/repo/issues/7", { body: issue });
    harnessed.github.route("GET /repos/octo/repo/issues/7/comments", {
      body: [],
    });

    const viaRpc = fromBinary(
      GetGithubIssueResponseSchema,
      new Uint8Array(
        await (
          await rpcCall(
            harnessed,
            "GetIssue",
            GetGithubIssueRequestSchema,
            create(GetGithubIssueRequestSchema, {
              meta: { scope: { workspaceId: harnessed.workspaceId } },
              repository: { owner: "octo", name: "repo" },
              number: 7n,
            }),
          )
        ).arrayBuffer(),
      ),
    );
    const viaJson = (await (
      await apiCall(harnessed, "get-issue", {
        repository: { owner: "octo", name: "repo" },
        number: "7",
      })
    ).json()) as { issue: Record<string, unknown> };

    // 同一份 schema 的两种外衣：JSON 那一份逐字段就是 protobuf 那一份。
    expect(viaJson.issue.number).toBe("7");
    expect(viaJson.issue.title).toBe(viaRpc.issue?.title);
    expect(viaJson.issue.state).toBe("GITHUB_ISSUE_STATE_OPEN");
    expect(viaJson.issue.updatedAtUnixMs).toBe(
      String(viaRpc.issue?.updatedAtUnixMs ?? 0n),
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

  it("兼容面能走完连接 → 列表 → 关闭一条", async () => {
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

    const listed = fromBinary(
      ListGithubIssuesResponseSchema,
      new Uint8Array(
        await (
          await rpcCall(
            harnessed,
            "ListIssues",
            ListGithubIssuesRequestSchema,
            create(ListGithubIssuesRequestSchema, {
              meta: { scope: { workspaceId: harnessed.workspaceId } },
              repository: { owner: "octo", name: "repo" },
            }),
          )
        ).arrayBuffer(),
      ),
    );
    expect(listed.issues[0]?.state).toBe(GithubIssueState.OPEN);

    const closed = fromBinary(
      GithubIssueSchema,
      new Uint8Array(
        await (
          await rpcCall(
            harnessed,
            "SetIssueState",
            SetGithubIssueStateRequestSchema,
            create(SetGithubIssueStateRequestSchema, {
              meta: { scope: { workspaceId: harnessed.workspaceId } },
              repository: { owner: "octo", name: "repo" },
              number: 7n,
              state: GithubIssueState.CLOSED,
              expectedUpdatedAtUnixMs: listed.issues[0]?.updatedAtUnixMs ?? 0n,
            }),
          )
        ).arrayBuffer(),
      ),
    );
    expect(closed.state).toBe(GithubIssueState.CLOSED);
  });
});
