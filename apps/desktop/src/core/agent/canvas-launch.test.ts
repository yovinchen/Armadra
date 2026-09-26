import {
  chmodSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installCollaborationSkill } from "../collab/skill";
import { artifactLayout, prepareInjection } from "../hook/install/inject";
import { launchLine as coldStartLine } from "../schedule/cold-start";
import { resumeLine } from "../terminal/hibernator";
import { tempDir } from "../testing/temp-dir";
import {
  canvasEnvironment,
  canvasLaunch,
  canvasLaunchLine,
  nodeDialect,
  startsThroughBatch,
} from "./canvas-launch";
import { quoteShellWord } from "../terminal/shell";
import type { AgentSettings, CustomAgent } from "./registry";

/**
 * The one exit every canvas launch line leaves through.
 *
 * Two halves: the shapes (each road carries the injection, a resume carries it
 * again), and a structural check that no road builds a launch line anywhere
 * else — a new launch path that skipped `canvas-launch.ts` would start CLIs
 * without our hooks, skill and rules, and nothing else would notice.
 */

const CORE = join(__dirname, "..");
const WEB = join(__dirname, "..", "..", "..", "..", "web", "src");

let dataDir: string;
let release: (() => void) | undefined;
const custom: CustomAgent[] = [];
const settings: AgentSettings = { customAgents: () => custom };

beforeEach(() => {
  const root = tempDir("armadra-canvas-launch-");
  dataDir = join(root, "data");
  const hookBin = join(root, "armadra-hook");
  writeFileSync(hookBin, "#!/bin/sh\n", "utf8");
  release = installCollaborationSkill();
  for (const agentId of ["claude", "codex", "opencode"]) {
    prepareInjection(agentId, {
      dataDir,
      env: { ...process.env, ARMADRA_HOOK_BIN: hookBin },
      skipTrust: true,
    });
  }
  custom.length = 0;
});

afterEach(() => {
  release?.();
  release = undefined;
});

