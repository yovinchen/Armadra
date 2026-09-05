import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AgentInfo, Workspace } from "@armadra/shared";

const fetchAgents = vi.fn();
vi.mock("../api/client", () => ({
  runtimeApi: { agents: () => fetchAgents() },
}));

import { installDomPolyfills, TestProviders } from "../app/test-harness";
import { usePreferencesStore } from "../app/preferences-store";
import { useCanvasOwnership } from "../canvas-ownership";
import { useCanvasStore } from "../store/canvas-store";
import { Dock } from "./Dock";

installDomPolyfills();
afterEach(cleanup);

const now = new Date().toISOString();
const workspace: Workspace = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "alpha",
  rootPath: "/tmp/alpha",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  executionHostId: "",
  lastOpenedAt: now,
  createdAt: now,
  updatedAt: now,
};

const claude: AgentInfo = {
  id: "claude",
  label: "Claude Code",
  color: "#d97757",
  launchCmd: "claude",
  promptMode: "argv",
  args: [],
  capabilities: ["hooks"],
  resolvedPath: "/usr/local/bin/claude",
  installed: true,
  clientRevision: 1,
};

describe("Dock", () => {
  beforeEach(() => {
    fetchAgents.mockReset().mockResolvedValue([claude]);
    usePreferencesStore.setState({ agentModes: {} });
    useCanvasStore.setState({ workspace, saveState: "saved" });
    useCanvasOwnership.setState({ status: "runtime", epoch: 1n });
  });

  afterEach(() => useCanvasOwnership.getState().reset());

  it("没有工作空间时不渲染", () => {
    useCanvasStore.setState({ workspace: null });
    const { container } = render(
      <TestProviders>
        <Dock />
      </TestProviders>,
    );
    expect(container.querySelector("[data-slot='dock']")).toBeNull();
  });

  it("点开 `+` 会展开新建菜单", async () => {
    render(
      <TestProviders>
        <Dock />
      </TestProviders>,
    );
    const add = screen.getByLabelText("新建");
    fireEvent.keyDown(add, { key: "Enter" });
    expect(await screen.findByText("新建终端")).toBeTruthy();
  });

  it("撤销/重做在画布未挂载时禁用", () => {
    render(
      <TestProviders>
        <Dock />
      </TestProviders>,
    );
    expect(screen.getByLabelText("撤销").hasAttribute("disabled")).toBe(true);
    expect(screen.getByLabelText("重做").hasAttribute("disabled")).toBe(true);
  });

  it("保存状态只用一个点表示", () => {
    const { container } = render(
      <TestProviders>
        <Dock />
      </TestProviders>,
    );
    const dot = container.querySelector("[data-slot='save-dot']");
    expect(dot?.getAttribute("data-state")).toBe("saved");
    expect(dot?.textContent).toBe("");
  });

  /**
   * 维护窗口里画布写不进去。这盏灯必须说「只读」，说「已保存」就是
   * 把没落盘的改动报成落盘了（H01 §4）。
   */
  it("画布只读时保存指示灯不再报「已保存」", () => {
    useCanvasOwnership.setState({ status: "maintenance" });
    const { container } = render(
      <TestProviders>
        <Dock />
      </TestProviders>,
    );
    const dot = container.querySelector("[data-slot='save-dot']");
    expect(dot?.getAttribute("data-state")).toBe("readonly");
    expect(dot?.getAttribute("aria-label")).toBe("只读，未保存");
  });

  it("归属还没探到时同样不报「已保存」", () => {
    useCanvasOwnership.getState().reset();
    const { container } = render(
      <TestProviders>
        <Dock />
      </TestProviders>,
    );
    expect(
      container
        .querySelector("[data-slot='save-dot']")
        ?.getAttribute("data-state"),
    ).toBe("readonly");
  });
});
