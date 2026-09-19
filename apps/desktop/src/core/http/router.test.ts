import { describe, expect, it } from "vitest";
import { Router } from "./router";
import type { RouteEntry } from "./routes";

const TABLE: RouteEntry[] = [
  { path: "/health", methods: ["GET"], surface: "runtime", implemented: true },
  {
    path: "/api/workspaces",
    methods: ["GET", "POST"],
    surface: "runtime",
  },
  {
    path: "/api/workspaces/remote",
    methods: ["POST"],
    surface: "runtime",
  },
  {
    path: "/api/workspaces/{workspaceId}",
    methods: ["PATCH", "DELETE"],
    surface: "runtime",
  },
  {
    path: "/hook/{agentId}",
    methods: ["POST"],
    surface: "hook",
  },
];

const router = (): Router => new Router(TABLE);

describe("route matching", () => {
  it("prefers a literal segment to a parameter", () => {
    // `/api/workspaces/remote` must not be eaten by `/{workspaceId}`.
    expect(router().match("/api/workspaces/remote")?.entry.path).toBe(
      "/api/workspaces/remote",
    );
    expect(router().match("/api/workspaces/ws-1")?.entry.path).toBe(
      "/api/workspaces/{workspaceId}",
    );
  });

  it("captures and decodes parameters", () => {
    expect(router().match("/api/workspaces/a%2Fb")?.params).toEqual({
      workspaceId: "a/b",
    });
  });

  it("ignores a trailing slash but not a missing segment", () => {
    expect(router().match("/api/workspaces/")?.entry.path).toBe(
      "/api/workspaces",
    );
    expect(router().match("/api/workspaces/ws-1/extra")).toBeUndefined();
  });

  it("only sees its own surface", () => {
    expect(router().match("/hook/claude")).toBeUndefined();
    expect(new Router(TABLE, "hook").match("/hook/claude")?.params).toEqual({
      agentId: "claude",
    });
  });
});

describe("dispatch", () => {
  it("404s a path nobody claimed", async () => {
    const answer = await router().dispatch("GET", "/api/nope");
    expect(answer.status).toBe(404);
    expect(answer.body).toEqual({
      code: "not_found",
      message: "没有这个接口：/api/nope",
    });
  });

  it("405s a method the path does not take", async () => {
    const answer = await router().dispatch("DELETE", "/api/workspaces");
    expect(answer.status).toBe(405);
    expect((answer.body as { code: string }).code).toBe("method_not_allowed");
  });

  it("501s an unwritten route, naming that path", async () => {
    const answer = await router().dispatch("POST", "/api/workspaces");
    expect(answer.status).toBe(501);
    expect(answer.body).toEqual({
      code: "not_implemented",
      message: "未实现：/api/workspaces",
    });
  });

  it("calls a handler that was bound, with its parameters", async () => {
    const one = router();
    one.handle("PATCH", "/api/workspaces/{workspaceId}", (match) => ({
      status: 200,
      body: match.params,
    }));
    expect(await one.dispatch("patch", "/api/workspaces/ws-7")).toEqual({
      status: 200,
      body: { workspaceId: "ws-7" },
    });
  });

  it("takes the method case-insensitively", async () => {
    const one = router();
    one.handle("GET", "/health", () => ({ status: 200, body: { ok: true } }));
    expect((await one.dispatch("get", "/health")).status).toBe(200);
  });

  it("refuses to bind a handler to a path nobody wrote down", () => {
    expect(() =>
      router().handle("GET", "/api/invented", () => ({
        status: 200,
        body: {},
      })),
    ).toThrow(/not in the route table/);
  });
});
