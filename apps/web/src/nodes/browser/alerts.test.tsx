import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { BrowserLease } from "@armadra/shared";

import { dispatchWorkspaceEvent } from "@/api/events";

import { useBrowserAlerts, resetBrowserAlerts } from "./alerts";
import { ActivityStatus } from "./Lease";

/**
 * Agent 驱动期间那一行（复查 §7 的 #5 与 #8）。
 *
 * 事件流按 `sessionId` 送，页面只知道 `nodeId`：这里钉的就是那道认领——认
 * 对了才显示，认错了宁可不显示。
 */

const AGENT = "agent-node-1";
const SESSION = "session-7";

function agentLease(holderId = AGENT): BrowserLease {
  return {
    state: "agent",
    generation: 1,
    expiresAt: "",
    holder: { kind: "agent", id: holderId, displayName: "Claude" },
  };
}

function activity(sessionId: string, actorId: string, verb = "click") {
  return {
    type: "browser.activity" as const,
    sessionId,
    actor: "agent" as const,
    actorId,
    verb,
    target: "#submit",
    outcome: "ok" as const,
    reasonCode: "",
    at: new Date().toISOString(),
  };
}

function dialog(sessionId: string, kind = "confirm") {
  return {
    type: "browser.dialog" as const,
    sessionId,
    dialog: {
      dialogId: "d1",
      tabId: "t1",
      kind: kind as "confirm",
      message: "真的要提交吗",
      defaultPrompt: "",
      url: "https://example.test/",
      openedAt: new Date().toISOString(),
    },
  };
}

function Probe({
  nodeId,
  lease,
}: {
  nodeId: string;
  lease: BrowserLease | undefined;
}) {
  const alerts = useBrowserAlerts(nodeId, lease);
  return (
    <ActivityStatus
      activity={alerts.activity}
      dialog={alerts.dialog}
      chooser={alerts.chooser}
    />
  );
}

beforeEach(() => resetBrowserAlerts());
afterEach(() => {
  cleanup();
  resetBrowserAlerts();
});

describe("useBrowserAlerts", () => {
  it("租约持有者对上时认领会话，并显示 Agent 最近一次动作", () => {
    render(<Probe nodeId="b1" lease={agentLease()} />);
    act(() => dispatchWorkspaceEvent(activity(SESSION, AGENT)));

    expect(
      document.querySelector('[data-slot="browser-activity"]')!.textContent,
    ).toContain("click");
  });

  it("认领之后对话框按 sessionId 严格过滤", () => {
    render(<Probe nodeId="b1" lease={agentLease()} />);
    act(() => dispatchWorkspaceEvent(activity(SESSION, AGENT)));

    // 别的会话的对话框不属于这个节点。
    act(() => dispatchWorkspaceEvent(dialog("session-other")));
    expect(document.querySelector('[data-slot="browser-prompt"]')).toBeNull();

    act(() => dispatchWorkspaceEvent(dialog(SESSION)));
    expect(
      document.querySelector('[data-slot="browser-prompt"]')!.textContent,
    ).toBe("页面询问");

    // 对话框被答复后事件不带 `dialog`，那一行要跟着消失。
    act(() =>
      dispatchWorkspaceEvent({ type: "browser.dialog", sessionId: SESSION }),
    );
    expect(document.querySelector('[data-slot="browser-prompt"]')).toBeNull();
  });

  it("文件请求也显示一行", () => {
    render(<Probe nodeId="b1" lease={agentLease()} />);
    act(() => dispatchWorkspaceEvent(activity(SESSION, AGENT)));
    act(() =>
      dispatchWorkspaceEvent({
        type: "browser.fileChooser",
        sessionId: SESSION,
        chooser: {
          chooserId: "c1",
          tabId: "t1",
          frameId: "",
          multiple: false,
          accept: "",
          openedAt: new Date().toISOString(),
        },
      }),
    );
    expect(
      document.querySelector('[data-slot="browser-prompt"]')!.textContent,
    ).toBe("页面要选择文件");
  });

  it("没有 Agent 租约时什么都不认领", () => {
    render(<Probe nodeId="b1" lease={undefined} />);
    act(() => dispatchWorkspaceEvent(activity(SESSION, AGENT)));
    act(() => dispatchWorkspaceEvent(dialog(SESSION)));
    expect(document.querySelector('[data-slot="browser-status"]')).toBeNull();
  });

  it("持有者对不上的活动不认领——那是别人的页面", () => {
    render(<Probe nodeId="b1" lease={agentLease("agent-node-2")} />);
    act(() => dispatchWorkspaceEvent(activity(SESSION, AGENT)));
    expect(document.querySelector('[data-slot="browser-status"]')).toBeNull();
  });

  it("同一个会话不会被第二个节点重复认领", () => {
    render(
      <>
        <Probe nodeId="b1" lease={agentLease()} />
        <Probe nodeId="b2" lease={agentLease()} />
      </>,
    );
    act(() => dispatchWorkspaceEvent(activity(SESSION, AGENT)));
    // 先订阅的那个认领走了；另一个宁可不显示，也不显示别人的页面在做什么。
    expect(
      document.querySelectorAll('[data-slot="browser-activity"]'),
    ).toHaveLength(1);
  });

  it("节点卸载后把认领还回去", () => {
    const view = render(<Probe nodeId="b1" lease={agentLease()} />);
    act(() => dispatchWorkspaceEvent(activity(SESSION, AGENT)));
    view.unmount();

    render(<Probe nodeId="b2" lease={agentLease()} />);
    act(() => dispatchWorkspaceEvent(activity(SESSION, AGENT)));
    expect(
      document.querySelector('[data-slot="browser-activity"]'),
    ).not.toBeNull();
  });
});
