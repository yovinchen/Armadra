import { describe, expect, it } from "vitest";
import { ROUTES } from "./routes";
import { Router } from "./router";

/**
 * 路由表自己的规矩。
 *
 * R7 之前这里还逐条对着 Rust Runtime 的 `lib.rs` 与 `hook/mod.rs` 解析、比对，
 * 因为那时候有两个实现，而两边漂移一条页面就会在某一台机器上撞 404。现在只剩
 * 一个实现，表就是**这一个**实现的说法，所以守的是表内部的一致性：没有重复的
 * 路径、每条路径至少收一个方法、没写的那些答 501 并说得出是哪一条、以及三条入站
 * WebSocket 路径还在表里。
 */
describe("路由表", () => {
  it("没有一条路径出现两次", () => {
    expect(new Set(ROUTES.map((route) => route.path)).size).toBe(ROUTES.length);
  });

  it("每条路径都有前导斜杠、没有尾斜杠，并且至少收一个方法", () => {
    for (const route of ROUTES) {
      expect(route.path.startsWith("/"), route.path).toBe(true);
      expect(route.path.endsWith("/"), route.path).toBe(false);
      expect(route.methods.length, route.path).toBeGreaterThan(0);
      for (const method of route.methods) {
        expect(
          ["GET", "POST", "PUT", "PATCH", "DELETE"],
          `${route.path} ${method}`,
        ).toContain(method);
      }
    }
  });

  it("只有两张面：主监听器和 hook 那一条回环服务", () => {
    for (const route of ROUTES) {
      expect(["runtime", "hook"], route.path).toContain(route.surface);
    }
    expect(
      ROUTES.filter((route) => route.surface === "hook").length,
    ).toBeGreaterThan(0);
  });

  it("两条健康路径是答得出来的", () => {
    const implemented = ROUTES.filter((route) => route.implemented).map(
      (route) => route.path,
    );
    expect(implemented).toContain("/health");
    expect(implemented).toContain("/api/health");
  });

  it("没写的路由答 501 并说出是哪一条，而不是 404", async () => {
    const router = new Router();
    const unimplemented = ROUTES.filter(
      (route) => route.surface === "runtime" && !route.implemented,
    );
    for (const route of unimplemented) {
      const concrete = route.path.replace(/\{[a-zA-Z]+\}/g, "sample");
      const answer = await router.dispatch(
        route.methods[0] as string,
        concrete,
      );
      expect(answer.status, route.path).toBe(501);
      const body = answer.body as { code: string; message: string };
      expect(body.code, route.path).toBe("not_implemented");
      // 501 的正文说出的是表里那条路径本身：页面据此知道「这条路在契约里，这个
      // 构建还没写」，而不是「你拼错了」。
      expect(body.message, route.path).toBe(`未实现：${route.path}`);
    }
  });

  it("表里没有的路径是 404，不是 501", async () => {
    const answer = await new Router().dispatch("GET", "/api/not-a-route");
    expect(answer.status).toBe(404);
  });

  it("三条入站 WebSocket 路径还在表里", () => {
    // 契约 §5.1：三条入站流，它们不能变成 404。
    for (const path of [
      "/api/terminals/{sessionId}/ws",
      "/api/workspaces/{workspaceId}/events",
      "/api/workspaces/{workspaceId}/language/sessions/{sessionId}/stream",
    ]) {
      expect(
        ROUTES.some((route) => route.path === path),
        path,
      ).toBe(true);
    }
  });

  it("三张 JSON 面在表里，它们是页面今天真打的那几条", () => {
    for (const path of [
      "/api/github/{verb}",
      "/api/automations/{resource}",
      "/api/identity/hello",
    ]) {
      expect(
        ROUTES.some((route) => route.path === path),
        path,
      ).toBe(true);
    }
  });
});
