import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type HookFixture, hookFixture, insertSession } from "./fixture";
import { installRoutes } from "./routes";
import { issueNodeToken } from "./tokens";

/** The hook domain's routes on the main surface. */

let open: HookFixture[] = [];

function fixture(): HookFixture {
  const made = hookFixture();
  installRoutes({ ...made.core, dataDir: made.core.directory }, made.service);
  open.push(made);
  return made;
}

afterEach(() => {
  for (const one of open) one.close();
  open = [];
});

describe("the node-token refresh route", () => {
  it("re-mints the token for a session whose file was lost", async () => {
    const one = fixture();
    insertSession(one, { id: "sess-1", status: "running" });
    const tokenFile = join(one.service.nodeTokenDir(), one.nodeId);

    const answer = await one.core.call(
      "POST",
      "/api/terminals/sess-1/node-token/refresh",
    );
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ nodeId: one.nodeId, tokenFile });
    const token = readFileSync(tokenFile, "utf8");
    expect(one.service.verdict(one.nodeId, token)).toBe("verified");

    // The token is derived, so re-minting it after a delete is byte-identical
    // — a terminal that kept the old one in flight is not invalidated.
    rmSync(tokenFile);
    const again = await one.core.call(
      "POST",
      "/api/terminals/sess-1/node-token/refresh",
    );
    expect(again.status).toBe(200);
    expect(readFileSync(tokenFile, "utf8")).toBe(token);
  });

  it("answers 404 for a session nobody created", async () => {
    const one = fixture();
    const answer = await one.core.call(
      "POST",
      "/api/terminals/nope/node-token/refresh",
    );
    expect(answer.status).toBe(404);
  });

  it("answers 400 for a session with no owning node", async () => {
    const one = fixture();
    one.core.database
      .prepare(
        "INSERT INTO terminal_sessions (id, workspace_id, cwd, shell, kind, status, " +
          "created_at, session_key, backend_kind, generation, attach_state) " +
          "VALUES ('plain', ?, '/tmp', 'sh', 'terminal', 'running', ?, 'plain', 'direct', 0, 'live')",
      )
      .run(one.workspaceId, new Date().toISOString());
    const answer = await one.core.call(
      "POST",
      "/api/terminals/plain/node-token/refresh",
    );
    expect(answer.status).toBe(400);
  });
});

describe("minting a node token outside the service", () => {
  /**
   * The terminal domain calls this at creation and is not handed a service.
   * It is safe because the token is derived rather than stored, which this
   * asserts directly: the standalone path and the service agree byte for byte.
   */
  it("agrees with the running service", () => {
    const one = fixture();
    const standalone = issueNodeToken(one.core.directory, one.nodeId);
    expect(standalone).toBe(one.service.issueNodeToken(one.nodeId));
    expect(one.service.verdict(one.nodeId, standalone)).toBe("verified");
    expect(() => issueNodeToken(one.core.directory, "../escape")).toThrow();
  });
});
