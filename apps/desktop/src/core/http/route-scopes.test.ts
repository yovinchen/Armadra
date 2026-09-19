import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "../identity/scopes";
import { routeScope, workspaceOf } from "./route-scopes";
import { Router } from "./router";
import { ROUTES } from "./routes";

/**
 * 路由的 scope 声明（设计 §4.1）。
 *
 * 最重要的一条不是某条路由要什么权限，而是**没有一条已实现的路由是漏掉的**：
 * 漏掉一条，等到有第二个 principal 时它就是一个默认放行的洞。
 */
describe("路由要求的 scope", () => {
  it("每条已实现的运行时路由都声明了权限", () => {
    const router = new Router();
    const missing: string[] = [];
    for (const entry of ROUTES) {
      if (entry.surface !== "runtime" || entry.implemented !== true) continue;
      for (const method of entry.methods) {
        // 健康检查与 Hello 先于任何身份存在：前者答「core 起来了」，后者答
        // 「这台 core 是谁、支持什么」，两者都要在一次配对之前就说得出来。
        if (entry.path.endsWith("/health")) continue;
        if (entry.path === "/api/identity/hello") continue;
        if (router.requiredScope(method, entry.path) === undefined) {
          missing.push(`${method} ${entry.path}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("声明出来的权限名都在授权词汇表里", () => {
    const router = new Router();
    for (const entry of ROUTES) {
      if (entry.surface !== "runtime") continue;
      for (const method of entry.methods) {
        const required = router.requiredScope(method, entry.path);
        if (required === undefined) continue;
        expect(PERMISSIONS as readonly string[]).toContain(required.permission);
      }
    }
  });

  it("读与写分开，终端的开与写也分开", () => {
    expect(
      routeScope("GET", "/api/workspaces/{workspaceId}/git/status"),
    ).toEqual({ permission: "git:read", workspaceId: "" });
    expect(
      routeScope("POST", "/api/workspaces/{workspaceId}/git/commit"),
    ).toEqual({ permission: "git:write", workspaceId: "" });
    expect(routeScope("POST", "/api/terminals")?.permission).toBe(
      "terminal:create",
    );
    expect(routeScope("POST", "/api/terminals/abc/paste")?.permission).toBe(
      "terminal:write",
    );
    expect(routeScope("GET", "/api/terminals/abc/ws")?.permission).toBe(
      "terminal:read",
    );
    expect(routeScope("POST", "/api/approvals/p1/answer")?.permission).toBe(
      "approval:answer",
    );
  });

  it("健康检查不要求任何权限", () => {
    expect(routeScope("GET", "/health")).toBeUndefined();
    expect(routeScope("GET", "/api/health")).toBeUndefined();
  });

  it("真实路径上的授权绑在那个工作空间上", () => {
    const router = new Router();
    // 表里没有的路径也照样算得出要求：路由表回 404 之前，判定入口已经知道
    // 这条路径属于哪块画布。
    expect(
      router.requiredScope("GET", "/api/workspaces/w-7/canvas-missing"),
    ).toEqual({ permission: "canvas:read", workspaceId: "w-7" });
    expect(
      router.requiredScope("GET", "/api/workspaces/w-7/git/status"),
    ).toEqual({ permission: "git:read", workspaceId: "w-7" });
    expect(workspaceOf("/api/workspaces/{workspaceId}/git/status")).toBe("");
    expect(workspaceOf("/api/workspaces/w%201/git/status")).toBe("w 1");
  });

  it("登记时就地声明的权限盖过表", () => {
    const router = new Router();
    router.handle(
      "GET",
      "/api/workspaces/{workspaceId}/git/status",
      () => ({ status: 200 }),
      { scope: "identity:manage" },
    );
    expect(
      router.requiredScope("GET", "/api/workspaces/w-7/git/status"),
    ).toEqual({ permission: "identity:manage", workspaceId: "w-7" });
    // 没声明的方法仍然按表来。
    expect(
      router.requiredScope("POST", "/api/workspaces/w-7/git/status"),
    ).toEqual({ permission: "git:write", workspaceId: "w-7" });
  });
});
