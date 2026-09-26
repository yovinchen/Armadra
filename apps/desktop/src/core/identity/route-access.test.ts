import type { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/open";
import { Router, emptyRequest } from "../http/router";
import { tempDir } from "../testing/temp-dir";
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

/**
 * 对象 → 工作空间：终端 `t1`、节点 `n1`、审批 `p1`、关闭确认 `c1` 都在 w1 上，
 * 别的都不认识。创建者记在一张表里，像库里那一列一样跨「重启」（重建路由门）。
 */
const creators = new Map<string, string>();
const lookups = {
  sessionWorkspace: (id: string) => (id === "t1" ? "w1" : ""),
  sessionCreator: (id: string) => creators.get(id) ?? "",
  recordCreator: (id: string, principalId: string) => {
    creators.set(id, principalId);
  },
  nodeWorkspace: (id: string) => (id === "n1" ? "w1" : ""),
  approvalWorkspace: (id: string) => (id === "p1" ? "w1" : ""),
  confirmWorkspace: (id: string) => (id === "c1" ? "w1" : ""),
};

function harness() {
  const router = new Router();
  const guard = createRouteGuard({
    database: {} as DatabaseSync,
    permits: (who, required) =>
      permits([...who.scopes, ...granted(who.principalId)], required),
    effectiveScopes: (who) => [...who.scopes, ...granted(who.principalId)],
    lookups,
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
    creators.clear();
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

  it("operator 自己开的终端自己能写，路由门重建（core 重启）之后照旧", () => {
    creators.clear();
    const created = harness().decide("operator", "POST", "/api/terminals", {
      workspaceId: "w1",
    });
    expect(created.allowed).toBe(true);
    created.filter?.({ id: "t1" });
    expect(creators.get("t1")).toBe("operator");
    // 新的一道门：内存里什么都没有，创建者只在「库」里。
    const { decide } = harness();
    expect(decide("operator", "POST", "/api/terminals/t1/paste").allowed).toBe(
      true,
    );
    expect(decide("operator", "GET", "/api/terminals/t1/ws").allowed).toBe(
      true,
    );
    // 别人仍然要 driver。
    expect(decide("editor", "POST", "/api/terminals/t1/paste").allowed).toBe(
      false,
    );
    expect(row(decide, "POST", "/api/terminals/t1/paste")).toBe(
      "owner,driver,operator",
    );
    creators.clear();
  });
});

/**
 * 全局路由的权限表（设计 §6）：每一行是一条路由对六个人的答案。成员能不能
 * 做由它落到哪块画布决定；落不到画布的，要么是无害的全局读（被共享了任意一块
 * 画布就行），要么是本机管理（只有 owner）。
 */
describe("全局路由的权限表", () => {
  const SHARED = "owner,driver,operator,editor,viewer,outsider";
  const W1_ALL = "owner,driver,operator,editor,viewer";
  const TABLE: readonly [string, string, string][] = [
    // 无害的全局读
    ["GET", "/api/agents", SHARED],
    ["GET", "/api/agents/claude/models", SHARED],
    ["GET", "/api/models/catalog", SHARED],
    ["GET", "/api/terminals/backend", SHARED],
    ["GET", "/api/usage/status", SHARED],
    // 按对象落到工作空间
    ["POST", "/api/agent-status/n1/read", W1_ALL],
    ["GET", "/api/agent-status/n1/transcript", W1_ALL],
    [
      "POST",
      "/api/agent-status/n1/suggest-title",
      "owner,driver,operator,editor",
    ],
    ["GET", "/api/nodes/n1/context-reads", W1_ALL],
    ["POST", "/api/approvals/p1/answer", "owner,driver"],
    ["POST", "/api/control/confirm/c1", "owner,driver"],
    // 找不到对象的：只有 owner
    ["POST", "/api/agent-status/unknown/read", "owner"],
    ["GET", "/api/nodes/unknown/context-reads", "owner"],
    ["POST", "/api/approvals/unknown/answer", "owner"],
    ["POST", "/api/control/confirm/unknown", "owner"],
    // 本机管理
    ["GET", "/api/settings", "owner"],
    ["PATCH", "/api/settings", "owner"],
    ["GET", "/api/settings/local", "owner"],
    ["PUT", "/api/settings/local", "owner"],
    ["POST", "/api/models/catalog/refresh", "owner"],
    ["GET", "/api/agents/claude/integration", "owner"],
    ["POST", "/api/agents/claude/integration/install", "owner"],
    ["GET", "/api/execution-hosts", "owner"],
    ["POST", "/api/execution-hosts", "owner"],
    ["GET", "/api/ssh/hosts/h1/test", "owner"],
    ["GET", "/api/ssh/prompts", "owner"],
    ["GET", "/api/data/info", "owner"],
    ["POST", "/api/data/backup", "owner"],
    ["GET", "/api/usage", "owner"],
    ["GET", "/api/usage/copilot", "owner"],
    ["GET", "/api/conversations", "owner"],
    ["POST", "/api/git/clone", "owner"],
    ["GET", "/api/power", "owner"],
    ["POST", "/api/power/leases", "owner"],
    ["GET", "/api/github/status", "owner"],
    ["GET", "/api/automations/plans", "owner"],
    ["POST", "/browser/open", "owner"],
    ["POST", "/api/terminals/t1/node-token/refresh", "owner"],
    ["GET", "/api/ownership", "owner"],
  ];

  for (const [method, path, expected] of TABLE) {
    it(`${method} ${path}`, () => {
      const { decide } = harness();
      expect(row(decide, method, path)).toBe(expected);
    });
  }

  it("没被共享任何画布的成员连无害的全局读也没有", () => {
    const { decide } = harness();
    expect(decide("stranger", "GET", "/api/agents").allowed).toBe(false);
    expect(decide("stranger", "GET", "/api/terminals/backend").allowed).toBe(
      false,
    );
  });
});

describe("真库上的查询", () => {
  it("终端创建者落进会话行，新建的路由门照样认；节点与审批按库找画布", () => {
    const opened = openDatabase({
      file: join(tempDir("armadra-route-access-"), "canvas.db"),
      migrationsDir: resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../db/migrations",
      ),
    });
    try {
      const db = opened.database;
      db.prepare(
        "INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES ('w1', 'w1', '/tmp/w1', 'x', 'x')",
      ).run();
      db.prepare(
        "INSERT INTO terminal_sessions (id, workspace_id, cwd, shell, status, created_at) VALUES ('t1', 'w1', '/', 'sh', 'running', 'x')",
      ).run();
      db.prepare(
        "INSERT INTO agent_status (node_id, workspace_id, agent_id, updated_at) VALUES ('n1', 'w1', 'claude', 'x')",
      ).run();
      db.prepare(
        "INSERT INTO agent_approvals (id, node_id, workspace_id, request_json, created_at) VALUES ('p1', 'n1', 'w1', '{}', 'x')",
      ).run();
      // 每次判定都新建一道门：内存里什么也不留，像每次都是重启之后。
      const as = (who: string, method: string, path: string, body?: unknown) =>
        runAs({ subject: subject(who) }, () =>
          createRouteGuard({
            database: db,
            permits: (actor, required) =>
              permits(
                [...actor.scopes, ...granted(actor.principalId)],
                required,
              ),
          })(
            { ...emptyRequest(method, path), json: <T>() => body as T },
            new Router().requiredScope(method, path),
          ),
        );

      expect(as("operator", "POST", "/api/terminals/t1/paste").allowed).toBe(
        false,
      );
      as("operator", "POST", "/api/terminals", { workspaceId: "w1" }).filter?.({
        id: "t1",
      });
      expect(
        db.prepare("SELECT creator_principal_id FROM terminal_sessions").get(),
      ).toEqual({ creator_principal_id: "operator" });
      expect(as("operator", "POST", "/api/terminals/t1/paste").allowed).toBe(
        true,
      );
      expect(as("viewer", "POST", "/api/agent-status/n1/read").allowed).toBe(
        true,
      );
      expect(as("outsider", "POST", "/api/agent-status/n1/read").allowed).toBe(
        false,
      );
      expect(as("driver", "POST", "/api/approvals/p1/answer").allowed).toBe(
        true,
      );
      expect(as("operator", "POST", "/api/approvals/p1/answer").allowed).toBe(
        false,
      );
      expect(as("viewer", "GET", "/api/nodes/n1/context-reads").allowed).toBe(
        true,
      );
    } finally {
      opened.close();
    }
  });
});
