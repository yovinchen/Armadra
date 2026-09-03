import { beforeEach, describe, expect, it } from "vitest";
import type { AgentInfo } from "@ai-coding-canvas/shared";

import {
  agentColor,
  agentColorVar,
  agentLabel,
  buildAgentLaunch,
  customAgentFor,
  setAgentRegistry,
} from "./launch";

const echo: AgentInfo = {
  id: "custom:echo",
  label: "Echo",
  // Runtime reports the base agent's brand colour, not the settings dot.
  color: "#d97757",
  launchCmd: "/bin/echo",
  promptMode: "argv",
  capabilities: ["hooks"],
  args: ["hello"],
  baseAgent: "claude",
  resolvedPath: "/bin/echo",
  installed: true,
};

beforeEach(() => {
  setAgentRegistry([]);
});

describe("自定义 Agent 的显示名与颜色", () => {
  it("在 GET /api/agents 到达之前退回 id 的可读部分", () => {
    expect(agentLabel("custom:echo")).toBe("echo");
    expect(agentColorVar("custom:echo")).toBe("var(--agent-opencode)");
  });

  it("列表到了之后用自定义名字与借用的品牌色", () => {
    setAgentRegistry([echo]);
    expect(agentLabel("custom:echo")).toBe("Echo");
    expect(agentColor("custom:echo")).toBe("#d97757");
    // 借用 claude 的变量，主题切换才跟得住。
    expect(agentColorVar("custom:echo")).toBe("var(--agent-claude)");
  });

  it("不影响内置 Agent", () => {
    setAgentRegistry([echo]);
    expect(agentLabel("claude")).toBe("Claude Code");
    expect(agentColorVar("codex")).toBe("var(--agent-codex)");
    expect(agentLabel(undefined)).toBe("");
  });
});

describe("自定义 Agent 的启动行", () => {
  it("用自定义程序与它自己的参数", () => {
    setAgentRegistry([echo]);
    expect(customAgentFor("custom:echo")).toMatchObject({
      launchCmd: "/bin/echo",
      args: ["hello"],
      baseAgent: "claude",
    });
    const launch = buildAgentLaunch({
      id: "custom:echo",
      permissionMode: "plan",
    });
    expect(launch.command).toBe("/bin/echo --permission-mode plan hello");
  });

  it("列表还没到时退回基础 Agent，而不是抛错", () => {
    expect(customAgentFor("custom:echo")).toBeUndefined();
    expect(buildAgentLaunch({ id: "custom:echo" }).command).toBe("claude");
  });
});

describe("启动行用探测到的绝对路径", () => {
  it("内置 Agent 有 resolvedPath 时不再敲裸命令名", () => {
    setAgentRegistry([
      {
        id: "codex",
        label: "Codex",
        color: "#000",
        launchCmd: "codex",
        promptMode: "argv",
        capabilities: [],
        args: [],
        resolvedPath: "/Users/me/.local/share/mise/installs/node/26/bin/codex",
        installed: true,
      },
    ]);
    const launch = buildAgentLaunch({ id: "codex" });
    expect(launch.command).toMatch(
      /^\/Users\/me\/\.local\/share\/mise\/installs\/node\/26\/bin\/codex/,
    );
  });

  it("没探测到时仍用注册表里的命令名", () => {
    const launch = buildAgentLaunch({ id: "codex" });
    expect(launch.command.startsWith("codex")).toBe(true);
  });
});
