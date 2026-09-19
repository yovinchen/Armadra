import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GithubCredentialSource, GithubSecretStore } from "./types";

import { apiFailure } from "./errors";
import { githubFixture, type GithubFixture } from "./fixture";
import { reference, validToken } from "./credentials";

/** 移植自 `apps/host/internal/githubcred/service_test.go` 与 `secret_test.go`。 */
describe("GitHub 凭据", () => {
  let fixture: GithubFixture;

  beforeEach(async () => {
    fixture = await githubFixture();
  });

  afterEach(async () => {
    await fixture.close();
  });

  it("没配过的机器报 NOT_CONFIGURED 而不是一个空列表", async () => {
    const status = await fixture.credentials.status();
    expect(status.source).toBe(GithubCredentialSource.NONE);
    expect(status.available).toBe(false);
    expect(status.reasonCode).toBe("NOT_CONFIGURED");
  });

  it("没配凭据时建不出 client，而不是发一次匿名请求", () => {
    expect(() => fixture.credentials.apiClient()).toThrow("unsupported");
  });

  it("配置先核验再存，验不过就不留任何痕迹", async () => {
    fixture.github.route("GET /user", { status: 401 });
    await expect(
      fixture.credentials.configure(
        GithubCredentialSource.TOKEN_REF,
        "ghp_bad_token_value",
        "",
        0,
      ),
    ).rejects.toThrow("unavailable");
    // 库里没有行，密钥也被清掉了：状态不会声称一个没连上过的账号。
    expect(fixture.store.config()).toBeUndefined();
  });

  it("配置成功之后报账号与令牌 scope，但从不报令牌", async () => {
    fixture.github.route("GET /user", {
      body: { login: "octocat" },
      headers: { "x-oauth-scopes": "repo" },
    });
    const status = await fixture.credentials.configure(
      GithubCredentialSource.TOKEN_REF,
      "ghp_good_token_value",
      "",
      0,
    );
    expect(status.source).toBe(GithubCredentialSource.TOKEN_REF);
    expect(status.store).toBe(GithubSecretStore.FILE_FALLBACK);
    expect(status.accountLogin).toBe("octocat");
    expect(status.tokenScopes).toEqual(["repo"]);
    expect(status.revision).toBe(1n);
    // 整条状态里没有令牌的任何一部分。`bigint` 不能直接序列化，所以先转成字符串。
    const serialised = JSON.stringify(status, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    expect(serialised).not.toContain("ghp_good_token_value");
  });

  it("不存令牌的来源收到令牌时拒绝，而不是悄悄丢掉", async () => {
    await expect(
      fixture.credentials.configure(
        GithubCredentialSource.GH_CLI,
        "ghp_should_not_be_here",
        "",
        0,
      ),
    ).rejects.toThrow("invalid");
  });

  it("配置要 revision CAS", async () => {
    fixture.github.route("GET /user", { body: { login: "octocat" } });
    await fixture.credentials.configure(
      GithubCredentialSource.TOKEN_REF,
      "ghp_good_token_value",
      "",
      0,
    );
    await expect(
      fixture.credentials.configure(
        GithubCredentialSource.TOKEN_REF,
        "ghp_other_token_value",
        "",
        0,
      ),
    ).rejects.toThrow("conflict");
  });

  it("撤销把机器退回未配置，并删掉存着的密钥", async () => {
    fixture.github.route("GET /user", { body: { login: "octocat" } });
    const configured = await fixture.credentials.configure(
      GithubCredentialSource.TOKEN_REF,
      "ghp_good_token_value",
      "",
      0,
    );
    const revoked = await fixture.credentials.revoke(
      Number(configured.revision),
    );
    expect(revoked.source).toBe(GithubCredentialSource.NONE);
    expect(revoked.reasonCode).toBe("NOT_CONFIGURED");
    expect(() => fixture.credentials.apiClient()).toThrow("unsupported");
  });

  it("撤销一个从没配过的凭据是冲突，不是成功", async () => {
    await expect(fixture.credentials.revoke(0)).rejects.toThrow("conflict");
  });

  it("被远端拒掉的令牌在下一次状态里说出来", async () => {
    fixture.github.route("GET /user", { body: { login: "octocat" } });
    await fixture.credentials.configure(
      GithubCredentialSource.TOKEN_REF,
      "ghp_good_token_value",
      "",
      0,
    );
    fixture.credentials.noteFailure(
      apiFailure("PERMISSION_DENIED", 403, "FORBIDDEN"),
    );
    const status = await fixture.credentials.status();
    // 令牌还在，但上一次用它发的请求被拒了；只说「可用」会把这件事藏起来。
    expect(status.available).toBe(true);
    expect(status.reasonCode).toBe("INSUFFICIENT_SCOPES");
  });

  it("gh CLI 来源不往密钥存储里写任何东西", async () => {
    fixture.github.route("GET /user", { body: { login: "octocat" } });
    const status = await fixture.credentials.configure(
      GithubCredentialSource.GH_CLI,
      "",
      "",
      0,
    );
    expect(status.source).toBe(GithubCredentialSource.GH_CLI);
    expect(status.store).toBe(GithubSecretStore.NONE);
    expect(fixture.store.config()?.secretRef).toBe("");
  });

  it("令牌形状拒绝换行与控制字符", () => {
    expect(validToken("ghp_abcdefgh")).toBe(true);
    expect(validToken("short")).toBe(false);
    expect(validToken("ghp_with\nnewline")).toBe(false);
    expect(validToken("")).toBe(false);
  });

  it("引用名是账号标签，从不是密钥", () => {
    expect(reference("api.github.com")).toBe("api@api.github.com");
    expect(() => reference("not a host")).toThrow("invalid");
  });
});
