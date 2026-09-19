/**
 * 一台假 GitHub，和一个把 GitHub 域装起来的一次性 core。
 *
 * 假 GitHub 是一个真的 `node:http` 服务器，不是一个打了桩的 `fetch`：这个域里最
 * 值得测的东西——ETag 缓存、`Link` 翻页、限流头、写不重试——全都发生在传输层面上，
 * 一个假的 `fetch` 测的是那个假的。Go 侧的 `githubapi`/`githubhost` 用例用的就是
 * 这个思路（`httptest.Server`）。
 *
 * 它只听回环，而且是 **HTTP**，所以 `normalizeApiBase` 那条「只接受 HTTPS」的规则
 * 会拒绝它。这就是 {@link fakeGithub} 把地址交给 `GithubClient` 时绕过规范化的
 * 理由：规范化本身在 `remote.test.ts` 里单独测，这里测的是它之后的一切。
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

import { GithubCredentialSource } from "@armadra/protocol";

import { GithubClient } from "./client";
import { CredentialService, type GhCli, type SecretStore } from "./credentials";
import { GithubService, type Caller } from "./service";
import { GithubStore } from "./store";
import { scope, type Scope } from "../identity/scopes";
import { openDatabase, type OpenedDatabase } from "../db/open";

const here = dirname(fileURLToPath(import.meta.url));

export function migrationsDir(): string {
  return resolve(here, "../../../../runtime/migrations");
}

export function unifiedMigrationsDir(): string {
  return resolve(here, "../db/migrations");
}

/** 一条假 GitHub 收到的请求，测试按它断言发了什么。 */
export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** 一条路由的答案。`etag` 在场时，带着相同 `if-none-match` 的请求答 304。 */
export interface FakeReply {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly etag?: string;
}

export type FakeHandler = (
  request: RecordedRequest,
) => FakeReply | undefined;

export interface FakeGithub {
  readonly base: string;
  readonly requests: RecordedRequest[];
  /** `GET /repos/a/b` 这样的 `<method> <path>`，查询串不参与匹配。 */
  route(key: string, reply: FakeReply | FakeHandler): void;
  /** 下一条匹配请求答这个，然后这条一次性规则就用掉了。 */
  once(key: string, reply: FakeReply | FakeHandler): void;
  client(options?: { attempts?: number }): GithubClient;
  close(): Promise<void>;
}

export async function fakeGithub(): Promise<FakeGithub> {
  const routes = new Map<string, FakeReply | FakeHandler>();
  const pending = new Map<string, (FakeReply | FakeHandler)[]>();
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((incoming, response) => {
    void (async () => {
      const recorded = await record(incoming);
      requests.push(recorded);
      const key = `${recorded.method} ${recorded.path}`;
      const queue = pending.get(key);
      const rule = queue !== undefined && queue.length > 0
        ? queue.shift()
        : routes.get(key);
      if (rule === undefined) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "no fake route" }));
        return;
      }
      const reply =
        typeof rule === "function" ? rule(recorded) : rule;
      if (reply === undefined) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "no fake route" }));
        return;
      }
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...reply.headers,
      };
      if (reply.etag !== undefined) {
        headers.etag = reply.etag;
        if (recorded.headers["if-none-match"] === reply.etag) {
          response.writeHead(304, headers);
          response.end();
          return;
        }
      }
      response.writeHead(reply.status ?? 200, headers);
      response.end(
        reply.body === undefined ? "" : JSON.stringify(reply.body),
      );
    })();
  });

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  return {
    base,
    requests,
    route(key, reply) {
      routes.set(key, reply);
    },
    once(key, reply) {
      const queue = pending.get(key) ?? [];
      queue.push(reply);
      pending.set(key, queue);
    },
    client(options = {}) {
      const client = new GithubClient({
        apiBase: "https://api.github.com",
        token: async () => "ghp_fixture_token",
        // 回环明文的地址进不了 `normalizeApiBase`，所以在 `fetch` 这一层重写：
        // client 仍然认为自己在对着公有 base 说话，路径、缓存键和引用校验都按
        // 那个走，只有目的地被换掉。
        fetch: (input, init) =>
          globalThis.fetch(
            String(input).replace("https://api.github.com", base),
            init,
          ),
        sleep: async () => {},
        ...(options.attempts === undefined ? {} : { attempts: options.attempts }),
      });
      return client;
    },
    async close() {
      await new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      });
    },
  };
}

async function record(incoming: IncomingMessage): Promise<RecordedRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  const url = new URL(incoming.url ?? "/", "http://fake");
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming.headers)) {
    headers[name] = Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
  }
  return {
    method: (incoming.method ?? "GET").toUpperCase(),
    path: url.pathname,
    headers,
    body: Buffer.concat(chunks).toString("utf8"),
  };
}

/** 内存里的密钥存储，测试永远不碰开发者真正的钥匙串或家目录。 */
export function memorySecrets(): SecretStore & {
  readonly values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    values,
    kind: () => "file_fallback",
    async put(name, token) {
      values.set(name, token);
    },
    async get(name) {
      const value = values.get(name);
      if (value === undefined) throw new Error("no such secret");
      return value;
    },
    async delete(name) {
      values.delete(name);
    },
  };
}

/** 一个永远答同一个令牌的假 `gh`。 */
export function stubGh(token = "ghp_from_gh_cli"): GhCli {
  return { token: async () => token };
}

export interface GithubFixture {
  readonly github: FakeGithub;
  readonly db: OpenedDatabase;
  readonly store: GithubStore;
  readonly credentials: CredentialService;
  readonly service: GithubService;
  readonly caller: Caller;
  readonly dataDir: string;
  close(): Promise<void>;
}

/** 一个配好 token_ref 凭据、指向假 GitHub 的 GitHub 服务。 */
export async function githubFixture(options: {
  readonly scopes?: readonly Scope[];
  readonly workspaceId?: string;
  readonly now?: () => number;
} = {}): Promise<GithubFixture> {
  const github = await fakeGithub();
  const dataDir = mkdtempSync(join(tmpdir(), "armadra-github-"));
  const db = openDatabase({
    file: join(dataDir, "canvas.db"),
    migrationsDir: migrationsDir(),
    unifiedMigrationsDir: unifiedMigrationsDir(),
  });
  const store = new GithubStore(db.database);
  const secrets = memorySecrets();
  const credentials = new CredentialService({
    store,
    secrets,
    gh: stubGh(),
    client: {
      fetch: (input, init) =>
        globalThis.fetch(
          String(input).replace("https://api.github.com", github.base),
          init,
        ),
      sleep: async () => {},
    },
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const workspaceId = options.workspaceId ?? "ws-1";
  const service = new GithubService({
    store,
    credentials,
    hostId: "host-1",
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const caller: Caller = {
    principalId: "principal-1",
    deviceId: "device-1",
    deviceEpoch: 1,
    workspaceId,
    scopes:
      options.scopes ??
      [
        scope("github:read", workspaceId, "host-1"),
        scope("github:write", workspaceId, "host-1"),
        scope("settings:write", workspaceId, "host-1"),
      ],
  };
  return {
    github,
    db,
    store,
    credentials,
    service,
    caller,
    dataDir,
    async close() {
      db.close();
      await github.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** 配一个粘贴令牌的凭据；`/user` 已经由这个夹具先答好。 */
export async function configureToken(
  fixture: GithubFixture,
  login = "octocat",
): Promise<void> {
  fixture.github.route("GET /user", { body: { login } });
  await fixture.credentials.configure(
    GithubCredentialSource.TOKEN_REF,
    "ghp_pasted_token_value",
    "",
    0,
  );
}
