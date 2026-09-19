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
  expectedProcesses,
  launchCommand,
  paneRunsAgent,
  planLaunch,
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
    expect(launchCommand("claude", undefined)).toBe("claude");
    expect(launchCommand("claude", "  ")).toBe("claude");
    expect(launchCommand("claude", "build it")).toBe("claude 'build it'");
    expect(launchCommand("opencode", "build it")).toBe(
      "opencode --prompt 'build it'",
    );
    expect(launchCommand("copilot", "build it")).toBe(
      "copilot --interactive 'build it'",
    );
    expect(launchCommand("custom:wrapper", "x")).toBe("wrapper 'x'");
    // A quote in the prompt closes and reopens rather than escaping the line.
    expect(launchCommand("claude", "it's")).toBe("claude 'it'\\''s'");
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
