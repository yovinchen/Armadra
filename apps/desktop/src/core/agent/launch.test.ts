import { describe, expect, it } from "vitest";
import {
  agentEnvironment,
  contextSessionEnvironment,
} from "../terminal/environment";
import {
  LaunchRefused,
  PERMISSION_MODES,
  canResume,
  canSelectModel,
  exitCommand,
  expectedProcesses,
  launchCommand,
  paneRunsAgent,
  planLaunch,
  promptModeFor,
  supportedPermissionModes,
} from "./launch";
import { AGENT_REGISTRY } from "./registry";

const NO_CUSTOM = { customAgents: () => [] };

function withCustom(entry: Record<string, unknown>) {
  return { customAgents: () => [entry as never] };
}

describe("launch parameters", () => {
  it("offers only the permission modes a CLI really has a flag for", () => {
    expect(supportedPermissionModes("claude")).toEqual([...PERMISSION_MODES]);
    // Pi has no approval or plan flag of its own; its tool policy is its own.
    expect(supportedPermissionModes("pi")).toEqual(["default"]);
    // Oh My Pi has approval modes but no persistent read-only plan mode.
    expect(supportedPermissionModes("omp")).toEqual([
      "default",
      "auto-edit",
      "full-auto",
    ]);
    expect(supportedPermissionModes("unknown-cli")).toEqual(["default"]);
  });

  it("refuses a permission mode the CLI cannot express instead of guessing", () => {
    expect(() =>
      planLaunch(NO_CUSTOM, { agentId: "pi", permissionMode: "plan" }),
    ).toThrow(LaunchRefused);
    expect(() =>
      planLaunch(NO_CUSTOM, { agentId: "claude", permissionMode: "yolo" }),
    ).toThrow(LaunchRefused);
    expect(
      planLaunch(NO_CUSTOM, { agentId: "claude", permissionMode: "plan" }).args,
    ).toEqual(["--permission-mode", "plan"]);
  });

  it("puts codex's resume subcommand before every flag", () => {
    const plan = planLaunch(NO_CUSTOM, {
      agentId: "codex",
      resume: "abc",
      model: "gpt-5",
      permissionMode: "auto-edit",
    });
    expect(plan.program).toBe("codex");
    expect(plan.args).toEqual([
      "resume",
      "abc",
      "--full-auto",
      "--model",
      "gpt-5",
    ]);
  });

  it("lets resume win over a pre-minted session id", () => {
    const both = planLaunch(NO_CUSTOM, {
      agentId: "claude",
      resume: "old",
      sessionId: "new",
    });
    expect(both.args).toEqual(["--resume", "old"]);
    const fresh = planLaunch(NO_CUSTOM, {
      agentId: "claude",
      sessionId: "new",
    });
    expect(fresh.args).toEqual(["--session-id", "new"]);
  });

  it("honours a custom entry's disabled capabilities", () => {
    const settings = withCustom({
      id: "custom:narrow",
      label: "Narrow",
      launchCmd: "/opt/wrapper",
      baseAgent: "claude",
      args: ["--flag"],
      disabledCapabilities: ["resume", "supportsModelSelection"],
    });
    expect(canResume(settings, "custom:narrow")).toBe(false);
    expect(canSelectModel(settings, "custom:narrow")).toBe(false);
    expect(() =>
      planLaunch(settings, { agentId: "custom:narrow", resume: "abc" }),
    ).toThrow(LaunchRefused);
    // A model that cannot be selected is reported, not silently dropped.
    const plan = planLaunch(settings, {
      agentId: "custom:narrow",
      model: "opus",
    });
    expect(plan.program).toBe("/opt/wrapper");
    expect(plan.omitted).toContain("modelSelectionUnavailable");
    expect(plan.args).toEqual(["--flag"]);
  });

  it("keeps a flag-prompt CLI's prompt behind its flag", () => {
    expect(
      planLaunch(NO_CUSTOM, { agentId: "opencode", prompt: "do it" }).args,
    ).toEqual(["--prompt", "do it"]);
    expect(
      planLaunch(NO_CUSTOM, { agentId: "claude", prompt: "do it" }).args,
    ).toEqual(["do it"]);
  });

  it("quotes the shell line `open-agent` writes into a node", () => {
    expect(launchCommand(NO_CUSTOM, "claude", undefined)).toBe("claude");
    expect(launchCommand(NO_CUSTOM, "claude", "  ")).toBe("claude");
    expect(launchCommand(NO_CUSTOM, "claude", "build it")).toBe(
      "claude 'build it'",
    );
    expect(launchCommand(NO_CUSTOM, "opencode", "build it")).toBe(
      "opencode --prompt 'build it'",
    );
    expect(launchCommand(NO_CUSTOM, "copilot", "build it")).toBe(
      "copilot --interactive 'build it'",
    );
    // A `custom:` id with no settings row has no base, and therefore no known
    // prompt shape. It still starts — the program name is all the id carries —
    // but nothing is guessed onto its line, the same rule `hasCapability`
    // applies to an entry whose base is unknown.
    expect(launchCommand(NO_CUSTOM, "custom:wrapper", "x")).toBe("wrapper");
    // A quote in the prompt closes and reopens rather than escaping the line.
    expect(launchCommand(NO_CUSTOM, "claude", "it's")).toBe(
      "claude 'it'\\''s'",
    );
  });

  // 设计 agent-delivery.md §8.2 E1：`custom:` 的 id 在 `PROFILES` 里没有行，
  // 从原样的 id 解析提示词形状会把每一个自定义 Agent 都丢进位置参数分支——而
  // base 是 Copilot 的那个，裸位置参数就是 `-p`：非交互，跑完就退出。
  it("gives a custom entry its base's prompt shape, not a bare positional", () => {
    const settings = withCustom({
      id: "custom:cop",
      label: "Cop",
      launchCmd: "/opt/cop",
      baseAgent: "copilot",
      args: [],
    });
    expect(launchCommand(settings, "custom:cop", "do it")).toBe(
      "/opt/cop --interactive 'do it'",
    );
    expect(
      planLaunch(settings, { agentId: "custom:cop", prompt: "do it" }).args,
    ).toEqual(["--interactive", "do it"]);
  });

  // E2：`stdin-after-start` 是一句「这条命令行不是投递通道」的声明。
  it("keeps a stdin-after-start entry's prompt off the launch line", () => {
    const settings = withCustom({
      id: "custom:tui",
      label: "Tui",
      launchCmd: "tui",
      baseAgent: "claude",
      args: [],
      promptMode: "stdin-after-start",
    });
    expect(launchCommand(settings, "custom:tui", "do it")).toBe("tui");
    const plan = planLaunch(settings, {
      agentId: "custom:tui",
      prompt: "do it",
    });
    expect(plan.args).toEqual([]);
    expect(plan.omitted).toContain("promptNotOnLaunchLine");
  });

  // 三份表对「第一条提示词」的说法必须一致（§8.2 的那张核对表）。
  it("agrees with the registry on every built-in's prompt shape", () => {
    for (const agent of AGENT_REGISTRY) {
      expect(promptModeFor(NO_CUSTOM, agent.id)).toBe(agent.promptMode);
      const line = launchCommand(NO_CUSTOM, agent.id, "x");
      expect(line.startsWith(`${agent.launchCmd} `)).toBe(true);
      expect(line.endsWith("'x'")).toBe(true);
    }
  });

  it("names the program a pane must still be running", () => {
    for (const agent of AGENT_REGISTRY) {
      expect(expectedProcesses(agent.id)).toEqual([agent.id]);
    }
    expect(expectedProcesses("custom:wrapper")).toEqual(["wrapper"]);
    expect(expectedProcesses("custom:")).toEqual([]);
  });

  it("matches the pane by program name, not by prefix", () => {
    expect(paneRunsAgent({ command: "claude" }, ["claude"])).toBe(true);
    expect(
      paneRunsAgent({ command: "/opt/bin/claude --resume" }, ["claude"]),
    ).toBe(true);
    expect(
      paneRunsAgent({ command: "node /usr/lib/claude/cli.js" }, ["claude"]),
    ).toBe(true);
    expect(paneRunsAgent({ command: "claude-code-notifier" }, ["claude"])).toBe(
      false,
    );
    expect(paneRunsAgent({ children: ["codex"] }, ["codex"])).toBe(true);
    // An empty expectation never grants: the gate only ever refuses.
    expect(paneRunsAgent({ command: "claude" }, [])).toBe(false);
  });

  /** The page's registry says the same (`packages/shared` agents test). */
  it("knows each CLI's own quit command, a custom entry its base's", () => {
    expect(
      Object.fromEntries(
        AGENT_REGISTRY.map((agent) => [
          agent.id,
          exitCommand(NO_CUSTOM, agent.id),
        ]),
      ),
    ).toEqual({
      claude: "/exit",
      codex: "/quit",
      opencode: "/exit",
      pi: "/quit",
      omp: "/exit",
      copilot: "/exit",
    });
    expect(
      exitCommand(
        withCustom({ id: "custom:c", launchCmd: "x", baseAgent: "codex" }),
        "custom:c",
      ),
    ).toBe("/quit");
  });
});

