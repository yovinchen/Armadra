import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactFlowInstance } from "@xyflow/react";

import { installDomPolyfills, TestProviders } from "../app/test-harness";
import {
  clearCanvasCommands,
  registerCanvasCommands,
  type CanvasCommandId,
} from "../canvas/commands";
import { setFlow } from "../canvas/flow/flow-context";
import {
  getTool,
  resetToolStore,
  setTool,
} from "../canvas/interaction/tool-store";
import { CANVAS_TOOLS } from "../canvas/tools";
import { DockTools } from "./DockTools";

installDomPolyfills();

/** Dock 只问画布「挂上了没有」，不碰实例上的任何方法。 */
const FAKE_FLOW = {} as ReactFlowInstance;

/** 与 `FlowWorkspace` 注册的那一份等价：命令 → `setTool`。 */
function registerToolCommands() {
  const commands: Partial<Record<CanvasCommandId, () => void>> = {};
  for (const tool of CANVAS_TOOLS) {
    commands[tool.command] = () => setTool(tool.id);
  }
  return registerCanvasCommands(commands);
}

beforeEach(() => {
  setFlow(FAKE_FLOW);
  registerToolCommands();
});

afterEach(() => {
  cleanup();
  clearCanvasCommands();
  setFlow(null);
  resetToolStore();
});

/** 展开态那一份（另一份在 Popover 里，DOM 上是同样的按钮）。 */
function dock() {
  return document.querySelector(".dock-tools-expanded")!;
}

function button(label: string): HTMLElement {
  const found = dock().querySelector(`[aria-label='${label}']`);
  expect(found).toBeTruthy();
  return found as HTMLElement;
}

describe("DockTools", () => {
  it("画布没挂载时整组不渲染", () => {
    setFlow(null);
    const { container } = render(
      <TestProviders>
        <DockTools />
      </TestProviders>,
    );
    expect(container.querySelector(".dock-tools-expanded")).toBeNull();
  });

  it("六格 + 引入：成对的工具各自收成一格，没有画框", () => {
    render(
      <TestProviders>
        <DockTools />
      </TestProviders>,
    );
    const labels = Array.from(dock().querySelectorAll("[aria-label]")).map(
      (element) => element.getAttribute("aria-label"),
    );
    expect(labels).toEqual([
      "选择",
      "手形",
      "画笔",
      "形状",
      "直线",
      "文字",
      "引入…",
    ]);
    expect(labels).not.toContain("画框");
  });

  it("笔那一格：下拉换成高亮，按钮跟着变成高亮", async () => {
    render(
      <TestProviders>
        <DockTools />
      </TestProviders>,
    );
    fireEvent.keyDown(button("画笔"), { key: "Enter" });
    fireEvent.click((await screen.findByText("高亮")).closest("[role]")!);

    expect(getTool()).toBe("highlight");
    expect(button("高亮")).toBeTruthy();
    expect(dock().querySelector("[aria-label='画笔']")).toBeNull();
  });

  it("线那一格：下拉换成箭头，按钮跟着变成箭头", async () => {
    render(
      <TestProviders>
        <DockTools />
      </TestProviders>,
    );
    fireEvent.keyDown(button("直线"), { key: "Enter" });
    fireEvent.click((await screen.findByText("箭头")).closest("[role]")!);

    expect(getTool()).toBe("arrow");
    expect(button("箭头")).toBeTruthy();
    expect(dock().querySelector("[aria-label='直线']")).toBeNull();
  });

  it("快捷键 / 命令面板切过去时，那一格也跟着换人", () => {
    render(
      <TestProviders>
        <DockTools />
      </TestProviders>,
    );
    act(() => setTool("highlight"));
    expect(button("高亮")).toBeTruthy();
    act(() => setTool("arrow"));
    expect(button("箭头")).toBeTruthy();
  });
});
