import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COPILOT_HOOK_EVENTS,
  OMP_HOOK_EVENTS,
  PI_HOOK_EVENTS,
} from "./events";
import {
  type FromEnv,
  type JsonObject,
  appendManagedGroup,
  configHomeWith,
  hookCommand,
  isManagedCommand,
  readJsonObject,
  stripManagedHandlers,
} from "./shared";

const HOME = "/home/dev";
const none: FromEnv = () => undefined;

describe("the event tables", () => {
  /**
   * The tables here and in packages/shared are the same statement written
   * twice, and the installers read this one. The exclusion is what a test can
   * actually protect: `preToolUse` is fail-closed in Copilot, so an
   * innocent-looking "subscribe everything" edit would make a missing binary
   * refuse every tool call.
   */
  it("holds what each adapter reads, with no event listed twice", () => {
    for (const events of [PI_HOOK_EVENTS, OMP_HOOK_EVENTS, COPILOT_HOOK_EVENTS]) {
      expect(events.length).toBeGreaterThan(0);
      expect(new Set(events).size, "an event is listed twice").toBe(
        events.length,
      );
    }
    expect(PI_HOOK_EVENTS).toContain("agent_settled");
    expect(OMP_HOOK_EVENTS).toContain("agent_settled");
    // The settle event OMP 18.x actually emits. Losing it would leave that
    // fork with no idle evidence.
    expect(OMP_HOOK_EVENTS).toContain("session_stop");
    expect(PI_HOOK_EVENTS).not.toContain("session_stop");
    expect(OMP_HOOK_EVENTS).toContain("auto_compaction_end");
    expect(PI_HOOK_EVENTS).not.toContain("auto_compaction_end");
    expect(COPILOT_HOOK_EVENTS).toContain("agentStop");
    expect(COPILOT_HOOK_EVENTS).not.toContain("preToolUse");
  });
});

describe("recognising and writing a managed command", () => {
  it("calls a command ours when it names the client", () => {
    expect(isManagedCommand("/opt/armadra/armadra-hook claude")).toBe(true);
    expect(isManagedCommand('"/a b/armadra-hook" codex')).toBe(true);
    expect(isManagedCommand("/usr/local/bin/other-hook claude")).toBe(false);
    expect(isManagedCommand("echo hi")).toBe(false);
  });

  it("quotes the command only when the path needs it", () => {
    expect(hookCommand("/opt/armadra/armadra-hook", "claude")).toBe(
      "/opt/armadra/armadra-hook claude",
    );
    expect(
      hookCommand("/Applications/Armadra Desktop/armadra-hook", "codex"),
    ).toBe('"/Applications/Armadra Desktop/armadra-hook" codex');
  });

  it("strips only our handlers and prunes empty groups", () => {
    const events: JsonObject = {
      Stop: [
        {
          hooks: [{ type: "command", command: "/opt/armadra-hook claude" }],
        },
        { matcher: "Bash", hooks: [{ type: "command", command: "mine.sh" }] },
      ],
      PreToolUse: [
        {
          hooks: [
            { type: "command", command: "theirs.sh" },
            { type: "command", command: "/opt/armadra-hook claude" },
          ],
        },
      ],
    };
    expect(stripManagedHandlers(events)).toBe(2);
    const stop = events.Stop as { matcher?: string }[];
    expect(stop).toHaveLength(1);
    expect(stop[0]?.matcher).toBe("Bash");
    const pre = events.PreToolUse as { hooks: { command: string }[] }[];
    expect(pre[0]?.hooks).toHaveLength(1);
    expect(pre[0]?.hooks[0]?.command).toBe("theirs.sh");

    // An event whose only group was ours disappears entirely.
    const onlyOurs: JsonObject = {
      Stop: [{ hooks: [{ type: "command", command: "armadra-hook claude" }] }],
    };
    expect(stripManagedHandlers(onlyOurs)).toBe(1);
    expect(Object.keys(onlyOurs)).toHaveLength(0);
  });

  it("puts our group last when appending", () => {
    const events: JsonObject = {
      Stop: [{ hooks: [{ type: "command", command: "theirs.sh" }] }],
    };
    appendManagedGroup(events, ["Stop", "SessionEnd"], {
      type: "command",
      command: "armadra-hook claude",
    });
    const stop = events.Stop as { hooks: { command: string }[] }[];
    expect(stop).toHaveLength(2);
    expect(stop[0]?.hooks[0]?.command).toBe("theirs.sh");
    expect(stop[1]?.hooks[0]?.command).toBe("armadra-hook claude");
    expect(events.SessionEnd).toHaveLength(1);
  });

  it("never overwrites a corrupt config", () => {
    const directory = mkdtempSync(join(tmpdir(), "armadra-install-"));
    const path = join(directory, "settings.json");
    writeFileSync(path, "{ not json", "utf8");
    expect(() => readJsonObject(path)).toThrow(/not valid JSON/);
    writeFileSync(path, "[]", "utf8");
    expect(() => readJsonObject(path)).toThrow(/not a JSON object/);
    // Missing and empty both mean "start from scratch".
    expect(readJsonObject(join(directory, "nope.json"))).toEqual({});
    writeFileSync(path, "   \n", "utf8");
    expect(readJsonObject(path)).toEqual({});
  });
});

