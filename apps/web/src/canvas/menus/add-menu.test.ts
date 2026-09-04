import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentInfo, SshHost, Workspace } from "@armadra/shared";
import { buildAddMenu, sshMenuItems, type AddMenuContext } from "./add-menu";
import { clearCanvasCommands, registerCanvasCommand } from "../commands";
import { useCanvasStore } from "../../store/canvas-store";
import { t, usePreferencesStore } from "../../app/preferences-store";

const workspace = {
  id: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "One",
  rootPath: "/tmp/one",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  lastOpenedAt: "2026-08-13T00:00:00.000Z",
  createdAt: "2026-08-13T00:00:00.000Z",
  updatedAt: "2026-08-13T00:00:00.000Z",
} as Workspace;

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
};

const codex: AgentInfo = {
  ...claude,
  id: "codex",
  label: "Codex",
  color: "#10a37f",
  launchCmd: "codex",
  resolvedPath: null,
  installed: false,
};

/** 自定义 Agent：Runtime 已经把它接在内置项之后一起发过来（§24.1）。 */
const echo: AgentInfo = {
  ...claude,
  id: "custom:echo",
  label: "Echo",
  launchCmd: "/bin/echo",
  args: ["hello"],
  baseAgent: "claude",
  resolvedPath: "/bin/echo",
  installed: true,
};

function context(addNode = vi.fn()): AddMenuContext {
  return {
    addNode: addNode as unknown as AddMenuContext["addNode"],
    position: { x: 120, y: 80 },
    workspace,
    agents: [claude, codex],
  };
}

beforeEach(() => {
  clearCanvasCommands();
  usePreferencesStore.setState({ defaultPermissionMode: "default" });
});

const box: SshHost = {
  id: "box",
  name: "构建机",
  host: "build.example.com",
  user: "ada",
  port: 2222,
};

describe("SSH 终端项", () => {
  it("没有主机时整组不出现", () => {
    expect(sshMenuItems([], t)).toEqual([]);
    expect(buildAddMenu([], t).some((item) => item.group === "ssh")).toBe(
      false,
    );
  });

  it("每台主机一项，插在 Agent 之后、便签之前", () => {
    const ids = buildAddMenu([claude], t, [box]).map((item) => item.id);
    expect(ids.slice(0, 4)).toEqual([
      "add.terminal",
      "add.agent.claude",
      "add.ssh.box",
      "add.sticky",
    ]);
    expect(
      buildAddMenu([], t, [box]).find((item) => item.id === "add.ssh.box")
        ?.label,
    ).toContain("构建机");
  });

  it("建的是带 ssh 段、标题为主机名的终端节点", () => {
    const addNode = vi.fn();
    const ctx = context(addNode);
    buildAddMenu([], t, [box])
      .find((item) => item.id === "add.ssh.box")
      ?.run(ctx);
    expect(addNode).toHaveBeenCalledWith("terminal", {
      position: { x: 120, y: 80 },
      title: "构建机",
      data: { kind: "terminal", ssh: { hostId: "box" } },
    });
  });
});

