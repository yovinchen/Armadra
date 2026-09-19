import { describe, expect, it } from "vitest";
import { IdentityError } from "./errors";
import { SHARE_ROLES, rolePermissions, roleScopes } from "./roles";
import { PERMISSIONS, normalizeScopes } from "./scopes";

/**
 * 角色编译表的快照。
 *
 * 这些数组就是共享对话框里那四个单选项的全部含义，所以它们逐条写死在这里：
 * 给某个角色多一条权限是一次产品决定，应该在这个文件的 diff 里看得见。
 */
describe("角色到 scope 的编译", () => {
  it("四个角色各自的权限集合", () => {
    expect(rolePermissions("viewer")).toEqual([
      "assets:read",
      "canvas:read",
      "events:read",
      "terminal:read",
    ]);
    expect(rolePermissions("editor")).toEqual([
      "assets:read",
      "assets:write",
      "canvas:read",
      "canvas:write",
      "events:read",
      "mermaid:import",
      "terminal:read",
    ]);
    expect(rolePermissions("operator")).toEqual([
      "agent:launch",
      "assets:read",
      "assets:write",
      "canvas:read",
      "canvas:write",
      "events:read",
      "files:read",
      "files:write",
      "git:read",
      "git:write",
      "mermaid:import",
      "terminal:create",
      "terminal:read",
    ]);
    expect(rolePermissions("driver")).toEqual([
      "agent:launch",
      "approval:answer",
      "assets:read",
      "assets:write",
      "canvas:read",
      "canvas:write",
      "events:read",
      "files:read",
      "files:write",
      "git:read",
      "git:write",
      "mermaid:import",
      "terminal:create",
      "terminal:drive",
      "terminal:read",
    ]);
  });

  it("链条是单调的：后一档包含前一档", () => {
    for (let index = 1; index < SHARE_ROLES.length; index += 1) {
      const lower = rolePermissions(SHARE_ROLES[index - 1] as "viewer");
      const higher = rolePermissions(SHARE_ROLES[index] as "editor");
      for (const permission of lower) expect(higher).toContain(permission);
    }
  });

  it("编译出来的每条权限都在授权词汇表里，且能入库", () => {
    for (const role of SHARE_ROLES) {
      const scopes = roleScopes(role, "workspace-1");
      for (const value of scopes) {
        expect(PERMISSIONS as readonly string[]).toContain(value.Permission);
        expect(value.WorkspaceID).toBe("workspace-1");
      }
      // 入库前要过 `normalizeScopes`：编译出一条它拒绝的授权，等于编译出一份
      // 永远存不下去的会话。
      expect(() => normalizeScopes(scopes)).not.toThrow();
    }
  });

  it("没有工作空间的角色授予会变成全局放权，所以直接拒绝", () => {
    expect(() => roleScopes("viewer", "")).toThrow(IdentityError);
  });

  it("owner 不是共享角色", () => {
    expect(() => roleScopes("owner" as "viewer", "w")).toThrow(IdentityError);
  });
});
