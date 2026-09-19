import { describe, expect, it } from "vitest";
import { ROUTES } from "./routes";
import { Router } from "./router";

/**
 * The contract, and the few paths that are deliberately outside it.
 *
 * The contract is the 161 routes the core inherited unchanged; anything the
 * core answers beyond them carries `beyondContract` and is listed by name
 * below, so adding a second one is a decision somebody makes in this file
 * rather than a diff nothing notices.
 *
 * Until R7d the counts here were checked against the Rust sources themselves
 * (`apps/runtime/src/lib.rs` was parsed for `.route(...)` calls). That
 * implementation is gone, so the numbers below are the contract now.
 */
const beyond = ROUTES.filter((route) => route.beyondContract);
const contractual = ROUTES.filter((route) => !route.beyondContract);

/**
 * Paths the contract had and this table deliberately does not.
 *
 * `/api/ownership*` answered "which of the two processes may write?" — a
 * question with no second answer inside one core, so R7c deleted the mechanism
 * on both sides of the wire (design §4.2 / §4.3) and R7d deleted the other
 * side outright. Listed by name so a second retirement is a decision made in
 * this file.
 */
const RETIRED = ["/api/ownership", "/api/ownership/domains"];

describe("the route table", () => {
  it("names every path outside the inherited contract", () => {
    // 四条，各自的理由写在 `routes.ts` 上：R6c 的远程浏览器画面流（那时的实现
    // 没有 headless 后端），以及 R7a 的三张 JSON 面（GitHub 与自动化在分进程
    // 时代活在另一个进程的 protobuf 面上，Hello 的 JSON 形状是新加的）。
    expect(beyond.map((route) => route.path)).toEqual([
      "/api/workspaces/{workspaceId}/browser/{nodeId}/stream",
      "/api/github/{verb}",
      "/api/automations/{resource}",
      "/api/identity/hello",
    ]);
  });

  it("keeps the retired ownership paths out of the table", () => {
    for (const path of RETIRED) {
      expect(
        ROUTES.map((route) => route.path),
        path,
      ).not.toContain(path);
    }
  });

  it("holds the contractual 161, split 146 on the main surface and 15 on the hook one", () => {
    expect(contractual).toHaveLength(161);
    expect(
      contractual.filter((route) => route.surface === "runtime"),
    ).toHaveLength(146);
    expect(
      contractual.filter((route) => route.surface === "hook"),
    ).toHaveLength(15);
  });

  it("lists no path twice", () => {
    expect(new Set(ROUTES.map((route) => route.path)).size).toBe(ROUTES.length);
  });

  it("names a feature and a phase for everything this build does not answer", () => {
    for (const route of ROUTES) {
      // A route a phase has claimed keeps its `feature`: the string names the
      // domain in the table, and it is what the 501 said until the day the
      // handler landed. Only the unwritten ones have to carry a phase.
      if (route.implemented) continue;
      expect(route.feature, route.path).toBeTruthy();
      expect([1, 2, 3, 4, 5, 6], route.path).toContain(route.phase);
    }
  });

  it("answers the two health paths, and nothing outside a claimed phase", () => {
    const implemented = ROUTES.filter((route) => route.implemented);
    expect(implemented.map((route) => route.path)).toContain("/health");
    expect(implemented.map((route) => route.path)).toContain("/api/health");
    // Every other implemented route belongs to a phase that wrote it, which
    // is what keeps a handler from being bound to a path nobody claimed.
    for (const route of implemented) {
      if (route.path === "/health" || route.path === "/api/health") continue;
      expect([1, 2, 3, 4, 5, 6], route.path).toContain(route.phase);
    }
  });

  it("gives every unimplemented route on the main surface a 501 that names it", async () => {
    const router = new Router();
    const unimplemented = ROUTES.filter(
      (route) => route.surface === "runtime" && !route.implemented,
    );
    // Counted rather than written down: the number falls by exactly what each
    // phase claims, and a literal here would be edited on every landing.
    expect(unimplemented.length).toBe(
      ROUTES.filter((route) => route.surface === "runtime").length -
        ROUTES.filter(
          (route) => route.surface === "runtime" && route.implemented,
        ).length,
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
      expect(body.message, route.path).toBe(
        `${route.feature as string}（R${route.phase as number}）`,
      );
    }
  });

  it("claims each phase's routes without overlap", () => {
    const counts = new Map<number, number>();
    for (const route of ROUTES) {
      if (route.phase === undefined) continue;
      counts.set(route.phase, (counts.get(route.phase) ?? 0) + 1);
    }
    // Every phase from R1 to R5 owns something; none is left empty, which
    // would mean a phase whose scope silently moved somewhere else.
    for (const phase of [1, 2, 3, 4, 5]) {
      expect(counts.get(phase), `R${phase}`).toBeGreaterThan(0);
    }
    // 160 条契约内的（所有权两条已退休）+ R7a 那三张 JSON 面。
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(163);
  });

  it("keeps the three inbound WebSocket paths in the table", () => {
    // Contract §5.1: three inbound streams, and they must not become 404s.
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
});
