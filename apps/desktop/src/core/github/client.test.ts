import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_CACHED_ISSUES, MAX_CACHE_BYTES, nextPage, perPage } from "./client";
import { codeOf } from "./errors";
import { fakeGithub, type FakeGithub } from "./fixture";

/** 移植自 `apps/host/internal/githubapi/client_test.go`。 */
describe("GitHub 传输层", () => {
  let github: FakeGithub;

  beforeEach(async () => {
    github = await fakeGithub();
  });

  afterEach(async () => {
    await github.close();
  });

  it("ETag 命中时放回存着的正文，并标成来自缓存", async () => {
    github.route("GET /repos/a/b", {
      body: { full_name: "a/b" },
      etag: '"v1"',
    });
    const client = github.client();
    const first = await client.get("/repos/a/b");
    expect(first.fromCache).toBe(false);
    const second = await client.get("/repos/a/b");
    expect(second.fromCache).toBe(true);
    expect(second.status).toBe(200);
    expect(JSON.parse(second.body.toString("utf8"))).toEqual({
      full_name: "a/b",
    });
    // 第二次确实发出去了，只是远端答了 304——省的是配额不是往返。
    expect(github.requests).toHaveLength(2);
    expect(github.requests[1]?.headers["if-none-match"]).toBe('"v1"');
  });

  it("只从 Link 头里读页码，从不交回远端 URL", () => {
    expect(
      nextPage('<https://api.github.com/repos/a/b/issues?page=3>; rel="next"'),
    ).toBe(3);
    // 一个 URL 形式的游标会让响应操纵下一次请求，所以只有页码被取出来。
    expect(nextPage('<https://evil.example/x?page=2>; rel="prev"')).toBe(0);
    expect(nextPage("")).toBe(0);
    expect(nextPage('<https://api.github.com/x?page=99999>; rel="next"')).toBe(0);
  });

  it("读失败会退避重试，写一次都不重试", async () => {
    github.once("GET /repos/a/b", { status: 503 });
    github.route("GET /repos/a/b", { body: { full_name: "a/b" } });
    const client = github.client();
    await expect(client.get("/repos/a/b")).resolves.toBeDefined();
    expect(github.requests.filter((r) => r.method === "GET")).toHaveLength(2);

    github.route("POST /repos/a/b/issues", { status: 503 });
    // 500 段的写报 UNKNOWN_OUTCOME：请求可能已经生效，重试会重复一条评论。
    const error = await client
      .write("POST", "/repos/a/b/issues", { title: "x" })
      .catch((value: unknown) => value);
    expect(codeOf(error)).toBe("UNKNOWN_OUTCOME");
    expect(
      github.requests.filter((r) => r.method === "POST"),
    ).toHaveLength(1);
  });

  it("403 只有在配额头说被限流时才读成限流", async () => {
    const client = github.client();
    github.once("GET /repos/a/b", {
      status: 403,
      headers: { "x-ratelimit-remaining": "17", "x-ratelimit-limit": "60" },
    });
    expect(codeOf(await client.get("/repos/a/b").catch((e: unknown) => e))).toBe(
      "PERMISSION_DENIED",
    );
    github.once("GET /repos/a/c", {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-limit": "60" },
    });
    expect(codeOf(await client.get("/repos/a/c").catch((e: unknown) => e))).toBe(
      "RESOURCE_EXHAUSTED",
    );
  });

  it("重定向被当成错误，而不是跟着走到另一个 authority", async () => {
    github.route("GET /repos/a/b", {
      status: 302,
      headers: { location: "https://evil.example/repos/a/b" },
    });
    const client = github.client({ attempts: 1 });
    const error = await client.get("/repos/a/b").catch((value: unknown) => value);
    expect(codeOf(error)).toBe("INVALID_ARGUMENT");
    // 只联系了配置好的那个 base。
    expect(github.requests).toHaveLength(1);
  });

  it("会改写目的地的路径一律拒绝", async () => {
    const client = github.client();
    for (const path of ["repos/a/b", "/repos//a", "/repos/a?x=1", "/a\\b"]) {
      const error = await client.get(path).catch((value: unknown) => value);
      expect(codeOf(error)).toBe("INVALID_ARGUMENT");
    }
    expect(github.requests).toHaveLength(0);
  });

  it("限流头会让下一次写在本地被拒，而不是加深次级限流", async () => {
    const client = github.client();
    github.once("GET /repos/a/b", {
      status: 429,
      headers: { "retry-after": "30" },
    });
    await client.get("/repos/a/b").catch(() => undefined);
    const error = await client
      .write("POST", "/repos/a/b/issues", {})
      .catch((value: unknown) => value);
    expect(codeOf(error)).toBe("RESOURCE_EXHAUSTED");
    expect(github.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("X-OAuth-Scopes 报出来的 scope 被读出来，没报就是空列表", async () => {
    const client = github.client();
    github.once("GET /user", {
      body: { login: "octocat" },
      headers: { "x-oauth-scopes": "repo, read:org" },
    });
    expect((await client.get("/user")).oauthScopes).toEqual([
      "repo",
      "read:org",
    ]);
    github.once("GET /user", { body: { login: "octocat" } });
    // 细粒度令牌一个都不报；空列表的意思是「没报」，不是「没有权限」。
    expect((await client.get("/user")).oauthScopes).toEqual([]);
  });

  it("缓存满了逐出最近最少使用的那条，而不是继续长", async () => {
    const client = github.client();
    for (let index = 0; index < 120; index += 1) {
      github.route(`GET /repos/a/r${index}`, {
        body: { id: index },
        etag: `"e${index}"`,
      });
      await client.get(`/repos/a/r${index}`);
    }
    // 第 0 条早被逐出了：再读一次不会命中 304。
    const before = github.requests.length;
    const again = await client.get("/repos/a/r0");
    expect(again.fromCache).toBe(false);
    expect(github.requests.length).toBe(before + 1);
    expect(client.cachedBytes()).toBeLessThanOrEqual(MAX_CACHE_BYTES);
  });

  it("缓存的条目上限由「最多 10000 条 issue」导出", () => {
    expect(MAX_CACHED_ISSUES).toBe(10_000);
    expect(MAX_CACHE_BYTES).toBe(64 * 1024 * 1024);
  });

  it("per_page 被夹在 GitHub 自己的上限内", () => {
    expect(perPage(0)).toBe("100");
    expect(perPage(30)).toBe("30");
    expect(perPage(5_000)).toBe("100");
  });
});