describe("the config home", () => {
  it("follows each CLI's own override", () => {
    expect(configHomeWith("claude", none, HOME)).toBe(join(HOME, ".claude"));
    expect(configHomeWith("codex", none, HOME)).toBe(join(HOME, ".codex"));
    expect(configHomeWith("opencode", none, HOME)).toBe(
      join(HOME, ".config/opencode"),
    );
    expect(configHomeWith("copilot", none, HOME)).toBe(join(HOME, ".copilot"));
    // The extensions directory hangs off the agent dir, not the root.
    expect(configHomeWith("pi", none, HOME)).toBe(join(HOME, ".pi/agent"));
    expect(configHomeWith("omp", none, HOME)).toBe(join(HOME, ".omp/agent"));

    const overridden: FromEnv = (name) =>
      ({
        CLAUDE_CONFIG_DIR: "/tmp/claude-home",
        CODEX_HOME: "/tmp/codex-home",
        XDG_CONFIG_HOME: "/tmp/xdg",
        COPILOT_HOME: "/tmp/copilot-home",
      })[name];
    expect(configHomeWith("claude", overridden, HOME)).toBe("/tmp/claude-home");
    expect(configHomeWith("codex", overridden, HOME)).toBe("/tmp/codex-home");
    // XDG_CONFIG_HOME is a directory of config directories, not opencode's.
    expect(configHomeWith("opencode", overridden, HOME)).toBe(
      "/tmp/xdg/opencode",
    );
    expect(configHomeWith("copilot", overridden, HOME)).toBe(
      "/tmp/copilot-home",
    );
    expect(() => configHomeWith("custom:x", none, HOME)).toThrow();
  });

  /**
   * Pi and OMP read the *same* agent-dir override, and OMP layers a profile
   * and a configurable root name on top of it. Getting the precedence wrong
   * writes an extension into a directory the CLI never scans, which looks
   * exactly like a successful install and reports nothing.
   */
  it("follows the shared Pi override and OMP's profiles", () => {
    const agentDir: FromEnv = (name) =>
      name === "PI_CODING_AGENT_DIR" ? "/tmp/pi-agent" : undefined;
    expect(configHomeWith("pi", agentDir, HOME)).toBe("/tmp/pi-agent");
    expect(configHomeWith("omp", agentDir, HOME)).toBe("/tmp/pi-agent");

    // A profile wins over the agent-dir override, exactly as OMP resolves it.
    const profile: FromEnv = (name) =>
      ({ PI_CODING_AGENT_DIR: "/tmp/pi-agent", OMP_PROFILE: "work" })[name];
    expect(configHomeWith("omp", profile, HOME)).toBe(
      join(HOME, ".omp/profiles/work/agent"),
    );
    // Pi has no profiles; it keeps reading the override.
    expect(configHomeWith("pi", profile, HOME)).toBe("/tmp/pi-agent");

    // A renamed root, and a profile name that could escape the config home.
    const renamed: FromEnv = (name) =>
      name === "PI_CONFIG_DIR" ? ".omp-alt" : undefined;
    expect(configHomeWith("omp", renamed, HOME)).toBe(
      join(HOME, ".omp-alt/agent"),
    );
    for (const hostile of ["../../etc", "a/b", "", "default"]) {
      const escaping: FromEnv = (name) =>
        name === "OMP_PROFILE" ? hostile : undefined;
      expect(configHomeWith("omp", escaping, HOME), hostile).toBe(
        join(HOME, ".omp/agent"),
      );
    }
    const escapingRoot: FromEnv = (name) =>
      name === "PI_CONFIG_DIR" ? "../elsewhere" : undefined;
    expect(configHomeWith("omp", escapingRoot, HOME)).toBe(
      join(HOME, ".omp/agent"),
    );
  });
});
