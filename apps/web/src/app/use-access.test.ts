import { describe, expect, it } from "vitest";

import type { IdentitySession } from "../api/identity";
import { accessOf } from "./use-access";

/**
 * 页面据以摆不摆入口的那份判定：owner 全权；成员按会话里「快照 ∪ 现编的共享」
 * 逐块画布回答；没登录、还没取回来都按成员算。
 */

function session(
  role: string,
  scopes: { permission: string; workspaceId?: string }[],
): IdentitySession {
  return {
    hostId: "h".repeat(32),
    device: {
      deviceId: "d".repeat(32),
      principalId: "p".repeat(32),
      displayName: "",
      role,
      createdAtUnixMs: 1,
      revision: 1,
    },
    scopes: scopes.map((scope) => ({
      permission: scope.permission,
      workspaceId: scope.workspaceId ?? "",
      executionHostId: "",
    })),
    expiresAtUnixMs: 0,
  };
}

describe("accessOf", () => {
  it("owner 什么都能做", () => {
    const access = accessOf(session("owner", []));
    expect(access.member).toBe(false);
    expect(access.can("approval:answer", "w1")).toBe(true);
  });

  it("成员按画布上的授权回答", () => {
    const access = accessOf(
      session("member", [
        { permission: "identity:read" },
        { permission: "canvas:read", workspaceId: "w1" },
        { permission: "approval:answer", workspaceId: "w1" },
      ]),
    );
    expect(access.member).toBe(true);
    expect(access.can("approval:answer", "w1")).toBe(true);
    expect(access.can("approval:answer", "w2")).toBe(false);
    expect(access.can("settings:write")).toBe(false);
  });

  it("没登录与还没取回来都按成员算", () => {
    expect(accessOf(null).member).toBe(true);
    expect(accessOf(undefined).can("canvas:read", "w1")).toBe(false);
  });
});
