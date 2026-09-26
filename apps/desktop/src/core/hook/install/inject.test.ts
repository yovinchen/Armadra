import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installCollaborationSkill } from "../../collab/skill";
import { configPath as codexConfigPath } from "./codex";
import { CLAUDE_HOOK_EVENTS, COPILOT_HOOK_EVENTS } from "./events";
import {
  CODEX_HOOK_VAR,
  CODEX_INSTRUCTIONS_VAR,
  CODEX_SESSION_KEY_PREFIX,
  INJECTED_AGENTS,
  artifactLayout,
  canvasInjection,
  codexSessionTrust,
  codexTrusted,
  prepareInjection,
  removeInjection,
  shellWord,
} from "./inject";
import { stateKeys } from "./toml-state";
import { tempDir } from "../../testing/temp-dir";

/**
 * The canvas injection: what each CLI is handed, and what is written for it.
 *
 * The argv shapes are the ones measured against the real CLIs on 2026-09-26
 * (docs/design/canvas-only-integration.md §3). They are asserted literally,
 * because a flag spelled differently is a CLI that silently starts without
 * our hooks.
 */

let dataDir: string;
let codexHome: string;
let env: NodeJS.ProcessEnv;
let hookBin: string;
let release: (() => void) | undefined;

beforeEach(() => {
  const root = tempDir("armadra-inject-");
  dataDir = join(root, "data");
  codexHome = join(root, "codex");
  hookBin = join(root, "bin", "armadra-hook");
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(hookBin, "#!/bin/sh\n", "utf8");
  env = {
    ...process.env,
    ARMADRA_HOOK_BIN: hookBin,
    CODEX_HOME: codexHome,
    ARMADRA_NO_GLOBAL_WRITES: "",
  };
  release = installCollaborationSkill();
});

afterEach(() => {
  release?.();
  release = undefined;
});

function prepare(agentId: string) {
  return prepareInjection(agentId, { dataDir, env, codexHome });
}

function inject(agentId: string, resume = false) {
  return canvasInjection({ dataDir, agentId, nodeId: "node-1", resume });
}

