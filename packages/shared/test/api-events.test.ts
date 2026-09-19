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
        type: "browser.tabs",
        sessionId: uuid,
        tabs: {
          tabs: [
            { tabId: "t1", url: "https://example.test/", active: true },
            { tabId: "t2", loading: true, openerTabId: "t1" },
          ],
          activeTabId: "t1",
        },
      },
      {
        type: "browser.dialog",
        sessionId: uuid,
        dialog: {
          dialogId: "d-1",
          tabId: "t1",
          kind: "beforeunload",
          message: "Leave?",
          openedAt: timestamp,
        },
      },
      // 对话框被答复之后推的是同一个事件、没有 `dialog`——界面据此把
      // 弹层收起来，而不是靠超时猜。
      { type: "browser.dialog", sessionId: uuid },
      {
        type: "browser.fileChooser",
        sessionId: uuid,
        chooser: {
          chooserId: "c-1",
          tabId: "t1",
          multiple: true,
          openedAt: timestamp,
        },
      },
      { type: "browser.fileChooser", sessionId: uuid },
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

  it("decodes the browser tab / dialog / chooser events the runtime emits", () => {
    // 这三个事件 Runtime 一直在发，联合里却没有，`safeParse` 只会把它们丢掉
    // 并告警——标签条和对话框界面因此收不到任何东西（§2.2/§2.3/§2.4）。
    const tabs = workspaceEventSchema.parse({
      type: "browser.tabs",
      sessionId: uuid,
      tabs: { tabs: [{ tabId: "t1", active: true }], activeTabId: "t1" },
    });
    expect(tabs).toMatchObject({ type: "browser.tabs" });
    if (tabs.type !== "browser.tabs") throw new Error("narrowing failed");
    expect(tabs.tabs.limit).toBe(16);
    expect(tabs.tabs.tabs[0]).toMatchObject({ favicon: "", loading: false });

    const chooser = workspaceEventSchema.parse({
      type: "browser.fileChooser",
      sessionId: uuid,
      chooser: { chooserId: "c-1", tabId: "t1", openedAt: timestamp },
    });
    if (chooser.type !== "browser.fileChooser")
      throw new Error("narrowing failed");
    expect(chooser.chooser?.multiple).toBe(false);

    expect(
      workspaceEventSchema.safeParse({
        type: "browser.dialog",
        sessionId: uuid,
        dialog: {
          dialogId: "d",
          tabId: "t1",
          kind: "toast",
          message: "",
          openedAt: timestamp,
        },
      }).success,
    ).toBe(false);
  });
});