describe("canvas launch lines", () => {
  it("appends Claude's injection after its own flags", () => {
    const layout = artifactLayout(dataDir, "claude");
    const launch = canvasLaunch({
      settings,
      dataDir,
      agentId: "claude",
      permissionMode: "plan",
      model: "opus",
    });
    expect(launch.program).toBe("claude");
    expect(launch.args).toEqual([
      "--permission-mode",
      "plan",
      "--model",
      "opus",
      "--settings",
      layout.settings,
      "--plugin-dir",
      layout.pluginDir,
      "--append-system-prompt-file",
      layout.instructions,
    ]);
  });

  it("carries the injection again on resume, after Codex's subcommand", () => {
    const line = canvasLaunchLine({
      settings,
      dataDir,
      agentId: "codex",
      resume: "thread-9",
      dialect: "posix",
    });
    expect(line.startsWith("codex resume thread-9 -c ")).toBe(true);
    expect(line).toContain("check_for_update_on_startup=false");
    expect(line).toContain('"hooks.SessionStart=${ARMADRA_CODEX_HOOK}"');
    expect(line).toContain(
      '"developer_instructions=${ARMADRA_CODEX_INSTRUCTIONS}"',
    );
    // Short and single: the values are in the terminal's environment.
    expect(line).not.toContain("\n");
    expect(line.length).toBeLessThan(600);
    const env = canvasEnvironment(settings, dataDir, "codex", "node-1");
    expect(env.map(([name]) => name)).toEqual([
      "ARMADRA_CODEX_HOOK",
      "ARMADRA_CODEX_INSTRUCTIONS",
    ]);
  });

  it("writes the line in the node shell's dialect", () => {
    const program = "C:\\Program Files\\codex.exe";
    const cmd = canvasLaunchLine({
      settings,
      dataDir,
      agentId: "codex",
      program,
      dialect: "cmd",
    });
    expect(cmd.startsWith('"C:\\Program Files\\codex.exe" -c ')).toBe(true);
    expect(cmd).toContain('"hooks.SessionStart=%ARMADRA_CODEX_HOOK%"');
    const powershell = canvasLaunchLine({
      settings,
      dataDir,
      agentId: "codex",
      program,
      dialect: "powershell",
    });
    expect(powershell.startsWith("& 'C:\\Program Files\\codex.exe' -c ")).toBe(
      true,
    );
    expect(powershell).toContain(
      '"hooks.SessionStart=${env:ARMADRA_CODEX_HOOK}"',
    );
    expect(nodeDialect("C:\\Windows\\system32\\cmd.exe")).toBe("cmd");
    expect(nodeDialect("pwsh.exe")).toBe("powershell");
    // An SSH node's line is read by the far host's shell.
    expect(nodeDialect("C:\\Windows\\system32\\cmd.exe", true)).toBe("posix");
  });

  /**
   * Windows PowerShell 5.1 strips a `"` when it passes an argument on, so
   * Codex's line goes after `--%` there and its variables are `%NAME%`,
   * written in the same C-runtime form as for `cmd.exe`.
   */
  it("writes Codex's line after --% for Windows PowerShell 5.1", () => {
    const line = canvasLaunchLine({
      settings,
      dataDir,
      agentId: "codex",
      program: "C:\\npm\\codex.exe",
      dialect: nodeDialect("powershell.exe"),
    });
    expect(line.startsWith("C:\\npm\\codex.exe -c ")).toBe(true);
    expect(line).toContain(' --% "hooks.SessionStart=%ARMADRA_CODEX_HOOK%"');
    const env = canvasEnvironment(
      settings,
      dataDir,
      "codex",
      "node-1",
      undefined,
      "windows-powershell",
    );
    const hook = env.find(([key]) => key === "ARMADRA_CODEX_HOOK")?.[1];
    expect(hook?.startsWith('[{hooks=[{type=\\"command\\"')).toBe(true);
  });

  /**
   * A wrapper that could not be read stays the program: the line is written
   * only when every word survives `cmd.exe`'s second read, and a value the
   * line expands is written for `cmd.exe` whatever shell types it.
   */
  it("keeps an unreadable batch wrapper to the words it cannot break", () => {
    const wrapper = join(tempDir("armadra-batch-"), "codex.cmd");
    writeFileSync(wrapper, '@echo off\r\nset "P=x"\r\n"%P%" %*\r\n', "utf8");
    chmodSync(wrapper, 0o755);
    custom.push({
      id: "custom:batch",
      label: "Batch",
      launchCmd: wrapper,
      baseAgent: "codex",
    });
    expect(startsThroughBatch(settings, "custom:batch")).toBe(true);
    expect(startsThroughBatch(settings, "codex")).toBe(false);
    const line = canvasLaunchLine({
      settings,
      dataDir,
      agentId: "custom:batch",
      program: wrapper,
      dialect: "powershell",
    });
    expect(line).toContain('"hooks.SessionStart=${env:ARMADRA_CODEX_HOOK}"');
    const env = canvasEnvironment(
      settings,
      dataDir,
      "custom:batch",
      "node-1",
      undefined,
      "powershell",
    );
    const hook = env.find(([key]) => key === "ARMADRA_CODEX_HOOK")?.[1];
    expect(hook).not.toMatch(/(^|[^\\])"/);
    expect(() =>
      canvasLaunchLine({
        settings,
        agentId: "custom:batch",
        program: wrapper,
        frozenArgs: ["--prompt", "fix a&b"],
        dialect: "cmd",
      }),
    ).toThrow(/batch/);
  });

  it("injects a custom entry as its base", () => {
    custom.push({
      id: "custom:mine",
      label: "Mine",
      launchCmd: "/opt/claude-wrapper",
      baseAgent: "claude",
    });
    const launch = canvasLaunch({ settings, dataDir, agentId: "custom:mine" });
    expect(launch.program).toBe("/opt/claude-wrapper");
    expect(launch.args).toContain("--plugin-dir");
  });

  it("hands the environment half to the node's terminal", () => {
    const layout = artifactLayout(dataDir, "opencode");
    const env = canvasEnvironment(settings, dataDir, "opencode", "node-1");
    expect(env[0]).toEqual(["OPENCODE_CONFIG_DIR", layout.configDir]);
    expect(canvasEnvironment(settings, dataDir, "claude", "node-1")).toEqual(
      [],
    );
  });

  /** The road that used to leave `--settings` off. */
  it("gives a schedule's cold start the injection, not the frozen plan", () => {
    const spec = {
      agentId: "claude",
      workingDirectory: "/tmp/ws",
      args: ["--model", "opus"],
      permissionMode: "",
      modelId: "",
      accountId: "default",
    };
    const line = coldStartLine(settings, spec, dataDir);
    expect(
      line.startsWith(
        `claude --model opus --settings ${quoteShellWord(artifactLayout(dataDir, "claude").settings as string, nodeDialect(undefined))}`,
      ),
    ).toBe(true);
    expect(coldStartLine(settings, spec)).toBe("claude --model opus");
  });

  it("gives the Eco wake-up the injection on its resume line", () => {
    const line = resumeLine(
      settings,
      "claude",
      { agent: { id: "claude" } },
      "session-1",
      { dataDir },
    );
    expect(line).toContain("--resume session-1");
    expect(line).toContain("--append-system-prompt-file");
  });

  it("leaves an SSH node's line bare: the host's shims inject", () => {
    const launch = canvasLaunch({
      settings,
      dataDir,
      agentId: "claude",
      nodeId: "n1",
      model: "opus",
      program: "/opt/homebrew/bin/claude",
      dialect: "cmd",
      ssh: true,
    });
    // 本机的程序路径与注入路径在执行主机上都不存在；行按 POSIX 写。
    expect(launch.line).toBe("claude --model opus");
    const resumed = resumeLine(
      settings,
      "codex",
      { agent: { id: "codex" }, ssh: { hostId: "far" } },
      "thread-1",
      { dataDir, path: "/usr/local/bin/codex" },
    );
    expect(resumed).toBe("codex resume thread-1");
  });
});

/* ------------------------------- structure -------------------------------- */

function sources(root: string): string[] {
  const out: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if (entry === "node_modules") continue;
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        out.push(path);
      }
    }
  };
  walk(root);
  return out;
}