describe("buildAddMenu", () => {
  it("按 §3.2 的顺序排列，Agent 插在新建终端后面", () => {
    const ids = buildAddMenu([claude, codex], t).map((item) => item.id);
    expect(ids).toEqual([
      "add.terminal",
      "add.agent.claude",
      "add.agent.codex",
      "add.sticky",
      "add.files",
      "add.openFile",
      "add.importFiles",
      "add.text",
      "add.frame",
      "add.browser",
      "canvas.selectAll",
      "canvas.fitView",
      "canvas.tidy",
    ]);
  });

  it("没有 Agent 时依然给出全部通用项", () => {
    expect(buildAddMenu([], t).map((item) => item.group)).toEqual([
      "terminal",
      "content",
      "content",
      "content",
      "content",
      "content",
      "content",
      "content",
      "canvas",
      "canvas",
      "canvas",
    ]);
  });

  it("Agent 项用 Agent 的标签与品牌色", () => {
    const item = buildAddMenu([claude], t).find(
      (entry) => entry.id === "add.agent.claude",
    );
    expect(item).toMatchObject({ label: "Claude Code", color: "#d97757" });
  });

  it("探测不到可执行文件的 Agent 被禁用而不是隐藏", () => {
    const items = buildAddMenu([claude, codex], t);
    const ctx = context();
    expect(
      items
        .find((item) => item.id === "add.agent.claude")
        ?.disabledReason?.(ctx),
    ).toBeNull();
    expect(
      items
        .find((item) => item.id === "add.agent.codex")
        ?.disabledReason?.(ctx),
    ).toBe("未安装");
  });

  it("自定义 Agent 和内置 Agent 排在同一组里", () => {
    const items = buildAddMenu([claude, echo], t);
    expect(items.map((item) => item.id).slice(0, 3)).toEqual([
      "add.terminal",
      "add.agent.claude",
      "add.agent.custom:echo",
    ]);
    const item = items.find((entry) => entry.id === "add.agent.custom:echo");
    // 名字是用户起的，色点是它借用的内置 Agent 的品牌色。
    expect(item).toMatchObject({
      label: "Echo",
      group: "agent",
      color: "#d97757",
    });
    expect(item?.disabledReason?.(context())).toBeNull();

    const addNode = vi.fn();
    item?.run(context(addNode));
    expect(addNode).toHaveBeenCalledWith("terminal", {
      position: { x: 120, y: 80 },
      title: "Echo",
      data: { kind: "terminal", agent: { id: "custom:echo" } },
    });
  });

  it("新建终端落在给定位置", () => {
    const addNode = vi.fn();
    const ctx = context(addNode);
    buildAddMenu([], t)
      .find((item) => item.id === "add.terminal")
      ?.run(ctx);
    expect(addNode).toHaveBeenCalledWith("terminal", {
      position: { x: 120, y: 80 },
    });
  });

  it("Agent 项建的是带 agent 段的终端节点", () => {
    const addNode = vi.fn();
    const ctx = context(addNode);
    buildAddMenu([claude], t)
      .find((item) => item.id === "add.agent.claude")
      ?.run(ctx);
    expect(addNode).toHaveBeenCalledWith("terminal", {
      position: { x: 120, y: 80 },
      title: "Claude Code",
      data: { kind: "terminal", agent: { id: "claude" } },
    });
  });

  it("文件管理器落在工作空间根目录", () => {
    const addNode = vi.fn();
    const ctx = context(addNode);
    buildAddMenu([], t)
      .find((item) => item.id === "add.files")
      ?.run(ctx);
    expect(addNode).toHaveBeenCalledWith("files", {
      position: { x: 120, y: 80 },
      data: { kind: "files", path: "/tmp/one" },
    });
  });

  it("打开文件…只是打开资源管理器抽屉", () => {
    const addNode = vi.fn();
    const ctx = context(addNode);
    buildAddMenu([], t)
      .find((item) => item.id === "add.openFile")
      ?.run(ctx);
    expect(addNode).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().panels.explorer).toBe("drawer");
  });

  it("画布动作转发给命令注册表", () => {
    const tidy = vi.fn();
    registerCanvasCommand("canvas.tidy", tidy);
    buildAddMenu([], t)
      .find((item) => item.id === "canvas.tidy")
      ?.run(context());
    expect(tidy).toHaveBeenCalledOnce();
  });

  it("命令没注册时是安全的空操作", () => {
    expect(() =>
      buildAddMenu([], t)
        .find((item) => item.id === "canvas.fitView")
        ?.run(context()),
    ).not.toThrow();
  });
});

it("applies the saved permission default and refuses unsupported modes without creating a node", () => {
  usePreferencesStore.setState({ defaultPermissionMode: "plan" });
  const addNode = vi.fn();
  buildAddMenu([claude], t)
    .find((item) => item.id === "add.agent.claude")
    ?.run(context(addNode));
  expect(addNode.mock.calls[0]?.[1].data.agent.permissionMode).toBe("plan");
  addNode.mockClear();
  const pi = { ...claude, id: "pi", label: "Pi", launchCmd: "pi" };
  buildAddMenu([pi], t)
    .find((item) => item.id === "add.agent.pi")
    ?.run(context(addNode));
  expect(addNode).not.toHaveBeenCalled();
});
