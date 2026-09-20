import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { setBrowserVerbs } from "../browser";
import { setControlDispatcher } from "../collab/control";
import { Refusal } from "../collab/refusals";
import { collabDispatcher } from "../hook/collab";
import { installHookBridge, resolveCaller } from "./hook-bridge";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE boards (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL);
    CREATE TABLE nodes (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, title TEXT NOT NULL, type TEXT NOT NULL, data_json TEXT NOT NULL);
    INSERT INTO boards VALUES ('b1', 'w1');
    INSERT INTO nodes VALUES ('n1', 'b1', 'Claude', 'terminal', '{"agent":{"id":"claude"}}');
  `);
  return db;
}

let release: (() => void) | undefined;
afterEach(() => {
  release?.();
  release = undefined;
  setControlDispatcher(undefined);
  setBrowserVerbs(undefined);
});

describe("the caller the verbs see", () => {
  it("is the node row plus the verdict the hook surface reached", () => {
    const db = database();
    expect(resolveCaller(db, { nodeId: "n1", verified: true })).toMatchObject({
      node: { id: "n1", workspaceId: "w1", agentId: "claude" },
      verdict: "verified",
    });
    expect(resolveCaller(db, { nodeId: "n1", verified: false })?.verdict).toBe(
      "legacy",
    );
    expect(resolveCaller(db, { nodeId: "ghost", verified: true })).toBe(
      undefined,
    );
  });
});

describe("the two families on the hook surface", () => {
  it("answers context-link as prose and an unknown node as one sentence", async () => {
    const db = database();
    release = installHookBridge(
      db,
      async (caller, verb) =>
        `${verb} for ${caller.node.title} (${caller.verdict})`,
    );
    const dispatch = collabDispatcher("context-link");
    expect(dispatch).toBeDefined();
    expect(
      await dispatch!({
        verb: "list",
        caller: { nodeId: "n1", verified: false },
        args: {},
        wantsText: true,
      }),
    ).toEqual({ kind: "text", status: 200, body: "list for Claude (legacy)" });
    const missing = await dispatch!({
      verb: "list",
      caller: { nodeId: "ghost", verified: true },
      args: {},
      wantsText: false,
    });
    expect(missing).toMatchObject({ kind: "json", status: 404 });
  });

  /**
   * The verbs refuse by throwing. Uncaught, every refusal reached the hook
   * server and came back as a bare 500 — an agent asking to read a node with
   * no terminal was told "the core failed", which names nothing it could do
   * differently.
   */
  it("answers a context-link refusal as its own sentence, not as a 500", async () => {
    const db = database();
    release = installHookBridge(db, async () => {
      throw Refusal.notFound("「构建」还没有运行中的终端会话。");
    });
    const dispatch = collabDispatcher("context-link")!;
    expect(
      await dispatch({
        verb: "terminal",
        caller: { nodeId: "n1", verified: true },
        args: {},
        wantsText: true,
      }),
    ).toEqual({
      kind: "text",
      status: 404,
      body: "「构建」还没有运行中的终端会话。\n",
    });
  });

  it("lets a genuine failure keep going up as a failure", async () => {
    const db = database();
    release = installHookBridge(db, async () => {
      throw new TypeError("read of undefined");
    });
    const dispatch = collabDispatcher("context-link")!;
    await expect(
      dispatch({
        verb: "terminal",
        caller: { nodeId: "n1", verified: true },
        args: {},
        wantsText: true,
      }),
    ).rejects.toThrow("read of undefined");
  });

  it("answers control through the registered dispatcher, or 503 before one exists", async () => {
    const db = database();
    release = installHookBridge(db, async () => "");
    const control = collabDispatcher("control")!;
    const request = {
      verb: "list",
      caller: { nodeId: "n1", verified: true },
      args: { a: 1 },
      wantsText: false,
    };
    expect(await control(request)).toMatchObject({ kind: "json", status: 503 });
    setControlDispatcher({
      verbs: ["list"],
      dispatch: async (verb, caller, args) => ({
        ok: true,
        body: { verb, node: caller.node.id, verdict: caller.verdict, args },
      }),
    });
    expect(await control(request)).toEqual({
      kind: "json",
      status: 200,
      body: { verb: "list", node: "n1", verdict: "verified", args: { a: 1 } },
    });
    setControlDispatcher({
      verbs: ["list"],
      dispatch: async () => ({
        ok: false,
        status: 403,
        code: "forbidden",
        message: "需要 verified",
      }),
    });
    expect(await control(request)).toEqual({
      kind: "json",
      status: 403,
      body: { code: "forbidden", message: "需要 verified" },
    });
  });
});

describe("the browser family on the hook surface", () => {
  it("answers prose through the browser verbs, or 503 before they exist", async () => {
    const db = database();
    release = installHookBridge(db, async () => "");
    const browser = collabDispatcher("browser")!;
    const request = {
      verb: "read",
      caller: { nodeId: "n1", verified: true },
      args: { ref: "e3" },
      wantsText: true,
    };
    expect(await browser(request)).toMatchObject({ kind: "text", status: 503 });
    const seen: unknown[] = [];
    setBrowserVerbs({
      verbs: ["read"],
      dispatch: async (caller, verb, args) => {
        seen.push([caller.node.id, caller.verdict, verb, args]);
        return verb === "read"
          ? { ok: true, body: "Heading\n" }
          : { ok: false, status: 409, code: "no_lease", message: "没有租约" };
      },
    });
    expect(await browser(request)).toEqual({
      kind: "text",
      status: 200,
      body: "Heading\n",
    });
    expect(seen).toEqual([["n1", "verified", "read", { ref: "e3" }]]);
    expect(await browser({ ...request, verb: "click" })).toEqual({
      kind: "text",
      status: 409,
      body: "没有租约\n",
    });
    expect(
      await browser({
        ...request,
        caller: { nodeId: "ghost", verified: true },
      }),
    ).toMatchObject({ kind: "text", status: 404 });
  });
});
