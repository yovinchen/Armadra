import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HOOK_CLIENT_REVISION,
  INTEGRATION_REVISION,
  SKILLS_REVISION,
} from "./events";
import { adapterPath, launchArgs } from "./index";
import {
  type IntegrationOptions,
  install,
  state,
  uninstall,
} from "./integration";
import { injectionMode } from "./shared";
import { registerSkillInstaller, skillFile } from "./skills";
import { tempDir } from "../../testing/temp-dir";

const AGENT_IDS = ["claude", "codex", "opencode", "pi", "omp", "copilot"];

/**
 * A config home that is absolute on the host running the test: a `/home/dev/…`
 * literal is a relative path on Windows, where every assertion below about an
 * absolute adapter path would then be vacuous.
 */
function fakeHome(name: string): string {
  return process.platform === "win32"
    ? join("C:\\Users\\dev", name)
    : join("/home/dev", name);
}

function temporary(prefix: string): string {
  return tempDir(`armadra-${prefix}-`);
}

let release: (() => void) | undefined;

afterEach(() => {
  release?.();
  release = undefined;
});

describe("the integration unit", () => {
  /**
   * The composed revision is what makes hook and skill one switch: a change to
   * either half has to move it, or a stale install reads as current.
   */
  it("carries both halves in the revision", () => {
    expect(INTEGRATION_REVISION).toBe(
      HOOK_CLIENT_REVISION * 100 + SKILLS_REVISION,
    );
    expect(INTEGRATION_REVISION).toBeGreaterThan(SKILLS_REVISION);
  });

  it("gives every built-in provider an adapter path and a mode", () => {
    const home = fakeHome(".config");
    const dataDir = fakeHome(".armadra");
    for (const agentId of AGENT_IDS) {
      const path = adapterPath(agentId, home, dataDir);
      expect(isAbsolute(path), `${agentId}: ${path}`).toBe(true);
      expect(["launch", "file", "extension"]).toContain(injectionMode(agentId));
    }
    expect(() => adapterPath("nope", home, dataDir)).toThrow();
  });

  /**
   * Only claude is injected at launch today, and it is the only one whose
   * adapter must sit outside the CLI's own config home.
   */
  it("keeps the launch-mode provider's adapter out of the user's config home", () => {
    const home = fakeHome(".claude");
    const dataDir = fakeHome(".armadra");
    expect(adapterPath("claude", home, dataDir).startsWith(home)).toBe(false);
    expect(injectionMode("claude")).toBe("launch");
    for (const agentId of ["codex", "copilot", "opencode", "pi", "omp"]) {
      expect(injectionMode(agentId)).not.toBe("launch");
      expect(launchArgs(agentId, dataDir), agentId).toHaveLength(0);
    }
  });

  it("reads an adapter as installed only when the file names our client", () => {
    const home = temporary("adapter");
    const dataDir = temporary("data");
    const options: IntegrationOptions = { dataDir, home };
    expect(state("codex", options).hook.installed).toBe(false);
    writeFileSync(join(home, "hooks.json"), '{"hooks":{}}', "utf8");
    expect(state("codex", options).hook.installed).toBe(false);
    writeFileSync(
      join(home, "hooks.json"),
      '{"command":"/opt/armadra-hook codex"}',
      "utf8",
    );
    expect(state("codex", options).hook.installed).toBe(true);
  });

  it("installs both halves, reports them and takes them back out", () => {
    const home = temporary("copilot-home");
    const dataDir = temporary("data");
    const client = join(dataDir, "armadra-hook");
    writeFileSync(client, "#!/bin/sh\n", "utf8");
    const options: IntegrationOptions = {
      dataDir,
      home,
      env: { ARMADRA_HOOK_BIN: client },
    };

    // The skill half belongs to the collaboration domain; without a writer
    // registered the hook half installs alone and the state says so.
    const before = install("copilot", options);
    expect(before.hook.installed).toBe(true);
    expect(before.skill.installed).toBe(false);
    expect(before.skill.path).toBe(skillFile(home));
    expect(before.installedRevision).toBeUndefined();
    expect(before.clientBin).toBe(client);
    expect(before.mode).toBe("file");

    // With one registered, both halves are there and the unit reads current.
    release = registerSkillInstaller({
      install: (_agentId, configHome) => {
        const path = skillFile(configHome);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(
          path,
          `---\nname: armadra\n---\n\n<!-- armadra:skill-revision ${SKILLS_REVISION} -->\n`,
          "utf8",
        );
        return [path];
      },
      uninstall: (_agentId, configHome) => {
        rmSync(skillFile(configHome), { force: true });
        return [];
      },
    });
    const after = install("copilot", options);
    expect(after.skill.installed).toBe(true);
    expect(after.skill.revision).toBe(SKILLS_REVISION);
    expect(after.installedRevision).toBe(INTEGRATION_REVISION);
    expect(after.stale).toBe(false);

    const removed = uninstall("copilot", options);
    expect(removed.hook.installed).toBe(false);
    expect(removed.skill.installed).toBe(false);
    expect(removed.installedRevision).toBeUndefined();
    expect(existsSync(join(dataDir, "integration", "copilot"))).toBe(false);
  });
});
