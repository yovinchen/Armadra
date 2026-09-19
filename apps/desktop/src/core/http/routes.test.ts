import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ROUTES } from "./routes";
import { Router } from "./router";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeSrc = resolve(here, "../../../../runtime/src");

/**
 * The table has to be the Rust Runtime's route set, not an approximation of
 * it. So the Rust sources are parsed here and the two sets are compared, which
 * is the same check `tools/route-parity.mjs` will run in `pnpm check` — with
 * the difference that this one fails the moment somebody edits either side.
 */
function rustRoutes(): { path: string; methods: string[] }[] {
  const found: { path: string; methods: string[] }[] = [];
  for (const file of ["lib.rs", "hook/mod.rs"]) {
    const source = readFileSync(resolve(runtimeSrc, file), "utf8");
    const pattern = /\.route\(\s*"([^"]+)"\s*,/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      let index = pattern.lastIndex;
      let depth = 1;
      let chain = "";
      while (index < source.length && depth > 0) {
        const character = source[index] as string;
        if (character === "(") depth += 1;
        else if (character === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
        chain += character;
        index += 1;
      }
      found.push({
        path: match[1] as string,
        methods: [
          ...new Set(
            [...chain.matchAll(/\b(get|post|put|patch|delete)\s*\(/g)].map(
              (verb) => (verb[1] as string).toUpperCase(),
            ),
          ),
        ],
      });
    }
  }
  return found;
}

/** `{workspace_id}` in Rust is `{workspaceId}` here. */
function camel(path: string): string {
  return path.replace(
    /\{([a-z_]+)\}/g,
    (_whole, name: string) =>
      `{${name.replace(/_([a-z])/g, (_m, letter: string) => letter.toUpperCase())}}`,
  );
}

describe("the route table", () => {
  it("holds the contractual 163, split 148 on the main surface and 15 on the hook one", () => {
    expect(ROUTES).toHaveLength(163);
    expect(ROUTES.filter((route) => route.surface === "runtime")).toHaveLength(
      148,
    );
    expect(ROUTES.filter((route) => route.surface === "hook")).toHaveLength(15);
  });

  it("is exactly what the Rust Runtime registers, path for path", () => {
    const rust = rustRoutes()
      .map((route) => camel(route.path))
      .sort();
    const ours = ROUTES.map((route) => route.path).sort();
    expect(ours).toEqual(rust);
  });

  it("agrees with the Rust Runtime on every path's methods", () => {
    const rust = new Map(
      rustRoutes().map((route) => [
        camel(route.path),
        [...route.methods].sort(),
      ]),
    );
    for (const route of ROUTES) {
      expect([...route.methods].sort(), route.path).toEqual(
        rust.get(route.path),
      );
    }
  });

  it("lists no path twice", () => {
    expect(new Set(ROUTES.map((route) => route.path)).size).toBe(ROUTES.length);
  });

  it("names a feature and a phase for everything this build does not answer", () => {
    for (const route of ROUTES) {
      if (route.implemented) {
        expect(route.feature, route.path).toBeUndefined();
        continue;
      }
      expect(route.feature, route.path).toBeTruthy();
      expect([1, 2, 3, 4, 5], route.path).toContain(route.phase);
    }
  });

  it("answers exactly the two health paths for real", () => {
    expect(
      ROUTES.filter((route) => route.implemented).map((route) => route.path),
    ).toEqual(["/health", "/api/health"]);
  });

  it("gives every unimplemented route on the main surface a 501 that names it", async () => {
    const router = new Router();
    const unimplemented = ROUTES.filter(
      (route) => route.surface === "runtime" && !route.implemented,
    );
    expect(unimplemented).toHaveLength(146);
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
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(161);
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
