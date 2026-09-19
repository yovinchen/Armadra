import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { controlDispatcher } from "../collab/control";
import { type RunningCore, run } from "../main";

/**
 * The agent domain, assembled by the real `run()` under `ARMADRA_CORE=ts`.
 *
 * This is the closest this batch can get to the end-to-end acceptance while
 * the Hook surface is still 501: the Hook server is what a CLI actually talks
 * to, and it lands in its own batch. What can be proved here is everything on
 * this side of it — that the one-way gate applies migration 0016, that the
 * domain installs, that the runtime routes answer for real rather than 501,
 * and that the {@link controlDispatcher} the Hook server will call is
 * published and carries the fourteen verbs.
 */

let core: RunningCore;
let directory: string;
let base: string;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "armadra-core-agent-"));
  core = await run({
    argv: ["--listen", "tcp:127.0.0.1:0", "--data-dir", directory],
    env: { ...process.env, ARMADRA_CORE: "ts", ARMADRA_LOG: "error" },
    stdout: () => {},
  });
  const spec = core.bound[0];
  if (spec === undefined || spec.kind !== "tcp") throw new Error("no listener");
  base = `http://${spec.host}:${spec.port}`;
}, 30_000);

afterAll(async () => {
  await core?.stop();
  rmSync(directory, { recursive: true, force: true });
});

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const answer = await fetch(base + path, { headers: { origin: base } });
  const text = await answer.text();
  return {
    status: answer.status,
    body: text === "" ? undefined : JSON.parse(text),
  };
}

describe("the assembled agent domain", () => {
  it("applies the unified migrations, 0016 included", () => {
    const tables = (
      core.db.database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN " +
            "('agent_approval_audit', 'agent_drain_cursor')",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(tables.sort()).toEqual([
      "agent_approval_audit",
      "agent_drain_cursor",
    ]);
    // The revision column the cross-device CAS turns on.
    const columns = (
      core.db.database
        .prepare("PRAGMA table_info('agent_approvals')")
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(columns).toContain("revision");
  });

  it("answers its routes for real rather than 501", async () => {
    const conversations = await get("/api/conversations");
    expect(conversations.status).toBe(200);
    expect(Array.isArray(conversations.body)).toBe(true);

    // A workspace nobody has is a 404, which is a real answer; 501 would mean
    // the route is not written yet.
    expect((await get("/api/workspaces/none/deliveries")).status).toBe(404);
    expect((await get("/api/agent-status/none/transcript")).status).toBe(404);
    expect((await get("/api/workspaces/none/handoffs")).status).toBe(404);
  });

  it("publishes the dispatcher the Hook surface will call", () => {
    const dispatcher = controlDispatcher();
    expect(dispatcher).toBeDefined();
    expect(dispatcher?.verbs).toHaveLength(14);
    expect(dispatcher?.verbs).toContain("handoff-read");
    expect(dispatcher?.verbs).toContain("open-agent");
  });
});
