import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installCollaborationSkill } from "../../collab/skill";
import { configPath as codexConfigPath } from "./codex";
import {
  HOOK_CLIENT_REVISION,
  INTEGRATION_REVISION,
  SKILLS_REVISION,
} from "./events";
import { INJECTED_AGENTS, artifactLayout } from "./inject";
import {
  type IntegrationOptions,
  install,
  prepareAtStartup,
  state,
  uninstall,
} from "./integration";
import { readMigration } from "./migrate";
import { tempDir } from "../../testing/temp-dir";

let root: string;
let hookBin: string;
let release: (() => void) | undefined;

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ARMADRA_HOOK_BIN: hookBin,
    HOME: join(root, "home"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    CODEX_HOME: join(root, "codex"),
    COPILOT_HOME: join(root, "copilot"),
    XDG_CONFIG_HOME: join(root, "xdg"),
    PI_CODING_AGENT_DIR: join(root, "pi"),
    ARMADRA_NO_GLOBAL_WRITES: "",
    ...extra,
  };
}

function options(agentId: string): IntegrationOptions {
  return {
    dataDir: join(root, "data"),
    env: env(),
    ...(agentId === "codex" ? { home: join(root, "codex") } : {}),
  };
}

beforeEach(() => {
  root = tempDir("armadra-integration-");
  hookBin = join(root, "bin", "armadra-hook");
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(hookBin, "#!/bin/sh\n", "utf8");
  release = installCollaborationSkill();
});

afterEach(() => {
  release?.();
  release = undefined;
});

describe("the canvas integration", () => {
  /**
   * The composed revision is what makes hook and skill one switch: a change to
   * either half has to move it, or a stale artifact reads as current.
   */
  it("carries both halves in the revision", () => {
    expect(INTEGRATION_REVISION).toBe(
      HOOK_CLIENT_REVISION * 100 + SKILLS_REVISION,
    );
  });

  it("reads as missing, then current after a regeneration, then gone", () => {
    for (const agentId of INJECTED_AGENTS) {
      const before = state(agentId, options(agentId));
      expect(before.mode).toBe("canvas");
      expect(before.hook.installed, agentId).toBe(false);
      expect(before.skill.installed, agentId).toBe(false);
      expect(before.launchArgs).toEqual([]);

      const after = install(agentId, options(agentId));
      expect(after.hook.installed, agentId).toBe(true);
      expect(after.skill.installed, agentId).toBe(true);
      expect(after.skill.revision).toBe(SKILLS_REVISION);
      expect(after.installedRevision).toBe(INTEGRATION_REVISION);
      expect(after.stale).toBe(false);
      expect(after.launchArgs.length + after.launchEnv.length).toBeGreaterThan(
        0,
      );
      expect(after.skill.path?.startsWith(join(root, "data"))).toBe(true);

      const removed = uninstall(agentId, options(agentId));
      expect(removed.hook.installed, agentId).toBe(false);
      expect(existsSync(artifactLayout(join(root, "data"), agentId).dir)).toBe(
        false,
      );
    }
  });

  /** The page names Codex's trust records as the one global write. */
  it("names the only global write, and only for Codex", () => {
    for (const agentId of INJECTED_AGENTS) {
      const answer = state(agentId, options(agentId));
      expect(answer.globalWrites).toEqual(
        agentId === "codex" ? [codexConfigPath(join(root, "codex"))] : [],
      );
    }
  });

  it("refuses a CLI it has no injection for", () => {
    expect(() => state("custom:thing", options("x"))).toThrow(
      /no canvas injection/,
    );
  });
});

describe("start-up", () => {
  it("migrates once and prepares every CLI", () => {
    const dataDir = join(root, "data");
    mkdirSync(join(root, "codex"), { recursive: true });
    const report = prepareAtStartup({ dataDir, env: env() });
    expect(report.failures).toEqual([]);
    expect(report.prepared).toEqual([...INJECTED_AGENTS]);
    expect(readMigration(dataDir)).toEqual(report.migration);
    // Codex has a config home here, so its trust records went in.
    expect(existsSync(codexConfigPath(join(root, "codex")))).toBe(true);
    for (const agentId of INJECTED_AGENTS) {
      expect(state(agentId, options(agentId)).hook.installed, agentId).toBe(
        true,
      );
    }
  });

  it("creates no Codex home on a machine that never ran Codex", () => {
    prepareAtStartup({ dataDir: join(root, "data"), env: env() });
    expect(existsSync(join(root, "codex"))).toBe(false);
  });

  it("touches nothing global when global writes are off", () => {
    const dataDir = join(root, "data");
    mkdirSync(join(root, "codex"), { recursive: true });
    const report = prepareAtStartup({
      dataDir,
      env: env({ ARMADRA_NO_GLOBAL_WRITES: "1" }),
    });
    expect(report.migration).toBeUndefined();
    expect(readMigration(dataDir)).toBeUndefined();
    expect(existsSync(codexConfigPath(join(root, "codex")))).toBe(false);
  });
});
