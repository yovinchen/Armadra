import { describe, expect, it } from "vitest";

import {
  PUBLIC_API_BASE,
  apiHost,
  belongsTo,
  normalizeApiBase,
  parseRemote,
  validName,
  webHostFor,
} from "./remote";

/** 移植自 `apps/host/internal/githubapi/remote_test.go`。 */
describe("git remote 与 API base 的本地解析", () => {
  it("接受 https、ssh、git 与 scp 四种写法", () => {
    for (const value of [
      "https://github.com/owner/name.git",
      "ssh://git@github.com/owner/name.git",
      "git://github.com/owner/name",
      "git@github.com:owner/name.git",
    ]) {
      expect(parseRemote(value)).toEqual({
        owner: "owner",
        name: "name",
        webHost: "github.com",
      });
    }
  });

  it("企业版部署的路径前缀不影响仓库是最后两段", () => {
    expect(parseRemote("https://git.example.com/scm/team/repo.git")).toEqual({
      owner: "team",
      name: "repo",
      webHost: "git.example.com",
    });
  });

  it("拒绝没有 owner/name 的 remote 与不支持的协议", () => {
    expect(() => parseRemote("https://github.com/owner")).toThrow();
    expect(() => parseRemote("ftp://github.com/owner/name")).toThrow();
    expect(() => parseRemote("")).toThrow();
    expect(() => parseRemote("git@github.com")).toThrow();
  });

  it("只接受 HTTPS 的 API base，空值落到公有服务", () => {
    expect(normalizeApiBase("")).toBe(PUBLIC_API_BASE);
    expect(normalizeApiBase(undefined)).toBe(PUBLIC_API_BASE);
    expect(normalizeApiBase("https://git.example.com/api/v3/")).toBe(
      "https://git.example.com/api/v3",
    );
    // http 会把 bearer 令牌明文放到线上。
    expect(() => normalizeApiBase("http://git.example.com")).toThrow();
    // 带凭据、查询或片段的东西根本不是一个 base。
    expect(() => normalizeApiBase("https://u:p@git.example.com")).toThrow();
    expect(() => normalizeApiBase("https://git.example.com?x=1")).toThrow();
    expect(() => normalizeApiBase("https://git.example.com#f")).toThrow();
  });

  it("公有 base 只认 github.com 的三种写法，企业版必须主机相等", () => {
    expect(belongsTo(PUBLIC_API_BASE, "github.com")).toBe(true);
    expect(belongsTo(PUBLIC_API_BASE, "ssh.github.com")).toBe(true);
    expect(belongsTo(PUBLIC_API_BASE, "GitHub.com.")).toBe(true);
    expect(belongsTo(PUBLIC_API_BASE, "git.example.com")).toBe(false);
    const enterprise = "https://git.example.com/api/v3";
    expect(belongsTo(enterprise, "git.example.com")).toBe(true);
    expect(belongsTo(enterprise, "github.com")).toBe(false);
    expect(belongsTo(enterprise, "")).toBe(false);
  });

  it("web 主机与 API 主机分别报告", () => {
    expect(webHostFor(PUBLIC_API_BASE)).toBe("github.com");
    expect(apiHost(PUBLIC_API_BASE)).toBe("api.github.com");
    expect(webHostFor("https://git.example.com/api/v3")).toBe(
      "git.example.com",
    );
  });

  it("owner 与仓库名不接受能改写请求路径的字符", () => {
    expect(validName("armadra")).toBe(true);
    expect(validName("a.b-c_d")).toBe(true);
    expect(validName("../etc")).toBe(false);
    expect(validName("")).toBe(false);
    expect(validName("-leading")).toBe(false);
  });
});
