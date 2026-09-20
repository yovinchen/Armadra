import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { CanvasNode } from "@armadra/shared";

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
import { NodeNameDialog } from "./NodeNameDialog";
import { requestNodeNames } from "./node-names";

beforeAll(installDomPolyfills);

function agentNode(id: string, title: string, handle?: string): CanvasNode {
  return {
    id,
    boardId: "b1",
    type: "terminal",
    title,
    color: "#0a84ff",
    position: { x: 0, y: 0 },
    data: {
      kind: "terminal",
      agent: { id: "codex" },
      ...(handle === undefined ? {} : { handle }),
    },
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  } as CanvasNode;
}

afterEach(() => {
  cleanup();
  store.updateNodeData.mockReset();
  store.document = { nodes: [] };
});

function ask(ids: readonly string[]): void {
  render(<NodeNameDialog />);
  act(() => requestNodeNames(ids));
}

function field(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

describe("起名对话框", () => {
  it("连线之后只问缺名字的那一端，默认值是下一个空位", () => {
    store.document = {
      nodes: [agentNode("a", "已命名", "codex-1"), agentNode("b", "新来的")],
    };
    ask(["a", "b"]);
    // 已经有名字的那一端不出现：一条新线不该成为改掉旧名字的理由。
    expect(screen.queryByLabelText("已命名")).toBeNull();
    expect(field("新来的").value).toBe("codex-2");
  });

  it("两端都没名字就两端都问，确认一次写两条", () => {
    store.document = {
      nodes: [agentNode("a", "左"), agentNode("b", "右")],
    };
    ask(["a", "b"]);
    fireEvent.change(field("左"), { target: { value: "planner" } });
    fireEvent.change(field("右"), { target: { value: "Reviewer" } });
    fireEvent.click(screen.getByText("确定"));
    expect(store.updateNodeData).toHaveBeenCalledTimes(2);
    expect(store.updateNodeData).toHaveBeenCalledWith("a", {
      handle: "planner",
    });
    // 大小写折叠：写进去的是规范化之后的那个词。
    expect(store.updateNodeData).toHaveBeenCalledWith("b", {
      handle: "reviewer",
    });
  });

  it("可以跳过：名字是给协作用的，一块画布上只有一个 Agent 时不需要它", () => {
    store.document = { nodes: [agentNode("a", "左"), agentNode("b", "右")] };
    ask(["a", "b"]);
    fireEvent.click(screen.getByText("跳过"));
    expect(store.updateNodeData).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("左")).toBeNull();
  });

  it("撞名当场说是谁，并且不让确认", () => {
    store.document = {
      nodes: [agentNode("a", "占着的", "reviewer"), agentNode("b", "新来的")],
    };
    ask(["b"]);
    fireEvent.change(field("新来的"), { target: { value: "reviewer" } });
    expect(screen.getByText("这个名字属于「占着的」。")).toBeTruthy();
    expect((screen.getByText("确定") as HTMLButtonElement).disabled).toBe(true);
  });

  it("形状不合法的也拦在对话框里，不等保存被拒才知道", () => {
    store.document = { nodes: [agentNode("a", "左")] };
    ask(["a"]);
    fireEvent.change(field("左"), { target: { value: "有空格 的" } });
    expect((screen.getByText("确定") as HTMLButtonElement).disabled).toBe(true);
  });

  it("清空就是把名字去掉", () => {
    store.document = { nodes: [agentNode("a", "左", "planner")] };
    ask(["a"]);
    fireEvent.change(field("左"), { target: { value: "" } });
    fireEvent.click(screen.getByText("确定"));
    expect(store.updateNodeData).toHaveBeenCalledWith("a", {
      handle: undefined,
    });
  });
});