describe("canvas injection", () => {
  it("hands nothing over before the artifacts exist", () => {
    for (const agentId of INJECTED_AGENTS) {
      expect(inject(agentId), agentId).toEqual({
        args: [],
        words: [],
        env: [],
      });
    }
    expect(inject("custom:unknown")).toEqual({ args: [], words: [], env: [] });
  });

  it("writes everything under the data directory, byte-identical twice", () => {
    for (const agentId of INJECTED_AGENTS) {
      const first = prepare(agentId);
      expect(first.written.length, agentId).toBeGreaterThan(0);
      for (const path of first.written) {
        expect(path.startsWith(join(dataDir, "integration", agentId))).toBe(
          true,
        );
      }
      const layout = artifactLayout(dataDir, agentId);
      const skill = readFileSync(layout.skill, "utf8");
      const again = prepareInjection(agentId, {
        dataDir,
        env,
        codexHome,
        force: true,
      });
      expect(again.written, agentId).toEqual([]);
      expect(readFileSync(layout.skill, "utf8")).toBe(skill);
    }
  });

  it("gives Claude its settings, its plugin and the instructions", () => {
    prepare("claude");
    const layout = artifactLayout(dataDir, "claude");
    const { args, env: vars } = inject("claude");
    expect(args).toEqual([
      "--settings",
      layout.settings,
      "--plugin-dir",
      layout.pluginDir,
      "--append-system-prompt-file",
      layout.instructions,
    ]);
    expect(vars).toEqual([]);
    const settings = JSON.parse(
      readFileSync(layout.settings as string, "utf8"),
    ) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(Object.keys(settings.hooks)).toEqual([...CLAUDE_HOOK_EVENTS]);
    expect(settings.hooks.Stop?.[0]?.hooks[0]?.command).toBe(
      `${hookBin} claude`,
    );
    const manifest = JSON.parse(
      readFileSync(layout.manifest as string, "utf8"),
    ) as { name: string };
    expect(manifest.name).toBe("armadra");
    expect(layout.skill).toBe(
      join(layout.pluginDir as string, "skills", "armadra", "SKILL.md"),
    );
  });

  it("gives Codex its hooks, its instructions and no update prompt", () => {
    prepare("codex");
    const layout = artifactLayout(dataDir, "codex");
    const { args, words, env: vars } = inject("codex");
    const pairs = args.filter((_, index) => index % 2 === 1);
    expect(
      args.filter((_, index) => index % 2 === 0).every((a) => a === "-c"),
    ).toBe(true);
    expect(pairs[0]).toBe("check_for_update_on_startup=false");
    expect(pairs).toContain(
      `hooks.SessionStart=[{hooks=[{type="command",command=${JSON.stringify(`${hookBin} codex`)}}]}]`,
    );
    // Codex has no Notification event; it is not passed.
    expect(pairs.some((pair) => pair.startsWith("hooks.Notification"))).toBe(
      false,
    );
    const instructions = pairs.find((pair) =>
      pair.startsWith("developer_instructions="),
    ) as string;
    const text = JSON.parse(
      instructions.slice("developer_instructions=".length),
    ) as string;
    expect(text).toContain("canvas open-agent");
    expect(text).toContain(layout.skill);
    expect(existsSync(layout.skill)).toBe(true);

    // Typed, the long values stay in the terminal's environment: the line only
    // names them, and stays short enough for a fresh shell to take whole.
    expect(vars).toEqual([
      [
        CODEX_HOOK_VAR,
        `[{hooks=[{type="command",command=${JSON.stringify(`${hookBin} codex`)}}]}]`,
      ],
      [CODEX_INSTRUCTIONS_VAR, JSON.stringify(text)],
    ]);
    expect(words).toContain(`"hooks.SessionStart=$${CODEX_HOOK_VAR}"`);
    expect(words).toContain(
      `"developer_instructions=$${CODEX_INSTRUCTIONS_VAR}"`,
    );
    expect(words.join(" ").length).toBeLessThan(600);
  });

  it("types every other CLI's argv as quoted words", () => {
    for (const agentId of ["claude", "opencode", "pi", "omp", "copilot"]) {
      prepare(agentId);
      const { args, words } = inject(agentId);
      expect(words.length, agentId).toBe(args.length);
      for (const [index, word] of words.entries()) {
        const arg = args[index] as string;
        expect(word === arg || word === `'${arg}'`, agentId).toBe(true);
      }
    }
  });

  it("gives OpenCode a fixed config directory and the instructions by env", () => {
    prepare("opencode");
    const layout = artifactLayout(dataDir, "opencode");
    const { args, env: vars } = inject("opencode");
    expect(args).toEqual([]);
    expect(vars).toEqual([
      ["OPENCODE_CONFIG_DIR", layout.configDir],
      [
        "OPENCODE_CONFIG_CONTENT",
        JSON.stringify({ instructions: [layout.instructions] }),
      ],
    ]);
    expect(existsSync(join(layout.configDir as string, "plugins"))).toBe(true);
    expect(existsSync(layout.skill)).toBe(true);
  });

  it("gives Pi its extension, its skill and the instructions", () => {
    prepare("pi");
    const layout = artifactLayout(dataDir, "pi");
    expect(inject("pi")).toMatchObject({
      args: [
        "--extension",
        layout.module,
        "--skill",
        layout.skillDir,
        "--append-system-prompt",
        layout.instructions,
      ],
      env: [],
    });
  });

  it("gives OMP the `=` forms and a skills overlay", () => {
    prepare("omp");
    const layout = artifactLayout(dataDir, "omp");
    expect(inject("omp")).toMatchObject({
      args: [
        `--extension=${layout.module}`,
        `--config=${layout.overlay}`,
        `--append-system-prompt=${layout.instructions}`,
      ],
      env: [],
    });
    expect(readFileSync(layout.overlay as string, "utf8")).toContain(
      "customDirectories",
    );
  });

  it("gives Copilot a plugin with hooks and skills, instructions by env", () => {
    prepare("copilot");
    const layout = artifactLayout(dataDir, "copilot");
    expect(inject("copilot")).toMatchObject({
      args: ["--plugin-dir", layout.pluginDir],
      env: [["COPILOT_CUSTOM_INSTRUCTIONS_DIRS", layout.instructionsDir]],
    });
    const manifest = JSON.parse(
      readFileSync(layout.manifest as string, "utf8"),
    ) as Record<string, string>;
    expect(manifest.hooks).toBe("hooks.json");
    expect(manifest.skills).toBe("skills/");
    const hooks = JSON.parse(
      readFileSync(layout.pluginHooks as string, "utf8"),
    ) as { version: number; hooks: Record<string, { bash: string }[]> };
    expect(hooks.version).toBe(1);
    expect(Object.keys(hooks.hooks)).toEqual([...COPILOT_HOOK_EVENTS]);
    // The blocking event stays out.
    expect(hooks.hooks.preToolUse).toBeUndefined();
    expect(readFileSync(layout.instructions as string, "utf8")).toMatch(
      /^---\napplyTo: "\*\*"\n---/,
    );
  });

  /** Measured: every CLI needs the same argv again when it resumes. */
  it("hands a resumed session exactly what a new one gets", () => {
    for (const agentId of INJECTED_AGENTS) {
      prepare(agentId);
      expect(inject(agentId, true), agentId).toEqual(inject(agentId, false));
      expect(
        inject(agentId, true).args.length + inject(agentId).env.length,
      ).toBeGreaterThan(0);
    }
  });

  it("regenerates when the revision on disk is not this one", () => {
    prepare("pi");
    const layout = artifactLayout(dataDir, "pi");
    writeFileSync(
      layout.marker,
      JSON.stringify({ revision: 1, clientBin: hookBin, writtenAt: "" }),
      "utf8",
    );
    writeFileSync(layout.module as string, "stale", "utf8");
    prepare("pi");
    expect(readFileSync(layout.module as string, "utf8")).not.toBe("stale");
  });
});

