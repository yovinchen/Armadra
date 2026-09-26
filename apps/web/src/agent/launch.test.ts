import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentInfo } from "@armadra/shared";

import { setCoreHost } from "@/app/core-host";
import {
  agentColor,
  agentColorVar,
  agentLabel,
  agentSessionRequest,
  buildAgentLaunch,
  buildResumeLaunch,
  customAgentFor,
  launchDialect,
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

  it("列表尚未提供自定义 Agent 时不猜测基础程序", () => {
    expect(customAgentFor("custom:echo")).toBeUndefined();
    expect(() => buildAgentLaunch({ id: "custom:echo" })).toThrow(
      /Unknown agent/,
    );
  });

  it("运行时收窄的恢复能力不会在启动时重新授予", () => {
    setAgentRegistry([echo]);
    expect(customAgentFor(echo.id)?.disabledCapabilities).toContain("resume");
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

describe("启动行按节点终端的 shell 引用", () => {
  const codex: AgentInfo = {
    id: "codex",
    label: "Codex",
    color: "#000",
    launchCmd: "codex",
    promptMode: "argv",
    capabilities: [],
    args: [],
    resolvedPath: "C:\\Users\\Ada Bell\\AppData\\Roaming\\npm\\codex.cmd",
    installed: true,
    launchWords: ["-c", { prefix: "hooks.Stop=", env: "ARMADRA_CODEX_HOOK" }],
  };

  afterEach(() => {
    setCoreHost(undefined);
  });

  it("会话记录里的 shell 优先，其次节点指定的，再次 core 的缺省", () => {
    setCoreHost({ platform: "win32", defaultShell: "cmd.exe" });
    expect(
      launchDialect({}, "C:\\Program Files\\PowerShell\\7\\pwsh.exe"),
    ).toBe("powershell");
    expect(launchDialect({ shell: "/usr/bin/fish" })).toBe("fish");
    expect(launchDialect({})).toBe("cmd");
    // SSH 节点的行由远端的登录 shell 读。
    expect(launchDialect({ ssh: { hostId: "h" } }, "cmd.exe")).toBe("posix");
    setCoreHost(undefined);
    expect(launchDialect({})).toBe("posix");
  });

  it("cmd.exe 与 PowerShell 各用自己的引号和环境变量写法", () => {
    setAgentRegistry([codex]);
    expect(buildAgentLaunch({ id: "codex" }, undefined, "cmd").command).toBe(
      '"C:\\Users\\Ada Bell\\AppData\\Roaming\\npm\\codex.cmd" -c "hooks.Stop=%ARMADRA_CODEX_HOOK%"',
    );
    expect(
      buildAgentLaunch({ id: "codex" }, undefined, "powershell").command,
    ).toBe(
      "& 'C:\\Users\\Ada Bell\\AppData\\Roaming\\npm\\codex.cmd' -c \"hooks.Stop=${env:ARMADRA_CODEX_HOOK}\"",
    );
    // 恢复行没有显式方言时按 core 的缺省 shell。
    setCoreHost({ platform: "win32", defaultShell: "cmd.exe" });
    expect(buildResumeLaunch("codex", "t-1").command).toBe(
      '"C:\\Users\\Ada Bell\\AppData\\Roaming\\npm\\codex.cmd" resume t-1 -c "hooks.Stop=%ARMADRA_CODEX_HOOK%"',
    );
  });
});

describe("建会话请求里的账号绑定（S02 预留）", () => {
  it("没有绑定就不发 accountId，不凭空替用户选一个账号", () => {
    expect(agentSessionRequest({ id: "claude" })).toEqual({ id: "claude" });
    expect(
      agentSessionRequest({ id: "claude", permissionMode: "plan" }),
    ).toEqual({ id: "claude", permissionMode: "plan" });
  });

  it("字段存在时原样透传 accountId，前端不做放行判断", () => {
    // 非 default 也照发：拒不拒绝是 Runtime 的事，前端假装拦住只会掩盖问题。
    expect(
      agentSessionRequest({
        id: "claude",
        account: { accountId: "work", providerId: "claude" },
      }),
    ).toEqual({ id: "claude", accountId: "work" });
    expect(agentSessionRequest({ id: "claude", accountId: "default" })).toEqual(
      { id: "claude", accountId: "default" },
    );
    // 新字段优先于旧的扁平 accountId。
    expect(
      agentSessionRequest({
        id: "claude",
        accountId: "old",
        account: { accountId: "new" },
      }).accountId,
    ).toBe("new");
  });

  it("凭据引用不上行：Runtime 没有凭据接口，发过去也没人读", () => {
    const request = agentSessionRequest({
      id: "claude",
      account: {
        accountId: "default",
        credentialRef: "keychain://armadra/claude/default",
      },
    });
    expect(JSON.stringify(request)).not.toContain("keychain");
  });
});