function callers(root: string, pattern: RegExp): string[] {
  return sources(root)
    .filter((path) => pattern.test(readFileSync(path, "utf8")))
    .map((path) => relative(root, path).split(sep).join("/"))
    .sort();
}

describe("the single exit", () => {
  /**
   * `planLaunch` turns a node's agent into flags. Anything that calls it is
   * building a launch line, and the only place allowed to is the exit that
   * adds the injection.
   */
  it("builds core launch lines in canvas-launch.ts only", () => {
    expect(callers(CORE, /(?<!function )\bplanLaunch\(/)).toEqual([
      "agent/canvas-launch.ts",
    ]);
  });

  /** The page quotes with `@armadra/shared`, the core with its own copy. */
  it("keeps the core's quoting rules byte for byte the page's", () => {
    const shared = join(CORE, "..", "..", "..", "..", "packages", "shared");
    expect(readFileSync(join(CORE, "terminal", "shell.ts"), "utf8")).toBe(
      readFileSync(join(shared, "src", "shell.ts"), "utf8"),
    );
  });

  it("answers the injection argv from inject.ts to the exit and the list only", () => {
    expect(callers(CORE, /(?<!function )\bcanvasInjection\(/)).toEqual([
      "agent/canvas-launch.ts",
      "hook/install/integration.ts",
    ]);
  });

  /** `launchCommand` is the bare program for display, never a launch. */
  it("uses the bare launch command only for what open-agent reports", () => {
    expect(callers(CORE, /(?<!function )\blaunchCommand\(/)).toEqual([
      "collab/control/nodes.ts",
    ]);
  });

  /**
   * The page builds its own lines, from `GET /api/agents`: every one of them
   * goes through `agent/launch.ts`, which appends the row's `launchArgs`.
   */
  it("builds page launch lines in agent/launch.ts only, with the injection", () => {
    expect(callers(WEB, /\bassemble(LaunchCommand|LaunchArgv)\(/)).toEqual([
      "agent/launch.ts",
    ]);
    const launch = readFileSync(join(WEB, "agent", "launch.ts"), "utf8");
    expect(launch).toContain("?.launchWords");
    expect(launch).toContain("?.launchArgs");
    expect(launch).toMatch(/shellWords: words/);
    expect(launch).toMatch(/extraArgs: injected/);
  });
});
