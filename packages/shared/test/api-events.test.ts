import { describe, expect, it } from "vitest";
import { workspaceEventSchema } from "../src/index.js";

const timestamp = "2026-08-13T00:00:00.000Z";
const uuid = "019ff7d1-5c48-7d75-a0ed-64b52f44e214";
const otherUuid = "019ff7d1-7419-74df-89e2-b1619d36ea7d";

const browserSession = {
  sessionId: uuid,
  generation: 1,
  workspaceId: otherUuid,
  nodeId: otherUuid,
  url: "https://example.test/",
  title: "Example",
  viewport: { width: 1280, height: 720, deviceScaleFactor: 2 },
  state: "ready",
  reasonCode: "",
  navigationEpoch: 3,
  headful: false,
  keepAlive: true,
  canGoBack: true,
  canGoForward: false,
  createdAt: timestamp,
  updatedAt: timestamp,
};

describe("runtime workspace events API", () => {
  it("models every workspace event", () => {
    const events = [
      {
        type: "agent.status",
        status: {
          nodeId: uuid,
          workspaceId: otherUuid,
          agentId: "claude",
          state: "working",
          unread: false,
          verified: true,
          restored: false,
          updatedAt: timestamp,
        },
      },
      {
        type: "agent.subagent",
        event: {
          nodeId: uuid,
          agentId: "claude",
          kind: "subagent-start",
          subagentType: "explore",
          taskLabel: "find the bug",
        },
      },
      {
        type: "agent.approval",
        nodeId: uuid,
        pendingId: "p-1",
        request: { tool: "Bash" },
      },
      {
        type: "agent.delivery",
        traceId: "t-1",
        sourceNodeId: uuid,
        targetNodeId: otherUuid,
        outcome: "delivered",
      },
      {
        type: "terminal.exit",
        sessionId: uuid,
        nodeId: otherUuid,
        exitCode: 0,
      },
      { type: "board.changed", boardId: otherUuid, updatedAt: timestamp },
      {
        type: "browser.frame",
        sessionId: uuid,
        generation: 1,
        frameSeq: 12,
        navigationEpoch: 3,
        viewportWidth: 1280,
        viewportHeight: 720,
        deviceScaleFactor: 2,
        encoding: "jpeg",
        data: "/9j/4AAQ",
        capturedAt: timestamp,
      },
      { type: "browser.session", session: browserSession },
      {
        type: "ssh.prompt",
        prompt: {
          promptId: "p-1",
          hostId: "box",
          kind: "passphrase",
          prompt: "Enter passphrase for key '/home/me/.ssh/id_ed25519':",
        },
      },
      { type: "workspace.updated", workspaceId: uuid },
      {
        type: "browser.download",
        download: {
          downloadId: "d-1",
          sessionId: uuid,
          url: "https://example.test/a.zip",
          suggestedFilename: "a.zip",
          state: "inProgress",
          path: ".armadra/downloads/a.zip",
          totalBytes: 100,
          receivedBytes: 40,
          createdAt: timestamp,
          reasonCode: "",
        },
      },
    ];
    for (const event of events) {
      const parsed = workspaceEventSchema.safeParse(event);
      expect(parsed.success, JSON.stringify(event.type)).toBe(true);
    }
    expect(workspaceEventSchema.safeParse({ type: "acp.update" }).success).toBe(
      false,
    );
  });
});