describe("the environment an agent session starts with", () => {
  it("carries addresses only, and never a credential", () => {
    const env = agentEnvironment("node-1", "claude", "/data");
    const lookup = (key: string) => env.find(([name]) => name === key)?.[1];
    expect(lookup("ARMADRA_NODE_ID")).toBe("node-1");
    expect(lookup("ARMADRA_AGENT_ID")).toBe("claude");
    expect(lookup("ARMADRA_CANVAS_CONTROL")).toBe("1");
    expect(lookup("ARMADRA_ENDPOINT_FILE")?.endsWith("hook-endpoint.env")).toBe(
      true,
    );
    expect(env.every(([name]) => !name.includes("TOKEN"))).toBe(true);
    expect(env).toHaveLength(4);
  });

  it("adds the session pair only for a terminal that has a node", () => {
    const withNode = contextSessionEnvironment(
      agentEnvironment("node-1", "claude", "/data"),
      "session-1",
      2,
    );
    expect(withNode).toHaveLength(6);
    expect(withNode.find(([k]) => k === "ARMADRA_SESSION_ID")?.[1]).toBe(
      "session-1",
    );
    expect(
      withNode.find(([k]) => k === "ARMADRA_SESSION_GENERATION")?.[1],
    ).toBe("2");
    // No node: nothing to attribute a report to, so nothing is injected.
    expect(contextSessionEnvironment([["PATH", "/bin"]], "s", 1)).toEqual([
      ["PATH", "/bin"],
    ]);
  });

  it("replaces the session pair on a recycle rather than appending", () => {
    const first = contextSessionEnvironment(
      agentEnvironment("node-1", "claude", "/data"),
      "session-1",
      1,
    );
    const second = contextSessionEnvironment(first, "session-1", 2);
    expect(second.filter(([k]) => k === "ARMADRA_SESSION_ID")).toHaveLength(1);
    expect(second.find(([k]) => k === "ARMADRA_SESSION_GENERATION")?.[1]).toBe(
      "2",
    );
  });
});
