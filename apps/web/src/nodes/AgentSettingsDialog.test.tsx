import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { CanvasNode } from "@armadra/shared";

/**
 * 节点的 Agent 设置（设计 `agent-delivery.md` §10）。
 *
 * 三项都读同一个 `data.agent`，写一律走 `updateNodeData`——节点数据只有一个
 * 写口，页面不在别处另存一份。默认值也在这里守：缺省的收件箱唤醒是「提示」、
 * 从不能投、转录可读。
 */

const store = vi.hoisted(() => ({
  document: { nodes: [] as CanvasNode[] },
  updateNodeData: vi.fn(),
}));

vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

import { installDomPolyfills } from "@/app/test-harness";
import { AgentSettingsDialog } from "./AgentSettingsDialog";
import { openAgentSettings } from "./agent-settings";

beforeAll(installDomPolyfills);

function node(agent: Record<string, unknown> | undefined): CanvasNode {
  return {
    id: "n1",
    boardId: "b1",
    type: "terminal",
    title: "codex",
    color: "#0a84ff",
    position: { x: 0, y: 0 },
    data: { kind: "terminal", ...(agent === undefined ? {} : { agent }) },
    createdAt: "2026-09-21T00:00:00.000Z",
    updatedAt: "2026-09-21T00:00:00.000Z",
  } as CanvasNode;
}

function open(agent: Record<string, unknown> | undefined): void {
  store.document = { nodes: [node(agent)] };
  render(<AgentSettingsDialog />);
  act(() => openAgentSettings("n1"));
}

/** 最后一次写进去的 `agent` 对象。 */
function written(): Record<string, unknown> {
  const call = store.updateNodeData.mock.calls.at(-1);
  return (call?.[1] as { agent: Record<string, unknown> }).agent;
}

afterEach(() => {
  cleanup();
  store.updateNodeData.mockReset();
  store.document = { nodes: [] };
});

describe("Agent 设置", () => {
  it("缺省读出来是：提示、从不能投、转录可读", () => {
    open({ id: "codex" });
    expect(
      screen.getByRole("radio", { name: "提示" }).getAttribute("data-state"),
    ).toBe("on");
    expect(
      screen
        .getByRole("switch", { name: "允许从向我投递" })
        .getAttribute("data-state"),
    ).toBe("unchecked");
    expect(
      screen
        .getByRole("switch", { name: "允许相连 Agent 读取转录" })
        .getAttribute("data-state"),
    ).toBe("checked");
  });

  it("改收件箱唤醒写 inboxWake，不动别的字段", () => {
    open({ id: "codex", acceptSubDelivery: true });
    fireEvent.click(screen.getByRole("radio", { name: "直接投递" }));
    expect(store.updateNodeData).toHaveBeenCalledWith(
      "n1",
      expect.anything(),
      // `updateNodeData` 的第三个参数是可选的，这里不传。
    );
    expect(written()).toEqual({
      id: "codex",
      acceptSubDelivery: true,
      inboxWake: "deliver",
    });
  });

  it("允许从向我投递是一个开关，开了写 true", () => {
    open({ id: "codex" });
    fireEvent.click(screen.getByRole("switch", { name: "允许从向我投递" }));
    expect(written()).toEqual({ id: "codex", acceptSubDelivery: true });
  });

  it("关掉「读取转录」写的是 summary，不是删字段", () => {
    open({ id: "codex" });
    fireEvent.click(
      screen.getByRole("switch", { name: "允许相连 Agent 读取转录" }),
    );
    expect(written()).toEqual({ id: "codex", contextShare: "summary" });
  });

  it("已经是 summary 的节点开关是关的，再开写回 full", () => {
    open({ id: "codex", contextShare: "summary" });
    const toggle = screen.getByRole("switch", {
      name: "允许相连 Agent 读取转录",
    });
    expect(toggle.getAttribute("data-state")).toBe("unchecked");
    fireEvent.click(toggle);
    expect(written()).toEqual({ id: "codex", contextShare: "full" });
  });

  it("没有 agent 的裸终端不开这个对话框", () => {
    open(undefined);
    expect(screen.queryByText("Agent 设置")).toBeNull();
  });
});
