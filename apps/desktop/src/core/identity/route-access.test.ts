import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Router, emptyRequest } from "../http/router";
import type { AuthorizationSubject } from "./authorize";
import { runAs } from "./gate";
import { type ShareRole, roleScopes } from "./roles";
import { createRouteGuard } from "./route-access";
import { type Scope, permits, scope } from "./scopes";

/**
 * 路由门的矩阵：同一组请求，owner / driver / operator / editor / viewer /
 * 非成员各得到什么。授予在这里是一张表（成员 → 工作空间 → 角色），判定照真的
 * 那条走：角色编译成 scope，再进 `permits`。
 */

const GRANTS: Record<string, Record<string, ShareRole>> = {
  driver: { w1: "driver" },
  operator: { w1: "operator" },
  editor: { w1: "editor" },
  viewer: { w1: "viewer" },
  outsider: { w2: "driver" },
};

function subject(name: string): AuthorizationSubject {
  return name === "owner"
    ? { principalId: "", kind: "owner", scopes: [] }
    : { principalId: name, kind: "member", scopes: [scope("identity:read")] };
}

function granted(principalId: string): Scope[] {
  return Object.entries(GRANTS[principalId] ?? {}).flatMap(
    ([workspaceId, role]) => [...roleScopes(role, workspaceId)],
  );
}

/** 终端会话 → 工作空间：`t1` 在 w1 上，别的都不认识。 */
const database = {
  prepare: () => ({
    get: (id: string) => (id === "t1" ? { workspace_id: "w1" } : undefined),
  }),
} as unknown as DatabaseSync;

function harness() {
  const router = new Router();
  const guard = createRouteGuard({
    database,
    permits: (who, required) =>
      permits([...who.scopes, ...granted(who.principalId)], required),
  });
  const decide = (
    who: string | undefined,
    method: string,
    path: string,
    body?: unknown,
  ) => {
    const request = {
      ...emptyRequest(method, path),
      json: <T>() => body as T,
    };
    const run = () => guard(request, router.requiredScope(method, path));
    return who === undefined ? run() : runAs({ subject: subject(who) }, run);
  };
  return { guard, decide };
}

const PEOPLE = [
  "owner",
  "driver",
  "operator",
  "editor",
  "viewer",
  "outsider",
] as const;

function row(
  decide: ReturnType<typeof harness>["decide"],
  method: string,
  path: string,
  body?: unknown,
): string {
  return PEOPLE.filter((who) => decide(who, method, path, body).allowed).join(
    ",",
  );
}

describe("路由门的矩阵", () => {
  it("没有请求身份（桌面壳）时一律放行", () => {
    const { decide } = harness();
    expect(decide(undefined, "DELETE", "/api/workspaces/w1").allowed).toBe(
      true,
    );
    expect(decide(undefined, "GET", "/api/settings").allowed).toBe(true);
  });

  it("画布读写按角色链收窄，非成员一律不放", () => {
    const { decide } = harness();
    expect(row(decide, "GET", "/api/workspaces/w1/boards")).toBe(
      "owner,driver,operator,editor,viewer",
    );
    expect(row(decide, "POST", "/api/workspaces/w1/boards")).toBe(
      "owner,driver,operator,editor",
    );
    // `open` 只是记最近打开时间，看得见就能做。
    expect(row(decide, "POST", "/api/workspaces/w1/open")).toBe(
      "owner,driver,operator,editor,viewer",
    );
    expect(row(decide, "GET", "/api/workspaces/w1/git/status")).toBe(
      "owner,driver,operator",
    );
    expect(row(decide, "GET", "/api/workspaces/w1/events")).toBe(
      "owner,driver,operator,editor,viewer",
    );
  });

  it("工作空间本身、全局设置与表外路由只有 owner", () => {
    const { decide } = harness();
    expect(row(decide, "PATCH", "/api/workspaces/w1")).toBe("owner");
    expect(row(decide, "DELETE", "/api/workspaces/w1")).toBe("owner");
    expect(row(decide, "GET", "/api/settings")).toBe("owner");
    expect(row(decide, "POST", "/api/workspaces")).toBe("owner");
    expect(row(decide, "GET", "/api/not-in-the-table")).toBe("owner");
  });

  it("身份域自己判，不经路由门", () => {
    const { decide } = harness();
    expect(row(decide, "GET", "/api/identity/groups")).toBe(PEOPLE.join(","));
  });

  it("工作空间列表放行，只留看得见的", () => {
    const { decide } = harness();
    const list = [{ id: "w1" }, { id: "w2" }, { id: "w3" }];
    const visible = (who: string) =>
      (decide(who, "GET", "/api/workspaces").filter?.(list) ?? list) as {
        id: string;
      }[];
    expect(visible("owner").map((item) => item.id)).toEqual(["w1", "w2", "w3"]);
    expect(visible("viewer").map((item) => item.id)).toEqual(["w1"]);
    expect(visible("outsider").map((item) => item.id)).toEqual(["w2"]);
  });

  it("终端：开要 operator，写自己开的要 operator，写别人的要 driver", () => {
    const { decide } = harness();
    expect(
      row(decide, "POST", "/api/terminals", { workspaceId: "w1", cwd: "/" }),
    ).toBe("owner,driver,operator");
    // 读画面（capture）viewer 就够。
    expect(row(decide, "GET", "/api/terminals/t1/capture")).toBe(
      "owner,driver,operator,editor,viewer",
    );
    // 附着的 socket 能写：没记过创建者的会话按「别人的」判。
    expect(row(decide, "GET", "/api/terminals/t1/ws")).toBe("owner,driver");
    expect(row(decide, "POST", "/api/terminals/t1/paste")).toBe("owner,driver");
    // 不知道属于哪块画布的会话，成员一律不放。
    expect(row(decide, "GET", "/api/terminals/unknown/capture")).toBe("owner");
  });

  it("operator 自己开的终端自己能写", () => {
    const { decide } = harness();
    const created = decide("operator", "POST", "/api/terminals", {
      workspaceId: "w1",
    });
    expect(created.allowed).toBe(true);
    created.filter?.({ id: "t1" });
    expect(decide("operator", "POST", "/api/terminals/t1/paste").allowed).toBe(
      true,
    );
    expect(decide("operator", "GET", "/api/terminals/t1/ws").allowed).toBe(
      true,
    );
    // 别的 operator 仍然要 driver。
    expect(decide("editor", "POST", "/api/terminals/t1/paste").allowed).toBe(
      false,
    );
  });
});
