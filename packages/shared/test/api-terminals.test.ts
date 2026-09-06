import { describe, expect, it } from "vitest";
import {
  createTerminalRequestSchema,
  sessionsResponseSchema,
  terminalClientMessageSchema,
  terminalServerMessageSchema,
  terminalSessionSchema,
} from "../src/index.js";

const timestamp = "2026-08-13T00:00:00.000Z";
const uuid = "019ff7d1-5c48-7d75-a0ed-64b52f44e214";
const otherUuid = "019ff7d1-7419-74df-89e2-b1619d36ea7d";

describe("runtime terminals API", () => {
  it("preserves Agent identity while accepting older terminal responses", () => {
    const session = {
      id: uuid,
      workspaceId: otherUuid,
      cwd: "/repo",
      shell: "/bin/sh",
      command: null,
      status: "running",
      exitCode: null,
      createdAt: timestamp,
      endedAt: null,
    };
    expect(terminalSessionSchema.parse(session).agentId).toBeUndefined();
    expect(
      terminalSessionSchema.parse({ ...session, agentId: null }).agentId,
    ).toBeNull();
    expect(
      terminalSessionSchema.parse({ ...session, agentId: "custom:helper" })
        .agentId,
    ).toBe("custom:helper");
  });

  it("carries the optional agent block on a terminal request", () => {
    const parsed = createTerminalRequestSchema.parse({
      workspaceId: uuid,
      cwd: ".",
      nodeId: otherUuid,
      agent: { id: "claude", permissionMode: "auto-edit", model: "opus" },
    });
    expect(parsed.agent?.id).toBe("claude");
    expect(parsed.args).toEqual([]);
    expect(
      createTerminalRequestSchema.safeParse({
        workspaceId: uuid,
        cwd: ".",
        agent: { id: "not-an-agent" },
      }).success,
    ).toBe(false);
  });

  it("describes the sessions sidebar payload", () => {
    const sessions = sessionsResponseSchema.parse([
      {
        nodeId: uuid,
        boardId: otherUuid,
        sessionId: uuid,
        kind: "terminal",
        title: "Claude",
        cwd: "/repo",
        agentId: "claude",
        state: "blocked",
        unread: true,
        pendingId: "node-1-1-2",
        updatedAt: timestamp,
        alive: true,
      },
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.state).toBe("blocked");
    expect(sessions[0]?.alive).toBe(true);
  });

  it("models the terminal socket in both directions", () => {
    for (const message of [
      { type: "input", data: "ls\n" },
      { type: "resize", cols: 120, rows: 40 },
      { type: "terminate" },
    ]) {
      expect(terminalClientMessageSchema.safeParse(message).success).toBe(true);
    }
    for (const message of [
      { type: "output", data: "hi" },
      { type: "status", status: "exited", exitCode: 7 },
      { type: "status", status: "running", exitCode: null },
      { type: "warning", message: "Terminal output skipped 3 chunks" },
    ]) {
      expect(terminalServerMessageSchema.safeParse(message).success).toBe(true);
    }
    expect(
      terminalServerMessageSchema.safeParse({ type: "status", status: "wat" })
        .success,
    ).toBe(false);
  });
});