describe("Codex's trust records", () => {
  it("writes one record per session-flag hook, once", () => {
    const first = prepare("codex");
    expect(first.trust?.changed).toBe(true);
    const config = readFileSync(codexConfigPath(codexHome), "utf8");
    const keys = stateKeys(config);
    expect(keys.length).toBe(codexSessionTrust(`${hookBin} codex`).length);
    for (const key of keys) {
      expect(key.startsWith(CODEX_SESSION_KEY_PREFIX)).toBe(true);
      expect(key.endsWith(":0:0")).toBe(true);
    }
    expect(codexTrusted(codexHome, `${hookBin} codex`)).toBe(true);
    const before = statSync(codexConfigPath(codexHome)).mtimeMs;
    expect(prepare("codex").trust?.changed).toBe(false);
    expect(statSync(codexConfigPath(codexHome)).mtimeMs).toBe(before);
  });

  it("keeps the rest of config.toml and takes only ours back out", () => {
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      codexConfigPath(codexHome),
      '# mine\nmodel = "gpt-5"\n\n[hooks.state."/home/me/.codex/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:theirs"\n',
      "utf8",
    );
    prepare("codex");
    removeInjection("codex", { dataDir, env, codexHome });
    const config = readFileSync(codexConfigPath(codexHome), "utf8");
    expect(config).toContain("# mine");
    expect(config).toContain("/home/me/.codex/hooks.json:stop:0:0");
    expect(config).not.toContain(CODEX_SESSION_KEY_PREFIX);
    expect(existsSync(artifactLayout(dataDir, "codex").dir)).toBe(false);
  });

  it("writes nothing global when global writes are switched off", () => {
    const report = prepareInjection("codex", {
      dataDir,
      env: { ...env, ARMADRA_NO_GLOBAL_WRITES: "1" },
      codexHome,
    });
    expect(report.trust).toBeUndefined();
    expect(existsSync(codexConfigPath(codexHome))).toBe(false);
  });

  it("refuses a config.toml it would mangle", () => {
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(codexConfigPath(codexHome), "this is [not toml\n", "utf8");
    expect(() => prepare("codex")).toThrow(/not valid TOML/);
  });
});

/**
 * 启动行是敲进节点终端的；Windows 上那个 shell 默认是 `cmd.exe`，它不认单引号。
 */
describe("typed launch words", () => {
  it("quotes for a POSIX shell only where needed", () => {
    expect(shellWord("/d/settings.json", "linux")).toBe("/d/settings.json");
    expect(shellWord("a b", "darwin")).toBe("'a b'");
    expect(shellWord("it's", "linux")).toBe("'it'\\''s'");
  });

  it("leaves a Windows path bare and double-quotes the rest", () => {
    expect(
      shellWord("C:\\Users\\RUNNER~1\\AppData\\settings.json", "win32"),
    ).toBe("C:\\Users\\RUNNER~1\\AppData\\settings.json");
    expect(shellWord("C:\\Users\\Ada Bell\\s.json", "win32")).toBe(
      '"C:\\Users\\Ada Bell\\s.json"',
    );
    expect(shellWord('say "hi"', "win32")).toBe('"say ""hi"""');
  });
});
